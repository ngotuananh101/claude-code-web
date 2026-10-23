import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ackUpTo,
  attemptState,
  beginAttempt,
  lockHolder,
  migrateRunnerDb,
} from "@cc-web/runner-db";
import { executeRun, type SdkOptions, type SdkStream } from "./executor.ts";

/**
 * Running one attempt (§10.1, §12.2).
 *
 * The executor sits between the inbox and the SDK. The SDK is injected as a
 * function that returns a stream, so every test here drives the whole lifecycle
 * — lock, attempt row, events, terminal outcome, lock release — without a model
 * call and without loading the real SDK module.
 *
 * What this proves, and what it does not: that a first acceptance turns into a
 * complete, durable run. It does not prove transport, resume semantics against
 * the real CLI, or delivery of the events anywhere.
 */

function setup(): { db: Database } {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return { db };
}

/**
 * A stream that fails on its first read.
 *
 * An async iterator rather than a generator: a `function*` body that only
 * throws has no `yield`, and the lint rule that flags that is right — the
 * failure belongs in `next()`, where the consumer actually observes it.
 */
function failingStream(error: Error): SdkStream {
  return () => ({
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(error) };
    },
  });
}

const COMMAND = {
  protocolVersion: 1,
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start",
  issuedAt: "2026-10-23T00:00:00.000Z",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  payload: { prompt: "hello" },
};

/** The workspace id maps to a canonical path the operator registered. */
const WORKSPACES = new Map([["workspace-1", "/home/runner/project"]]);

function events(db: Database) {
  return db
    .prepare("SELECT local_sequence, type, payload FROM event_outbox ORDER BY local_sequence")
    .all() as Array<{ local_sequence: number; type: string; payload: string }>;
}

describe("a clean run", () => {
  test("records the attempt, appends events, and finishes", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1", model: "m" };
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        yield { type: "result", subtype: "success", result: "hi", usage: { input_tokens: 1 } };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(outcome.state).toBe("finished");
    expect(outcome.sdkSessionId).toBe("sdk-1");

    // §10.1 order: the attempt was recorded (by the caller), events are
    // contiguous, and the terminal event is last.
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual([
      "run.started",
      "session.updated",
      "message.completed",
      "run.finished",
    ]);
    expect(list.map((e) => e.local_sequence)).toEqual([1, 2, 3, 4]);
  });

  test("a message that cannot be persisted does not burn a sequence number", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // A BigInt is not JSON-serializable, so persisting this frame throws for a
    // reason unrelated to a duplicate sequence. The run still has to fail
    // cleanly — and the sequence counter must not advance past a row that was
    // never written, or every later event sits behind a hole the ACK watermark
    // can never cross (§12.2).
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "assistant", message: { n: 1n } };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(outcome.state).toBe("failed");
    const sequences = events(db).map((e) => e.local_sequence);
    // 1 = run.started, 2 = run.failed. Nothing skipped.
    expect(sequences).toEqual([1, 2]);
    expect(ackUpTo(db, { attemptId: "attempt-1", sequence: 2 }).ackedThrough).toBe(2);
  });

  test("a partial-message stream does not write one row per token", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The shape `includePartialMessages: true` produces: a `stream_event` per
    // delta, then the complete assistant message. §12.3 makes the adapter
    // accumulate deltas and finalize — the transcript is built from complete
    // messages, and the deltas are for live display, not for the durable outbox.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1" };
        for (let i = 0; i < 50; i++) {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "tok" },
            },
            session_id: "sdk-1",
          };
        }
        yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
        yield { type: "result", subtype: "success", result: "done" };
      })();

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    // A row per delta would be 50 rows of disk, a row per 20 bytes of text, and
    // a replay the browser has to reassemble. The complete message carries the
    // same content.
    const types = events(db).map((e) => e.type);
    expect(types.filter((t) => t === "run.status")).toHaveLength(0);
    expect(types).toEqual(["run.started", "session.updated", "message.completed", "run.finished"]);
  });
});

