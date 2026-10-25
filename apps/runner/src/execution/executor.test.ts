import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ackUpTo,
  attemptState,
  beginAttempt,
  lockHolder,
  migrateRunnerDb,
} from "@cc-web/runner-db";
import { ApprovalRouter } from "./approvals.ts";
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

  test("the streaming contract: delta ids and the completed payload name the same message", async () => {
    // §12.3/§12.4 seam, pinned end to end: the normalizer derives messageId
    // from message_start, and the executor persists the redacted assistant
    // frame whose id sits at payload.message.id. If these drift apart, the
    // browser's derivation never closes the streaming entry on real runs —
    // the fixture-shaped tests on either side would both still pass.
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
        yield {
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_X" } },
          session_id: "sdk-1",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
          session_id: "sdk-1",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
          session_id: "sdk-1",
        };
        yield {
          type: "assistant",
          message: { id: "msg_X", content: [{ type: "text", text: "Hello" }] },
        };
        yield { type: "result", subtype: "success", result: "Hello" };
      })();

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    const list = events(db);
    expect(list.map((e) => e.type)).toEqual([
      "run.started",
      "session.updated",
      "message.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.finished",
    ]);

    const started = JSON.parse(list[2]!.payload) as { messageId?: string };
    expect(started.messageId).toBe("msg_X");
    for (const delta of [list[3]!, list[4]!]) {
      const payload = JSON.parse(delta.payload) as { messageId?: string; text?: string };
      expect(payload.messageId).toBe("msg_X");
      expect(typeof payload.text).toBe("string");
    }
    const completed = JSON.parse(list[5]!.payload) as {
      message?: { id?: string };
      id?: string;
    };
    // The correlation the browser derivation depends on: the completed
    // frame's id equals the messageId the started/delta events carried.
    expect(completed.message?.id).toBe("msg_X");
    expect(completed.id).toBeUndefined();
  });

  test("the tool contract: block starts and tool_result frames name the same call", async () => {
    // §12.3/§12.4 seam: tool.started comes from the raw stream (the model
    // emitting a tool_use block), tool.completed from the user frame the CLI
    // sends when the tool returned. The ids must correlate, and the pure
    // tool_result frame must replace the generic run.status row it used to
    // land as — the assistant frame must not disturb either.
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const toolUse = { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "echo hi" } };
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-1" };
        yield {
          type: "stream_event",
          event: { type: "content_block_start", index: 1, content_block: toolUse },
          session_id: "sdk-1",
        };
        yield { type: "assistant", message: { id: "msg_1", content: [toolUse] } };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "hi", is_error: false }],
          },
        };
        yield { type: "result", subtype: "success", result: "hi" };
      })();

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    const list = events(db);
    expect(list.map((e) => e.type)).toEqual([
      "run.started",
      "session.updated",
      "tool.started",
      "message.completed",
      "tool.completed",
      "run.finished",
    ]);

    const started = JSON.parse(list[2]!.payload) as { toolCallId?: string; toolName?: string };
    expect(started.toolCallId).toBe("toolu-1");
    expect(started.toolName).toBe("Bash");
    const completion = JSON.parse(list[4]!.payload) as {
      toolCallId?: string;
      isError?: boolean;
      outputSummary?: string;
    };
    expect(completion.toolCallId).toBe("toolu-1");
    expect(completion.isError).toBe(false);
    expect(completion.outputSummary).toBe("hi");
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

  test("a terminal write that fails still releases the workspace", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const sdk: SdkStream = () =>
      (async function* () {
        // The terminal write fails the way a busy timeout or an I/O error would.
        // The release that follows it would still succeed — the question is
        // whether it is reached. It is the last statement of the last function
        // that touches this workspace, so skipping it blocks every later run
        // until the process restarts.
        db.exec(
          `CREATE TRIGGER refuse_terminal BEFORE UPDATE ON local_attempts
           BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
        );
        yield { type: "result", subtype: "success" };
      })();

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
    }).catch(() => undefined);

    // The row may remain `starting` — the write did fail — and boot recovery
    // will reconcile that. The lock is different: nothing else can free it, and
    // the workspace is unusable for as long as this process lives.
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
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

  test("a refused run frees its own lock even when the terminal write fails", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-0",
      sessionId: "session-0",
      runId: "run-0",
      workspacePath: "/home/runner/project",
    });
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/other",
    });
    db.exec(
      `CREATE TRIGGER refuse_terminal BEFORE UPDATE ON local_attempts
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );

    await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: () => {
        throw new Error("the SDK must not be reached");
      },
    }).catch(() => undefined);

    // The refusal path has its own release, and it needs the same guard: a
    // failed write here would otherwise leave the refusing attempt holding a
    // workspace nothing releases.
    expect(lockHolder(db, "/home/runner/other")).toBeUndefined();
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-0");
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

describe("an aborted run", () => {
  test("a stream that throws when its abort signal fires is interrupted, not failed", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The shape the real SDK produces on abort (verified against 0.3.309): the
    // stream throws an `Error` whose `name` is `"Error"` — the SDK's AbortError
    // subclass sets no name, so nothing about the thrown object identifies the
    // abort. The runner's own signal is the only reliable witness: it fired, and
    // only this process fires it.
    const controller = new AbortController();
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
        await new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Operation aborted")),
            {
              once: true,
            },
          );
        });
      })();

    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      signal: controller.signal,
    });
    await Bun.sleep(10);
    controller.abort();

    const outcome = await run;

    // §14.2/§9.7: a run stopped without an observed SDK outcome is interrupted.
    // Recording it as failed would make a deliberate cancel indistinguishable
    // from a broken run, and §14.4 keeps those outcomes apart on purpose.
    expect(outcome.state).toBe("interrupted");
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();

    const list = events(db);
    expect(list.map((e) => e.type)).toEqual([
      "run.started",
      "message.completed",
      "run.interrupted",
    ]);
    // The payload is a constant, not the thrown error's text: the abort error
    // carries nothing an operator can act on, and a redacted non-secret is still
    // noise next to a fact the reader already has.
    const interrupted = list.find((e) => e.type === "run.interrupted");
    expect(interrupted && JSON.parse(interrupted.payload)).toEqual({ reason: "aborted" });
  });

  test("an abort that loses the race to a terminal result keeps the real outcome", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // §14.2: the run may really have finished before the cancel arrived. The
    // observed outcome wins; a late abort must not rewrite history.
    const controller = new AbortController();
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
        await new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Operation aborted")),
            {
              once: true,
            },
          );
        });
      })();

    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      signal: controller.signal,
    });
    await Bun.sleep(10);
    controller.abort();

    const outcome = await run;

    expect(outcome.state).toBe("finished");
    expect(attemptState(db, "attempt-1")).toBe("finished");
    const types = events(db).map((e) => e.type);
    expect(types).toEqual(["run.started", "run.finished"]);
    expect(types).not.toContain("run.interrupted");
  });

  test("a stream that ends silently after the abort is still interrupted", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // The other legal teardown shape: the abort unblocks the pending read and
    // the iterator returns instead of throwing. The loop then ends normally with
    // no result frame — an outcome the catch never sees. Without a check after
    // the loop, this run would be recorded as `finished` with no terminal event.
    const controller = new AbortController();
    const sdk: SdkStream = () =>
      (async function* () {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })();

    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      signal: controller.signal,
    });
    await Bun.sleep(10);
    controller.abort();

    const outcome = await run;

    expect(outcome.state).toBe("interrupted");
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    expect(events(db).map((e) => e.type)).toEqual(["run.started", "run.interrupted"]);
  });

  test("a throw without an abort signal is still an ordinary failure", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: failingStream(new Error("the model refused the request")),
    });

    // No signal, no cancellation: the same throw as before the abort path
    // existed. Classification must not drift for runs that were never aborted.
    expect(outcome.state).toBe("failed");
    expect(attemptState(db, "attempt-1")).toBe("failed");
  });
});

