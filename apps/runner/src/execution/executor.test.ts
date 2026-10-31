import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EVENT_PAYLOAD_BYTES } from "@cc-web/protocol";
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

    const toolUse = {
      type: "tool_use",
      id: "toolu-1",
      name: "Bash",
      input: { command: "echo hi" },
    };
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
            content: [
              { type: "tool_result", tool_use_id: "toolu-1", content: "hi", is_error: false },
            ],
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

  test("a mixed user frame (text + tool_result) still lands as run.status", async () => {
    // The short-circuit on isToolResultFrame is what stops a future "map any
    // user frame" refactor from silently half-mapping mixed frames: an
    // unexpected shape stays visible as the generic event, never loses its
    // content and never fires partial tool.completed rows.
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
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "odd frame" },
              { type: "tool_result", tool_use_id: "toolu-1", content: "x" },
            ],
          },
        };
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    const list = events(db);
    expect(list.map((e) => e.type)).toEqual([
      "run.started",
      "session.updated",
      "run.status",
      "run.finished",
    ]);
    const frame = JSON.parse(list[2]!.payload) as { type?: string };
    expect(frame.type).toBe("user");
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

describe("the resumeSessionId payload", () => {
  test("an explicit resumeSessionId is forwarded to the SDK as resume", async () => {
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

    await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", resumeSessionId: "explicit-session-id" } },
      { workspacePath: WORKSPACES.get("workspace-1")!, sdk },
    );

    // §10.4: an explicit resumeSessionId from the run.start payload wins over the
    // stored session id and is passed directly to the SDK.
    expect(seen?.resume).toBe("explicit-session-id");
  });

  test("an omitted resumeSessionId falls back to the stored session id", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    db.prepare("UPDATE local_attempts SET sdk_session_id = ? WHERE attempt_id = ?").run(
      "sdk-previous",
      "attempt-1",
    );

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

    // No resumeSessionId in the payload: the previous behavior is preserved.
    expect(seen?.resume).toBe("sdk-previous");
  });

  test("an empty resumeSessionId is ignored, falling back to the stored session id", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    db.prepare("UPDATE local_attempts SET sdk_session_id = ? WHERE attempt_id = ?").run(
      "sdk-previous",
      "attempt-1",
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
      { ...COMMAND, payload: { prompt: "hello", resumeSessionId: "" } },
      { workspacePath: WORKSPACES.get("workspace-1")!, sdk },
    );

    // An empty string is not a valid id — the stored session id is used instead.
    expect(seen?.resume).toBe("sdk-previous");
  });

  test("a non-string resumeSessionId is ignored, falling back to the stored session id", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    db.prepare("UPDATE local_attempts SET sdk_session_id = ? WHERE attempt_id = ?").run(
      "sdk-previous",
      "attempt-1",
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
      { ...COMMAND, payload: { prompt: "hello", resumeSessionId: 42 } },
      { workspacePath: WORKSPACES.get("workspace-1")!, sdk },
    );

    // A non-string is not a valid id — the stored session id is used instead.
    expect(seen?.resume).toBe("sdk-previous");
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

describe("the spool seam (§12.6)", () => {
  /**
   * A stream that holds until its abort signal fires, then throws the shape the
   * real SDK produces on abort. Used for the stops, where the point is the
   * terminal classification rather than the streaming.
   */
  function abortableStream(): SdkStream {
    return (options) =>
      (async function* () {
        await new Promise<never>((_, reject) => {
          options.abort?.addEventListener("abort", () => reject(new Error("Operation aborted")), {
            once: true,
          });
        });
      })();
  }

  test("onAppend hands over the attempt's own sequenced append", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let offered: ((type: string, payload: unknown) => void) | undefined;
    const sdk: SdkStream = () =>
      (async function* () {
        // The seam must be live by the time the SDK is built: a spool warning
        // during the run has to be journalable.
        offered?.("spool.warning", { events: 5000, bytes: 1 });
        yield { type: "result", subtype: "success", result: "ok" };
      })();

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk,
      onAppend: (append) => {
        offered = append;
      },
    });

    expect(outcome.state).toBe("finished");
    // The warning is a real row at the attempt's own sequence, between the
    // events the executor wrote — not a borrowed number, not a second writer.
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual(["run.started", "spool.warning", "run.finished"]);
    expect(list.map((e) => e.local_sequence)).toEqual([1, 2, 3]);
  });

  test("an abortReason turns an abort into run.failed carrying the reason", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const controller = new AbortController();
    // The reason is set on the controller *after* construction, exactly as a
    // spool critical stop does — which is why the option is a thunk and not a
    // captured value.
    let reason: string | undefined;
    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: abortableStream(),
      signal: controller.signal,
      abortReason: () => reason,
    });

    await Bun.sleep(10);
    reason = "spool_critical";
    controller.abort();

    const outcome = await run;

    // §12.6 clause 6: a stop with a reason is a policy failure, and the record
    // says why, rather than an unexplained interruption.
    expect(outcome.state).toBe("failed");
    expect(attemptState(db, "attempt-1")).toBe("failed");
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual(["run.started", "run.failed"]);
    const failed = list.find((e) => e.type === "run.failed");
    expect(failed && JSON.parse(failed.payload)).toEqual({ error: "spool_critical" });
  });

  test("no abortReason keeps the deliberate-cancel reading", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const controller = new AbortController();
    const run = executeRun(db, COMMAND, {
      workspacePath: WORKSPACES.get("workspace-1")!,
      sdk: abortableStream(),
      signal: controller.signal,
      // Answers undefined at abort time — a cancel with nothing to explain.
      abortReason: () => undefined,
    });

    await Bun.sleep(10);
    controller.abort();

    const outcome = await run;

    expect(outcome.state).toBe("interrupted");
    expect(events(db).map((e) => e.type)).toEqual(["run.started", "run.interrupted"]);
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

describe("effort and ultracode", () => {
  function capture(payload: Record<string, unknown>) {
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

    const done = executeRun(
      db,
      { ...COMMAND, payload },
      {
        workspacePath: WORKSPACES.get("workspace-1")!,
        sdk,
      },
    );
    return done.then(() => captured);
  }

  test("forwards the run's effort and ultracode into the SDK options", async () => {
    const captured = await capture({ prompt: "hello", effort: "max", ultracode: true });
    expect(captured?.effort).toBe("max");
    expect(captured?.ultracode).toBe(true);
  });

  test("an absent or empty one leaves the SDK option unset", async () => {
    // `false` is a real choice (turn it off) and must travel; absent and empty
    // mean inherit, and setting anything would shadow the host's own flags.
    const absent = await capture({ prompt: "hello" });
    expect(absent?.effort).toBeUndefined();
    expect(absent?.ultracode).toBeUndefined();

    const empty = await capture({ prompt: "hello", effort: "", ultracode: "yes" });
    expect(empty?.effort).toBeUndefined();
    expect(empty?.ultracode).toBeUndefined();
  });

  test("ultracode false travels rather than being dropped", async () => {
    const captured = await capture({ prompt: "hello", ultracode: false });
    expect(captured?.ultracode).toBe(false);
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

describe("run-start baseline capture (P3-B)", () => {
  test("captures the baseline after the branch gate and before the SDK", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "a-1",
      sessionId: "s-1",
      runId: "run-1",
      workspacePath: "/w",
    });

    const order: string[] = [];
    const outcome = await executeRun(
      db,
      { ...COMMAND, attemptId: "a-1", sessionId: "s-1" },
      {
        workspacePath: "/w",
        prepareWorkspace: async () => {
          order.push("prepare");
          return { kind: "ready", checkedOut: false };
        },
        captureBaseline: async (_path, attemptId) => {
          order.push(`capture:${attemptId}`);
          return { ok: true };
        },
        sdk: () =>
          (async function* () {
            order.push("sdk");
            yield { type: "result", subtype: "success", result: "ok" };
          })(),
      },
    );

    expect(outcome.state).toBe("finished");
    expect(order).toEqual(["prepare", "capture:a-1", "sdk"]);
  });

  test("a refused branch gate never captures", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "a-2",
      sessionId: "s-2",
      runId: "run-2",
      workspacePath: "/w",
    });

    const seen: string[] = [];
    const outcome = await executeRun(
      db,
      { ...COMMAND, attemptId: "a-2", sessionId: "s-2" },
      {
        workspacePath: "/w",
        prepareWorkspace: async () => ({ kind: "refused", reason: "dirty_tree" }),
        captureBaseline: async () => {
          seen.push("capture");
          return { ok: true };
        },
        sdk: () =>
          (async function* () {
            yield { type: "result", subtype: "success", result: "ok" };
          })(),
      },
    );

    expect(outcome.state).toBe("failed");
    expect(seen).toEqual([]);
  });

  test("a failed capture fails the run with snapshot_failed", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "a-3",
      sessionId: "s-3",
      runId: "run-3",
      workspacePath: "/w",
    });

    const outcome = await executeRun(
      db,
      { ...COMMAND, attemptId: "a-3", sessionId: "s-3" },
      {
        workspacePath: "/w",
        captureBaseline: async () => ({ ok: false, reason: "disk full" }),
        sdk: failingStream(new Error("must not start")),
      },
    );

    expect(outcome.state).toBe("failed");
    const types = db
      .query(
        "SELECT type, payload FROM event_outbox WHERE attempt_id = 'a-3' ORDER BY local_sequence",
      )
      .all() as Array<{ type: string; payload: string }>;
    expect(types).toContainEqual({
      type: "run.failed",
      payload: JSON.stringify({ error: "snapshot_failed", reason: "disk full" }),
    });
    // A failed capture must release the workspace lock, just like other failures.
    expect(lockHolder(db, "/w")).toBeUndefined();
    expect(attemptState(db, "a-3")).toBe("failed");
  });
});