describe("a failing run", () => {
  test("an error result frame makes the attempt failed, not finished", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // §22.2: the SDK reports a non-success outcome as a `result` frame, not as a
    // thrown error. The stream ends normally, so nothing reaches the catch — and
    // the attempt must still be `failed`, because that is what the event says.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1" };
        yield { type: "result", subtype: "error_max_turns", is_error: true };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const terminal = events(db).find((e) => e.type === "run.finished" || e.type === "run.failed");
    expect(terminal?.type).toBe("run.failed");
    expect(outcome.state).toBe("failed");
    // The row is what reconciliation reports to the server.
    expect(attemptState(db, "attempt-1")).toBe("failed");
  });

  test("a success-subtype result carrying is_error is a failure, not a finish", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The SDK's own docs: `subtype: "success"` carries the final assistant text
    // — "or, with is_error true, the error text when the turn ended on an API
    // error". So the subtype alone does not say the turn succeeded. Reading only
    // `subtype` reports an API failure as a finished run, and the attempt row,
    // the journal and the browser all inherit that.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1" };
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "API error: overloaded_error",
        };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const terminal = events(db).find((e) => e.type === "run.finished" || e.type === "run.failed");
    expect(terminal?.type).toBe("run.failed");
    expect(outcome.state).toBe("failed");
    expect(attemptState(db, "attempt-1")).toBe("failed");
  });

  test("records the failure and frees the workspace", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1" };
        throw new Error("the model refused the request");
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(outcome.state).toBe("failed");
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual(["run.started", "session.updated", "run.failed"]);
    // The lock is released even on the failure path: a stuck lock blocks the
    // workspace for every later run.
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("the failure payload carries the error but no credential", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk = failingStream(new Error("boom"));

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const failure = events(db).find((e) => e.type === "run.failed");
    expect(failure?.payload).toContain("boom");
    expect(failure?.payload).not.toContain("ANTHROPIC");
  });

  test("a thrown error quoting a provider key is redacted before it is persisted", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The shape that matters: a CLI failure that echoes the environment it was
    // given. §19.4 makes this a boundary — the key must never reach the journal
    // or the browser, both of which read this row.
    const sdk = failingStream(
      new Error("CLI exited 1: ANTHROPIC_API_KEY=sk-ant-api03-RealLookingKey123 was rejected"),
    );

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    const failure = events(db).find((e) => e.type === "run.failed");
    expect(failure?.payload).not.toContain("sk-ant-api03-RealLookingKey123");
    // The actionable part survives: an operator still learns what failed.
    expect(failure?.payload).toContain("CLI exited 1");
  });

  test("an SDK seam that throws on the first call is still a failed run", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // Loading the SDK or building the stream can fail before there is anything
    // to iterate — a missing binary, a bad option. §10.1 makes the attempt
    // terminal and the lock released whatever happened, so these must not
    // escape.
    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: () => {
        throw new Error("the SDK could not be loaded");
      },
    });

    expect(outcome.state).toBe("failed");
    expect(attemptState(db, "attempt-1")).toBe("failed");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();

    const failure = events(db).find((e) => e.type === "run.failed");
    expect(failure?.payload).toContain("the SDK could not be loaded");
  });

  test("a terminal event is written once, even when the stream ends badly", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The SDK yields its result frame and *then* the transport dies. Both
    // paths want to write a terminal event; only one may.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
        throw new Error("socket closed after the result");
      })();

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const terminals = events(db).filter(
      (e) => e.type === "run.finished" || e.type === "run.failed",
    );
    expect(terminals).toHaveLength(1);
  });

  test("the attempt agrees with the terminal event it already wrote", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The stream produced its result — the run finished — and then the transport
    // died. A late throw cannot un-finish a run that already reported success.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
        throw new Error("socket closed after the result");
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    // The row and the outbox must not disagree: reconciliation reads the row,
    // the browser reads the events, and two answers for one run is a bug
    // whichever one is right.
    const terminal = events(db).find((e) => e.type === "run.finished" || e.type === "run.failed");
    expect(terminal?.type).toBe("run.finished");
    expect(outcome.state).toBe("finished");
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("the run.started append cannot escape the lock release", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    // Sequence 1 is already taken, so `run.started` cannot be written. A real
    // cause is a database error or a second writer; the point is that the write
    // is the first thing after the lock check and it can fail.
    db.prepare(
      `INSERT INTO event_outbox
         (event_id, attempt_id, local_sequence, session_id, run_id, type, payload,
          occurred_at, created_at, acknowledged)
       VALUES ('other', 'attempt-1', 1, 'session-1', 'run-1', 'x', '{}', 'x', 0, 0)`,
    ).run();

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: () => (async function* () {})(),
    }).catch(() => undefined);

    // Whatever went wrong, the workspace must not stay locked: §10.1 makes the
    // release unconditional, and a failed append is exactly the case where
    // nobody will come back to do it.
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
    expect(attemptState(db, "attempt-1")).toBe("failed");
  });
});

