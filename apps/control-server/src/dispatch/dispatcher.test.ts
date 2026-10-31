import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CommandOutbox, migrate } from "@cc-web/control-db";
import { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { Dispatcher } from "./dispatcher.ts";

/**
 * Dispatch on the live transport (§9.2, §14.3).
 *
 * The outbox decides *what* to send and the gateway owns *who* can receive it;
 * this is the seam between them, and the failures that matter are all ordering:
 *
 *  - a `connected` runner has not reconciled, so sending it work is how a run
 *    lands on state the server cannot vouch for (§6.2)
 *  - a command is marked `sent` only when a socket actually took the bytes, and
 *    `sent` still means "retry on the next drain" because a write is not a
 *    receipt (§12.2)
 *  - a reconnected runner gets its pending commands again, under the same
 *    command id, so the runner's inbox dedupes instead of re-executing
 */

type Sent = { type: string; [key: string]: unknown };

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const outbox = new CommandOutbox(db);

  // The gateway calls back into the dispatcher, and the dispatcher sends through
  // the gateway. One of the two has to be assigned late; the holder keeps the
  // cycle explicit instead of hiding it behind a cast.
  let dispatcher: Dispatcher;

  const gateway = new RunnerGateway({
    policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
    verifyCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "owner-1" }
        : { ok: false, reason: "unknown" },
    onReady: (runnerId) => dispatcher.drain(runnerId),
    onReceipt: (runnerId, receipt) => dispatcher.handleReceipt(runnerId, receipt),
  });

  dispatcher = new Dispatcher({ outbox, gateway });

  const sent: Sent[] = [];
  const socket = {
    data: { connectionId: "", generation: 0, runnerId: "", authenticated: false },
    send(payload: string | Uint8Array) {
      sent.push(JSON.parse(String(payload)) as Sent);
      return 1;
    },
    close() {},
  };

  return { db, outbox, gateway, dispatcher, socket, sent };
}

const hello = {
  protocolVersion: 1,
  runnerId: "runner-a",
  bootId: "boot-1",
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  platform: "linux/x64",
  maxConcurrentRuns: 1,
  activeRuns: [],
  eventOffsets: [],
};

/** Bring a socket all the way to `ready`, which is what dispatch requires. */
function readyRunner(
  gateway: RunnerGateway,
  socket: { data: Record<string, unknown>; send(p: string): unknown; close(): unknown },
  sent: Sent[],
) {
  gateway.handleOpen(socket as never, { authorization: "Bearer cck_valid" });
  gateway.handleMessage(socket as never, JSON.stringify({ type: "hello", hello }));
  gateway.handleMessage(socket as never, JSON.stringify({ type: "reconcile", runner: [] }));
  sent.length = 0;
}

const command = {
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start" as const,
  payload: { prompt: "hello" },
  issuedAt: "2026-10-23T00:00:00.000Z",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
};