describe("workspace preparation (M4 branch gate)", () => {
  const finishingSdk: SdkStream = () =>
    (async function* () {
      yield { type: "result", subtype: "success", result: "done" };
    })();

  test("a refused preparation fails the run before any SDK call and releases the lock", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let sdkCalled = false;
    const outcome = await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", branch: "dev" } },
      {
        workspacePath: "/home/runner/project",
        sdk: (options) => {
          sdkCalled = true;
          return finishingSdk(options);
        },
        prepareWorkspace: async () => ({
          kind: "refused",
          reason: "dirty_tree",
          branch: "dev",
        }),
      },
    );

    expect(outcome.state).toBe("failed");
    expect(sdkCalled).toBe(false);
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual(["run.started", "run.failed"]);
    expect(JSON.parse(list[1]!.payload)).toEqual({
      error: "branch_refused",
      reason: "dirty_tree",
      branch: "dev",
    });
    expect(attemptState(db, "attempt-1")).toBe("failed");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("a checkout records one honest status row before the run proceeds", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const seen: Array<{ workspacePath: string; branch: string | undefined }> = [];
    const outcome = await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", branch: "dev" } },
      {
        workspacePath: "/home/runner/project",
        sdk: finishingSdk,
        prepareWorkspace: async (workspacePath, branch) => {
          seen.push({ workspacePath, branch });
          return { kind: "ready", checkedOut: true, ...(branch === undefined ? {} : { branch }) };
        },
      },
    );

    expect(outcome.state).toBe("finished");
    expect(seen).toEqual([{ workspacePath: "/home/runner/project", branch: "dev" }]);
    const list = events(db);
    expect(list.map((e) => e.type)).toEqual(["run.started", "run.status", "run.finished"]);
    expect(JSON.parse(list[1]!.payload)).toEqual({ action: "checkout", branch: "dev" });
  });

  test("a ready result without a checkout adds no row", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const outcome = await executeRun(db, COMMAND, {
      workspacePath: "/home/runner/project",
      sdk: finishingSdk,
      prepareWorkspace: async () => ({ kind: "ready", checkedOut: false }),
    });

    expect(outcome.state).toBe("finished");
    expect(events(db).map((e) => e.type)).toEqual(["run.started", "run.finished"]);
  });

  test("an empty or non-string branch payload is absent, like the model rule", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    const seen: Array<string | undefined> = [];
    const prepare = async (_workspacePath: string, branch: string | undefined) => {
      seen.push(branch);
      return { kind: "ready" as const, checkedOut: false };
    };

    beginAttempt(db, {
      attemptId: "attempt-2",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    await executeRun(
      db,
      { ...COMMAND, payload: { prompt: "hello", branch: "" } },
      {
        workspacePath: "/home/runner/project",
        sdk: finishingSdk,
        prepareWorkspace: prepare,
      },
    );
    await executeRun(
      db,
      { ...COMMAND, attemptId: "attempt-2", payload: { prompt: "hello", branch: 42 } },
      {
        workspacePath: "/home/runner/project",
        sdk: finishingSdk,
        prepareWorkspace: prepare,
      },
    );

    expect(seen).toEqual([undefined, undefined]);
  });
});