describe("the permission mode", () => {
  test("forwards the run's permissionMode into the SDK options", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let captured: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", permissionMode: "bypassPermissions" } },
      {
        workspacePath: WORKSPACES.get("workspace-1")!,
        sdk,
      },
    );

    expect(captured?.permissionMode).toBe("bypassPermissions");
  });

  test("a payload without one runs under 'default'", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let captured: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    expect(captured?.permissionMode).toBe("default");
  });
});

describe("the model", () => {
  test("forwards the run's model into the SDK options", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let captured: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", model: "opus" } },
      {
        workspacePath: WORKSPACES.get("workspace-1")!,
        sdk,
      },
    );

    expect(captured?.model).toBe("opus");
  });

  test("a payload without one leaves the SDK option unset", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let captured: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    // Unlike permissionMode there is no runner-side default: the SDK's own
    // model choice is what "not specified" means, so the option is omitted.
    expect(captured?.model).toBeUndefined();
  });

  test("an empty model is as absent", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let captured: SdkOptions | undefined;
    const sdk: SdkStream = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", model: "" } },
      { workspacePath: WORKSPACES.get("workspace-1")!, sdk },
    );

    // Unreachable through the route (its strict set refuses ""), but the
    // runner-side parse still honors the plan's non-empty contract.
    expect(captured?.model).toBeUndefined();
  });
});