describe("dispatcher", () => {
  test("a pending command reaches a ready runner as a protocol envelope", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);

    dispatcher.drain("runner-a");

    // §9.1: the envelope fields are top level, and the frame names the protocol
    // version so a runner can refuse a command it does not understand (§17.4).
    expect(sent).toEqual([
      {
        type: "command",
        command: {
          protocolVersion: 1,
          commandId: "cmd-1",
          runnerId: "runner-a",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          workspaceId: "workspace-1",
          kind: "run.start",
          issuedAt: "2026-10-23T00:00:00.000Z",
          payload: { prompt: "hello" },
        },
      },
    ]);
  });

  test("a command with a secure payload delivers the cleartext on the live frame", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);

    // §18.1: the persisted payload masks the apiKey, while `payloadSecure`
    // carries it on the WebSocket frame to the runner.
    await outbox.enqueue({
      ...command,
      payload: { prompt: "hello", profile: { apiKey: "[REDACTED]" } },
      payloadSecure: { prompt: "hello", profile: { apiKey: "sk-secret" } },
    });

    dispatcher.drain("runner-a");

    expect(sent).toEqual([
      {
        type: "command",
        command: {
          protocolVersion: 1,
          commandId: "cmd-1",
          runnerId: "runner-a",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          workspaceId: "workspace-1",
          kind: "run.start",
          issuedAt: "2026-10-23T00:00:00.000Z",
          payload: { prompt: "hello", profile: { apiKey: "sk-secret" } },
        },
      },
    ]);

    // The persisted row keeps the redacted payload.
    const row = outbox.get("cmd-1");
    expect(row?.payload).toEqual({ prompt: "hello", profile: { apiKey: "[REDACTED]" } });
    expect(row?.payloadSecure).toEqual({ prompt: "hello", profile: { apiKey: "sk-secret" } });
  });

  test("a command without a secure payload falls back to the persisted payload", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);

    dispatcher.drain("runner-a");

    // No payloadSecure stored, so the envelope carries the plain payload.
    expect((sent[0]?.command as { payload: unknown })?.payload).toEqual({ prompt: "hello" });
  });

  test("a connected runner is not sent work, because it has not reconciled", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    gateway.handleOpen(socket as never, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket as never, JSON.stringify({ type: "hello", hello }));
    sent.length = 0;

    await outbox.enqueue(command);
    const result = dispatcher.drain("runner-a");

    // §6.2: `connected` means the hello succeeded, not that the runner's state
    // matches the server's. Dispatching here is how work gets lost.
    expect(sent).toEqual([]);
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(outbox.get("cmd-1")?.deliveryState).toBe("pending");
  });

  test("an offline runner is skipped without marking the command sent", async () => {
    const { outbox, dispatcher } = setup();
    await outbox.enqueue(command);

    const result = dispatcher.drain("runner-a");

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(outbox.get("cmd-1")).toMatchObject({ deliveryState: "pending", attemptCount: 0 });
  });

  test("a delivered command is marked sent, and remains pending for a redelivery", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);

    dispatcher.drain("runner-a");

    // `sent` means "handed to a socket", not "the runner has it" (§12.2). The
    // next drain after a reconnect has to offer it again.
    expect(outbox.get("cmd-1")).toMatchObject({ deliveryState: "sent", attemptCount: 1 });
    expect(outbox.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
  });

  test("a reconnecting runner is offered the same command id again", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);
    dispatcher.drain("runner-a");

    // A separate buffer: opening the second socket sends the first one a
    // `stale_generation` error, and mixing the two would make this test about
    // the fencing message instead of about the redelivery.
    const secondSent: Sent[] = [];
    const secondSocket = {
      data: { connectionId: "", generation: 0, runnerId: "", authenticated: false },
      send(payload: string | Uint8Array) {
        secondSent.push(JSON.parse(String(payload)) as Sent);
        return 1;
      },
      close() {},
    };

    gateway.handleOpen(secondSocket as never, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(secondSocket as never, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(secondSocket as never, JSON.stringify({ type: "reconcile", runner: [] }));

    // §14.3 step 4: re-sending pending commands is part of reconciliation. Same
    // id, same payload — the runner's inbox returns the old receipt instead of
    // running the work twice (§9.3).
    expect(
      secondSent.map((s) => [
        s["type"],
        (s["command"] as Record<string, unknown> | undefined)?.["commandId"],
      ]),
    ).toEqual([
      ["hello.ok", undefined],
      ["reconcile.ok", undefined],
      ["command", "cmd-1"],
    ]);
  });

  test("a command accepted by the runner is not offered again", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);
    dispatcher.drain("runner-a");

    gateway.handleMessage(
      socket as never,
      JSON.stringify({
        type: "command.receipt",
        commandId: "cmd-1",
        attemptId: "attempt-1",
        accepted: true,
      }),
    );

    expect(outbox.get("cmd-1")?.deliveryState).toBe("accepted");
    dispatcher.drain("runner-a");
    expect(sent).toHaveLength(1);
  });

  test("a rejected command is retired with the runner's reason", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);
    dispatcher.drain("runner-a");

    gateway.handleMessage(
      socket as never,
      JSON.stringify({
        type: "command.receipt",
        commandId: "cmd-1",
        attemptId: "attempt-1",
        accepted: false,
        reason: "workspace_busy",
      }),
    );

    expect(outbox.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "workspace_busy",
    });
    dispatcher.drain("runner-a");
    expect(sent).toHaveLength(1);
  });

  test("a receipt from a superseded socket is refused", async () => {
    const { outbox, gateway, dispatcher, socket, sent } = setup();
    readyRunner(gateway, socket, sent);
    await outbox.enqueue(command);
    dispatcher.drain("runner-a");

    const secondSocket = {
      data: { connectionId: "", generation: 0, runnerId: "", authenticated: false },
      send(payload: string | Uint8Array) {
        sent.push(JSON.parse(String(payload)) as Sent);
        return 1;
      },
      close() {},
    };
    gateway.handleOpen(secondSocket as never, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(secondSocket as never, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(secondSocket as never, JSON.stringify({ type: "reconcile", runner: [] }));

    // The old socket is closed but a receipt already in flight must not be
    // applied: it describes a connection that no longer holds the identity.
    gateway.handleMessage(
      socket as never,
      JSON.stringify({
        type: "command.receipt",
        commandId: "cmd-1",
        attemptId: "attempt-1",
        accepted: true,
      }),
    );

    expect(outbox.get("cmd-1")?.deliveryState).toBe("sent");
  });

  test("a receipt for an unknown command is refused, not recorded", async () => {
    const { outbox, gateway, socket, sent } = setup();
    readyRunner(gateway, socket, sent);

    const result = gateway.handleMessage(
      socket as never,
      JSON.stringify({
        type: "command.receipt",
        commandId: "cmd-never-enqueued",
        attemptId: "attempt-1",
        accepted: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(outbox.get("cmd-never-enqueued")).toBeUndefined();
  });

  test("reaching ready drains what was queued while the runner was away", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const outbox = new CommandOutbox(db);
    const sent: Sent[] = [];

    const gateway: RunnerGateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onReady: (runnerId) => new Dispatcher({ outbox, gateway }).drain(runnerId),
    });

    await outbox.enqueue(command);

    const socket = {
      data: { connectionId: "", generation: 0, runnerId: "", authenticated: false },
      send(payload: string | Uint8Array) {
        sent.push(JSON.parse(String(payload)) as Sent);
        return 1;
      },
      close() {},
    };

    gateway.handleOpen(socket as never, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket as never, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(socket as never, JSON.stringify({ type: "reconcile", runner: [] }));

    // §14.3 step 4/6: pending commands are re-sent as part of reconciliation,
    // and only after the promotion — never before it.
    expect(sent.map((s) => s["type"])).toEqual(["hello.ok", "reconcile.ok", "command"]);
  });

  describe("rejected run.start (§9.4)", () => {
    const startCommand = {
      commandId: "cmd-start",
      runnerId: "runner-a",
      kind: "run.start" as const,
      payload: { prompt: "hello" },
      issuedAt: "2026-10-23T00:00:00.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    };

    const cancelCommand = {
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel" as const,
      payload: {},
      issuedAt: "2026-10-23T00:00:00.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
    };

    function setupWithHook() {
      const db = new Database(":memory:");
      migrate(db);
      const outbox = new CommandOutbox(db);

      let dispatcher: Dispatcher;
      const gateway: RunnerGateway = new RunnerGateway({
        policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
        verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
        onReceipt: (_runnerId, receipt) => dispatcher.handleReceipt(_runnerId, receipt),
      });

      const calls: Array<{ runId: string; commandId: string; reason: string }> = [];
      dispatcher = new Dispatcher({
        outbox,
        gateway,
        onRejectedStart: (runId, commandId, reason) => calls.push({ runId, commandId, reason }),
      });

      return { db, outbox, dispatcher, gateway, calls };
    }

    test("a rejected run.start calls onRejectedStart with runId + commandId + reason", async () => {
      const { outbox, dispatcher, calls } = setupWithHook();
      await outbox.enqueue(startCommand);

      dispatcher.handleReceipt("runner-a", {
        commandId: "cmd-start",
        attemptId: "attempt-1",
        accepted: false,
        reason: "unknown_workspace",
      });

      expect(calls).toEqual([
        { runId: "run-1", commandId: "cmd-start", reason: "unknown_workspace" },
      ]);
    });

    test("a rejected run.start without an explicit reason still fires the hook", async () => {
      const { outbox, dispatcher, calls } = setupWithHook();
      await outbox.enqueue(startCommand);

      dispatcher.handleReceipt("runner-a", {
        commandId: "cmd-start",
        attemptId: "attempt-1",
        accepted: false,
      });

      expect(calls).toEqual([
        { runId: "run-1", commandId: "cmd-start", reason: "rejected_by_runner" },
      ]);
    });

    test("a rejected run.cancel does NOT call onRejectedStart (§14.2)", async () => {
      const { outbox, dispatcher, calls } = setupWithHook();
      await outbox.enqueue(cancelCommand);

      dispatcher.handleReceipt("runner-a", {
        commandId: "cmd-cancel",
        attemptId: "attempt-1",
        accepted: false,
        reason: "cancelled",
      });

      // A cancel rejection is a request, not an outcome — the original run may
      // still execute, so the slot must not be released.
      expect(calls).toEqual([]);
    });

    test("an accepted run.start does NOT call onRejectedStart", async () => {
      const { outbox, dispatcher, calls } = setupWithHook();
      await outbox.enqueue(startCommand);

      dispatcher.handleReceipt("runner-a", {
        commandId: "cmd-start",
        attemptId: "attempt-1",
        accepted: true,
      });

      expect(calls).toEqual([]);
    });
  });

  describe("openSecurePayload (§18.1, P3-C Task 5b)", () => {
    test("openSecurePayload is applied to the live frame", async () => {
      // The outbox stores a sealed string in payloadSecure; the dispatcher's
      // opener decrypts it so the runner receives the cleartext object.
      const { outbox, gateway, socket, sent } = setup();

      const opened = { prompt: "hello", profile: { apiKey: "sk-secret" } };
      const opener = (stored: unknown) =>
        typeof stored === "string" && stored === "sealed:v1:ct" ? opened : null;

      await outbox.enqueue({
        ...command,
        payload: { prompt: "hello", profile: { apiKey: "[REDACTED]" } },
        payloadSecure: "sealed:v1:ct",
      });

      const dispatcher = new Dispatcher({ outbox, gateway, openSecurePayload: opener });
      readyRunner(gateway, socket, sent);
      dispatcher.drain("runner-a");

      expect((sent[0]?.command as { payload: unknown })?.payload).toEqual(opened);
    });

    test("when opener returns null, the redacted payload is delivered instead", async () => {
      const { outbox, gateway, socket, sent } = setup();

      await outbox.enqueue({
        ...command,
        payload: { prompt: "hello", profile: { apiKey: "[REDACTED]" } },
        payloadSecure: "sealed:tampered:ct",
      });

      // Opener returns null (tampered or wrong key) → fall back to redacted payload.
      const dispatcher = new Dispatcher({ outbox, gateway, openSecurePayload: () => null });
      readyRunner(gateway, socket, sent);
      dispatcher.drain("runner-a");

      expect((sent[0]?.command as { payload: unknown })?.payload).toEqual({
        prompt: "hello",
        profile: { apiKey: "[REDACTED]" },
      });
    });

    test("without an opener the stored payloadSecure is used as-is", async () => {
      const { outbox, gateway, socket, sent } = setup();

      await outbox.enqueue({
        ...command,
        payload: { prompt: "hello", profile: { apiKey: "[REDACTED]" } },
        payloadSecure: { prompt: "hello", profile: { apiKey: "sk-secret" } },
      });

      // No opener → payloadSecure used directly (backward compatible).
      const dispatcher = new Dispatcher({ outbox, gateway });
      readyRunner(gateway, socket, sent);
      dispatcher.drain("runner-a");

      expect((sent[0]?.command as { payload: unknown })?.payload).toEqual({
        prompt: "hello",
        profile: { apiKey: "sk-secret" },
      });
    });
  });
});