/**
 * The per-event ceiling (§12.6).
 *
 * The transport refuses a frame over `WS_MAX_PAYLOAD_BYTES`, so an event larger
 * than that can never be delivered — and its durable row is refused on every
 * replay, so the refusal is permanent rather than transient. The executor is the
 * single writer for every attempt event, so this is where the bound has to hold:
 * the pump's "always send one event" guard is only honest if no single event can
 * outgrow the frame it will be sent in.
 */
describe("an oversized event", () => {
  test("is persisted under the transport ceiling, not above it", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    // A raw SDK frame the executor does not decompose: it lands as one
    // `message.completed` carrying whatever the SDK emitted. Nothing upstream
    // caps it — `redactSdkMessage` walks keys, it does not measure bytes.
    const sdk: SdkStream = () =>
      (async function* () {
        yield { type: "assistant", text: "x".repeat(MAX_EVENT_PAYLOAD_BYTES * 3) };
      })();

    await executeRun(db, COMMAND, { workspacePath: WORKSPACES.get("workspace-1")!, sdk });

    const oversized = events(db).filter(
      (e) => Buffer.byteLength(e.payload) > MAX_EVENT_PAYLOAD_BYTES,
    );
    expect(oversized).toHaveLength(0);

    // The event is present, not dropped — §12.6 forbids silently losing a
    // mandatory event and reporting success.
    const completed = events(db).find((e) => e.type === "message.completed");
    expect(completed).toBeDefined();
  });
});