describe("the approval gate", () => {
  test("a canUseTool call suspends the run as approval.requested and resolves from the router", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let router: ApprovalRouter | undefined;
    const flushed: number[] = [];
    const sdk: SdkStream = (options) =>
      (async function* () {
        await options.canUseTool!(
          "Bash",
          { command: "ls" },
          {
            signal: new AbortController().signal,
          },
        );
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      router: (append) => {
        router = new ApprovalRouter({ db, append });
        return router;
      },
      onApprovalEvent: () => flushed.push(1),
    });

    await Bun.sleep(10);

    // The gate parked the SDK callback and announced it through the same
    // sequenced append as every other event — with the flush trigger, because
    // a suspended run never settles on its own (§13).
    const requested = events(db).filter((e) => e.type === "approval.requested");
    expect(requested).toHaveLength(1);
    const payload = JSON.parse(requested[0]!.payload) as Record<string, unknown>;
    expect(payload.attemptId).toBe("attempt-1");
    expect(payload.runId).toBe("run-1");
    expect(payload.kind).toBe("tool_permission");
    expect(payload.toolName).toBe("Bash");
    expect(payload.callbackGeneration).toBe(0);
    expect(flushed.length).toBeGreaterThanOrEqual(1);

    router!.respond(
      {
        approvalId: String(payload.approvalId),
        decision: "allow",
        inputHash: payload.inputHash,
      },
      { attemptId: "attempt-1", runId: "run-1" },
    );

    const outcome = await run;
    expect(outcome.state).toBe("finished");
    expect(events(db).map((e) => e.type)).toContain("approval.resolved");
  });

  test("an AskUserQuestion tool call is announced as user_question kind", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let router: ApprovalRouter | undefined;
    const sdk: SdkStream = (options) =>
      (async function* () {
        await options.canUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Q?" }] },
          {
            signal: new AbortController().signal,
          },
        );
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      router: (append) => {
        router = new ApprovalRouter({ db, append });
        return router;
      },
    });

    await Bun.sleep(10);

    const requested = events(db).filter((e) => e.type === "approval.requested");
    const payload = JSON.parse(requested[0]!.payload) as Record<string, unknown>;
    expect(payload.kind).toBe("user_question");
    expect(payload.questions).toEqual([{ question: "Q?" }]);

    router!.respond(
      {
        approvalId: String(payload.approvalId),
        decision: "allow",
        answers: { "Q?": "A" },
        inputHash: payload.inputHash,
      },
      { attemptId: "attempt-1", runId: "run-1" },
    );

    expect((await run).state).toBe("finished");
  });
});