describe("the workspace lock", () => {
  test("a run on a workspace held by another attempt does not start", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-0",
      sessionId: "session-0",
      runId: "run-0",
      workspacePath: "/home/runner/project",
    });

    let reached = false;
    const sdk: SdkStream = () => {
      reached = true;
      throw new Error("the SDK must not be reached");
    };

    const result = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(result.state).toBe("failed");
    // §11.4: the model must not edit files the other attempt owns.
    expect(reached).toBe(false);
    // The other attempt still owns the workspace.
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-0");
  });

  test("the refusal event does not name the attempt that holds the workspace", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-0",
      sessionId: "session-0",
      runId: "run-0",
      workspacePath: "/home/runner/project",
    });

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: () => {
        throw new Error("the SDK must not be reached");
      },
    });

    // The event outbox is replayed to the browser and copied into the server
    // journal (§12.3), so its payload is a public document. Another attempt's
    // id is runner-internal bookkeeping: a browser viewer cannot act on it, and
    // publishing it hands a spectator a stable handle on a run they were never
    // shown. The reason itself is what an operator needs — it says the
    // workspace is busy, which is all the UI can render.
    const refusal = events(db).find((e) => e.type === "run.failed");
    expect(refusal).toBeDefined();
    expect(refusal!.payload).not.toContain("attempt-0");
    expect(JSON.parse(refusal!.payload)).toEqual({ error: "workspace_locked" });
  });

  test("the refusing attempt's own lock is released, not left behind", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-0",
      sessionId: "session-0",
      runId: "run-0",
      workspacePath: "/home/runner/project",
    });
    // This attempt was begun against a different path — the shape a resolved
    // symlink or a re-registered workspace produces — and execution is then
    // pointed at the locked one. Defensive, because beginAttempt normally
    // refuses first.
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/other",
    });

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: () => {
        throw new Error("the SDK must not be reached");
      },
    });

    // The early return is still a path, and §10.1's guarantee is that the lock
    // outlives nothing. Leaving it means a terminal attempt holds a workspace
    // that nothing will ever release.
    expect(lockHolder(db, "/home/runner/other")).toBeUndefined();
    expect(attemptState(db, "attempt-1")).toBe("failed");
    // The other attempt's lock is still its own.
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-0");
  });
});

describe("the SDK session id", () => {
  test("is captured from the init frame, not from the command", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-session-xyz" };
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(outcome.sdkSessionId).toBe("sdk-session-xyz");
  });

  test("is stored on the attempt so the next run can resume it", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-session-xyz" };
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const row = db
      .prepare("SELECT sdk_session_id FROM local_attempts WHERE attempt_id = ?")
      .get("attempt-1") as { sdk_session_id: string | null };
    expect(row.sdk_session_id).toBe("sdk-session-xyz");
  });

  test("a resumed run is given the previous session id", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-2",
      sessionId: "session-1",
      runId: "run-2",
      workspacePath: "/home/runner/project",
    });
    db.prepare("UPDATE local_attempts SET sdk_session_id = ? WHERE attempt_id = ?").run(
      "sdk-previous",
      "attempt-2",
    );

    let seen: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      seen = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(
      db,
      { ...COMMAND, attemptId: "attempt-2", runId: "run-2" },
      {
        workspacePath: WORKSPACES.get("workspace-1")!,
        sdk,
      },
    );

    // §10.4: resume by explicit id, never `continue: true`, which would pick
    // whatever conversation happened to be newest.
    expect(seen?.resume).toBe("sdk-previous");
  });

  test("a new run is not given a resume id at all", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let seen: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      seen = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    expect(seen?.resume).toBeUndefined();
  });
});

describe("redaction", () => {
  test("no persisted payload names the credential source", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-1",
          apiKeySource: "ANTHROPIC_API_KEY",
        };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.42 };
      })();

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    });

    const payloads = events(db)
      .map((e) => e.payload)
      .join("\n");
    expect(payloads).not.toContain("apiKeySource");
    expect(payloads).not.toContain("total_cost_usd");
  });
});