describe("attachments (§attachments)", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function freshDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "cc-web-exec-attach-"));
    dirs.push(dir);
    return dir;
  }

  test("downloads attachments and injects them into the prompt and run.started", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const runnerHome = await freshDir();

    // Spin up a mock control server that serves the two attachments.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const id = url.pathname.split("/").pop();
        if (id === "att-1") {
          return new Response("# spec", {
            headers: { "content-type": "text/markdown" },
          });
        }
        if (id === "att-2") {
          return new Response('{"v":1}', {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const commandWithAttachments = {
        ...COMMAND,
        payload: {
          prompt: "fix the bug",
          attachments: [
            { id: "att-1", name: "spec.md", mimeType: "text/markdown", size: 6 },
            { id: "att-2", name: "data.json", mimeType: "application/json", size: 6 },
          ],
        },
      };

      let seenPrompt: string | undefined;
      const sdk: SdkStream = (options) => {
        seenPrompt = options.prompt;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })();
      };

      await executeRun(db, commandWithAttachments, {
        workspacePath: "/home/runner/project",
        sdk,
        runnerHome,
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
      });

      const attachmentsDir = join(runnerHome, "tmp/sessions/session-1/attachments");

      // The SDK received a prompt that includes the attachment context block.
      expect(seenPrompt).toContain("[Attached Files]");
      expect(seenPrompt).toContain(
        `spec.md: ${join(attachmentsDir, "att-1-spec.md")} (text/markdown)`,
      );
      expect(seenPrompt).toContain(
        `data.json: ${join(attachmentsDir, "att-2-data.json")} (application/json)`,
      );
      expect(seenPrompt).toContain("User prompt:");
      expect(seenPrompt).toContain("fix the bug");

      // The run.started event carries the attachment metadata and clean original prompt.
      const started = events(db).find((e) => e.type === "run.started");
      expect(started).toBeDefined();
      const startedPayload = JSON.parse(started!.payload) as Record<string, unknown>;
      expect(startedPayload.prompt).toBe("fix the bug");
      expect(Array.isArray(startedPayload.attachments)).toBe(true);
      const attachments = startedPayload.attachments as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toEqual({
        id: "att-1",
        name: "spec.md",
        mimeType: "text/markdown",
        size: 6,
      });
      expect(attachments[1]).toEqual({
        id: "att-2",
        name: "data.json",
        mimeType: "application/json",
        size: 6,
      });
    } finally {
      server.stop();
    }
  });

  test("when downloading attachments fails, run fails and releases workspace lock", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    const runnerHome = await freshDir();

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("internal error", { status: 500 });
      },
    });

    try {
      const commandWithAttachments = {
        ...COMMAND,
        payload: {
          prompt: "fix the bug",
          attachments: [{ id: "att-1", name: "spec.md", mimeType: "text/markdown", size: 6 }],
        },
      };

      const outcome = await executeRun(db, commandWithAttachments, {
        workspacePath: "/home/runner/project",
        sdk: () => (async function* () {})(),
        runnerHome,
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
      });

      expect(outcome.state).toBe("failed");
      expect(attemptState(db, "attempt-1")).toBe("failed");
      expect(lockHolder(db, "/home/runner/project")).toBeUndefined();

      const failure = events(db).find((e) => e.type === "run.failed");
      expect(failure).toBeDefined();
      const payload = JSON.parse(failure!.payload) as Record<string, unknown>;
      expect(payload.error).toBe("attachment_download_failed");
    } finally {
      server.stop();
    }
  });

  test("without a serverUrl or token, attachments are skipped and the prompt is unchanged", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let seenPrompt: string | undefined;
    const sdk: SdkStream = (options) => {
      seenPrompt = options.prompt;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    const commandWithAttachments = {
      ...COMMAND,
      payload: {
        prompt: "hello",
        attachments: [{ id: "att-1", name: "spec.md", mimeType: "text/markdown", size: 6 }],
      },
    };

    // Pass runnerHome but omit serverUrl and token — the run should not attempt
    // any download and should proceed with the raw prompt.
    await executeRun(db, commandWithAttachments, {
      workspacePath: "/home/runner/project",
      sdk,
      runnerHome: await freshDir(),
    });

    expect(seenPrompt).toBe("hello");

    const started = events(db).find((e) => e.type === "run.started");
    const startedPayload = JSON.parse(started!.payload) as Record<string, unknown>;
    expect(startedPayload.attachments).toBeUndefined();
  });

  test("a payload without attachments behaves as before", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });

    let seenPrompt: string | undefined;
    const sdk: SdkStream = (options) => {
      seenPrompt = options.prompt;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    };

    await executeRun(db, COMMAND, {
      workspacePath: "/home/runner/project",
      sdk,
    });

    expect(seenPrompt).toBe("hello");
    const started = events(db).find((e) => e.type === "run.started");
    const startedPayload = JSON.parse(started!.payload) as Record<string, unknown>;
    expect(startedPayload.attachments).toBeUndefined();
  });
});

describe("the schedule mirror (§11.5)", () => {
  test("CronCreate is mirrored as schedule.created in the attempt's own sequence", async () => {
    const { db } = setup();
    beginAttempt(db, {
      attemptId: "attempt-1",
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: "/home/runner/project",
    });
    const sdk: SdkStream = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "CronCreate",
                input: { cron: "58 17 31 10 *", recurring: false, prompt: "Kiểm tra dung lượng" },
              },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Scheduled" }],
          },
          tool_use_result: {
            id: "af5c4b05",
            humanSchedule: "58 17 31 10 *",
            recurring: false,
            nextFireAt: 1793444280000,
          },
        };
        yield { type: "result", subtype: "success", is_error: false };
      },
    });

    await executeRun(db, COMMAND, { workspacePath: "/home/runner/project", sdk });

    const rows = events(db);
    const mirrored = rows.find((row) => row.type === "schedule.created");
    expect(mirrored).toBeDefined();
    expect(JSON.parse(mirrored!.payload)).toMatchObject({
      toolCallId: "toolu_1",
      cliTaskId: "af5c4b05",
      cron: "58 17 31 10 *",
      recurring: false,
      prompt: "Kiểm tra dung lượng",
      nextFireAt: 1793444280000,
    });
    // The mirror sits between run.started and the terminal event.
    const types = rows.map((row) => row.type);
    expect(types.indexOf("schedule.created")).toBeGreaterThan(types.indexOf("run.started"));
    expect(types.indexOf("schedule.created")).toBeLessThan(types.lastIndexOf("run.finished"));
  });
});
