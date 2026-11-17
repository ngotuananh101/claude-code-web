import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { CommandOutbox, fingerprintOf } from "./command-outbox.ts";
import { type RunnerCapacity, Scheduler } from "./scheduler.ts";

/**
 * Scheduling MVP (§11.3).
 *
 * The user picks a workspace already bound to a Runner; the server checks that
 * Runner is ready and has capacity, then enqueues. No smart placement, no worker
 * pool — deliberately.
 *
 * Two things this must never do:
 *
 *  - dispatch to a Runner that is `connected` but not `ready` (§6.2)
 *  - exceed the Runner's advertised concurrency, which would over-commit a
 *    machine the operator sized for one run
 */

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, scheduler: new Scheduler(db) };
}

function capacity(overrides: Partial<RunnerCapacity> = {}): RunnerCapacity {
  return {
    runnerId: "runner-a",
    state: "ready",
    maxConcurrentRuns: 1,
    activeRuns: 0,
    ...overrides,
  };
}

const request = {
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  prompt: "hello",
  ownerId: "user-1",
};

describe("scheduler", () => {
  test("a ready runner with capacity accepts a run", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity());

    expect(decision).toMatchObject({ ok: true, runnerId: "runner-a" });
  });

  test("a connected runner is not dispatchable, because it has not reconciled", async () => {
    const { scheduler } = setup();

    // §6.2: `connected` means the hello succeeded, not that the runner's state
    // matches the server's. Dispatching here is how work gets lost.
    const decision = await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(decision).toEqual({ ok: false, reason: "runner_not_ready" });
  });

  test("a runner at capacity queues the run by default", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(
      request,
      capacity({ activeRuns: 1, maxConcurrentRuns: 1 }),
    );

    expect(decision).toMatchObject({ ok: true, queued: true });
    expect(db.query("SELECT delivery_state FROM command_outbox").get()).toEqual({
      delivery_state: "queued",
    });
  });

  test("a runner at capacity is refused with queue: false", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(
      request,
      capacity({ activeRuns: 1, maxConcurrentRuns: 1 }),
      { queue: false },
    );

    expect(decision).toEqual({ ok: false, reason: "runner_at_capacity" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 0 });
  });

  test("capacity zero queues the run by default, since it cannot be admitted now", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity({ maxConcurrentRuns: 0 }));

    expect(decision).toMatchObject({ ok: true, queued: true });
  });

  test("capacity zero is refused with queue: false", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity({ maxConcurrentRuns: 0 }), {
      queue: false,
    });

    expect(decision).toEqual({ ok: false, reason: "runner_at_capacity" });
  });

  test("an offline runner is refused with its own reason", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity({ state: "offline" }));

    expect(decision).toEqual({ ok: false, reason: "runner_offline" });
  });

  test("a session cannot have two runs dispatched at once (§2.3)", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // The second run is a different id for the same session: with queuing on it
    // waits behind the active run instead of being refused.
    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );

    expect(decision).toMatchObject({ ok: true, queued: true });
    expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
  });

  test("a session cannot have two runs dispatched at once with queue: false (§2.3)", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
      { queue: false },
    );

    expect(decision).toEqual({ ok: false, reason: "session_busy" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 1 });
  });

  test("a dispatched run is enqueued to the outbox in the same call", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity());
    expect(decision.ok).toBe(true);

    // Enqueue is part of dispatch, not a separate step: a decision the outbox
    // never hears about is a run the operator believes was started.
    const rows = db.query("SELECT command_id, kind, runner_id FROM command_outbox").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run.start", runner_id: "runner-a" });
  });

  test("a dispatch with a branch carries it on the run.start payload", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch({ ...request, branch: "dev" }, capacity());
    expect(decision.ok).toBe(true);

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      prompt: "hello",
      branch: "dev",
    });
  });

  test("a dispatch without a branch omits the key, never a stand-in value", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect("branch" in payload).toBe(false);
  });

  test("a dispatch with a resumeSessionId carries it on the run.start payload", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(
      { ...request, resumeSessionId: "prev-session-id" },
      capacity(),
    );
    expect(decision).toMatchObject({ ok: true });

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      prompt: "hello",
      resumeSessionId: "prev-session-id",
    });
  });

  test("a dispatch without a resumeSessionId omits the key, never a stand-in value", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect("resumeSessionId" in payload).toBe(false);
  });

  test("a dispatch with attachments carries them on the run.start payload", async () => {
    const { db, scheduler } = setup();

    const attachments = [{ id: "att-1", name: "a.png", mimeType: "image/png", size: 100 }];
    const decision = await scheduler.dispatch({ ...request, attachments }, capacity());
    expect(decision.ok).toBe(true);

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      prompt: "hello",
      attachments: [{ id: "att-1", name: "a.png", mimeType: "image/png", size: 100 }],
    });
  });

  test("a dispatch without attachments omits the key, never an empty list", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect("attachments" in payload).toBe(false);
  });

  test("a refused dispatch writes nothing to the outbox", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 0 });
  });

  test("a second dispatch on a busy session is queued instead of refused", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    const second = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );

    expect(second).toMatchObject({ ok: true, queued: true });
    expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
    expect(
      db
        .query("SELECT delivery_state, queue_snapshot FROM command_outbox WHERE run_id = 'run-2'")
        .get(),
    ).toEqual({
      delivery_state: "queued",
      queue_snapshot: JSON.stringify({ runnerId: "runner-a", workspaceId: "workspace-1" }),
    });
  });

  test("queue: false keeps the session_busy refusal", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());
    const second = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
      { queue: false },
    );
    expect(second).toEqual({ ok: false, reason: "session_busy" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 1 }); // only run-1's row
  });

  test("a runner at capacity queues the run, and queue: false refuses it", async () => {
    const { scheduler } = setup();
    const full = capacity({ activeRuns: 1, maxConcurrentRuns: 1 });
    expect(await scheduler.dispatch(request, full)).toMatchObject({ ok: true, queued: true });
    expect(
      await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, full, {
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "runner_at_capacity" });
  });

  test("another session running on the same workspace is queued", async () => {
    const { scheduler } = setup();
    const twoSlots = capacity({ maxConcurrentRuns: 2 });
    expect(await scheduler.dispatch(request, twoSlots)).toMatchObject({ ok: true, queued: false });

    const sibling = { ...request, sessionId: "session-2", runId: "run-2", attemptId: "attempt-2" };
    expect(await scheduler.dispatch(sibling, twoSlots)).toMatchObject({ ok: true, queued: true });
    // A distinct run id, or the persistence check would answer duplicate_run first.
    expect(
      await scheduler.dispatch({ ...sibling, runId: "run-3", attemptId: "attempt-3" }, twoSlots, {
        queue: false,
      }),
    ).toEqual({ ok: false, reason: "workspace_busy" });
  });

  test("a queued dispatch carries no resumeSessionId, an admitted one keeps it", async () => {
    const { db, scheduler } = setup();
    const withResume = { ...request, resumeSessionId: "sdk-1" };
    await scheduler.dispatch(withResume, capacity()); // run-1 admitted, keeps the field
    await scheduler.dispatch({ ...withResume, runId: "run-2", attemptId: "attempt-2" }, capacity());

    const payloadOf = (runId: string) =>
      JSON.parse(
        (
          db.query("SELECT payload FROM command_outbox WHERE run_id = ?").get(runId) as {
            payload: string;
          }
        ).payload,
      ) as Record<string, unknown>;

    expect(payloadOf("run-1")["resumeSessionId"]).toBe("sdk-1");
    expect(payloadOf("run-2")).not.toHaveProperty("resumeSessionId");
  });

  test("a queued first run still pins the session (§invariant 11)", async () => {
    const { db, scheduler } = setup();
    const full = capacity({ activeRuns: 1, maxConcurrentRuns: 1 });
    expect(await scheduler.dispatch(request, full)).toMatchObject({ ok: true, queued: true });
    expect(
      db.query("SELECT runner_id, workspace_id FROM sessions WHERE id = ?").get("session-1"),
    ).toEqual({ runner_id: "runner-a", workspace_id: "workspace-1" });
  });

  test("a dispatch that contradicts the session's pin is refused, not queued", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity()); // pins session-1 → runner-a
    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity({ runnerId: "runner-b" }),
    );
    expect(decision).toEqual({ ok: false, reason: "session_pinned" });
    expect(
      db.query("SELECT COUNT(*) AS n FROM command_outbox WHERE run_id = 'run-2'").get(),
    ).toEqual({
      n: 0,
    });
  });

  test("duplicate_run sees a queued run", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity()); // run-1 admitted
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued

    const again = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );
    expect(again).toEqual({ ok: false, reason: "duplicate_run" });
  });

  test("schedule ids ride the run.start payload", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(
      { ...request, runId: "run_sched_1", scheduleId: "sched_1", scheduleCron: "58 17 31 10 *" },
      capacity(),
    );

    const row = db
      .query("SELECT payload FROM command_outbox WHERE run_id = ?")
      .get("run_sched_1") as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toMatchObject({
      scheduleId: "sched_1",
      scheduleCron: "58 17 31 10 *",
    });
  });

  test("activeRunFor answers the attempt id the double-fire guard needs", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    expect(scheduler.activeRunFor("session-1")).toEqual({
      runId: "run-1",
      runnerId: "runner-a",
      attemptId: "attempt-1",
    });
  });

  test("releasing a run frees the session and the capacity", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    scheduler.release("run-1");

    expect(scheduler.activeRunFor("session-1")).toBeUndefined();
    expect(scheduler.capacityFor("runner-a", capacity())).toMatchObject({ activeRuns: 0 });
  });

  test("the same run id cannot be dispatched twice", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // Different session, same run id — a retry bug that must not create a
    // second command.
    const decision = await scheduler.dispatch({ ...request, sessionId: "session-2" }, capacity());

    expect(decision).toEqual({ ok: false, reason: "duplicate_run" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 1 });
  });

  test("an accepted dispatch pins the session (§2.3)", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    // The pin records whose session it is and where it ran, so the route can
    // answer a foreign owner with 404 and rerun placement never.
    expect(
      db
        .query("SELECT owner_id, workspace_id, runner_id FROM sessions WHERE id = ?")
        .get("session-1"),
    ).toEqual({ owner_id: "user-1", workspace_id: "workspace-1", runner_id: "runner-a" });
  });

  test("the pin outlives a dispatch on another runner", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // Free the session the way a terminal event would, then send the next run
    // of the same session at a different runner. The pin contradicts the new
    // placement, so the dispatch is refused — moving a session is migration,
    // not a side effect of a dispatch (ADR-006).
    db.exec("DELETE FROM active_runs");
    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity({ runnerId: "runner-b" }),
    );
    expect(decision).toEqual({ ok: false, reason: "session_pinned" });
    expect(
      db.query("SELECT COUNT(*) AS n FROM command_outbox WHERE run_id = 'run-2'").get(),
    ).toEqual({
      n: 0,
    });

    expect(db.query("SELECT runner_id FROM sessions WHERE id = ?").get("session-1")).toEqual({
      runner_id: "runner-a",
    });
  });

  test("a refused dispatch writes no pin", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("a concurrent dispatch cannot leave the pin on the loser", async () => {
    const { db, scheduler } = setup();
    const subtle = globalThis.crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    const releases: Array<() => void> = [];
    // The outbox fingerprint hashes asynchronously; hold each digest until the
    // test releases it, so the interleaving of two concurrent dispatches of
    // one idle session is decided here instead of by the event loop.
    subtle.digest = ((...args: Parameters<typeof realDigest>) =>
      new Promise<ArrayBuffer>((resolve) =>
        releases.push(() => resolve(realDigest(...args))),
      )) as typeof subtle.digest;
    try {
      const loser = scheduler.dispatch(request, capacity());
      await Bun.sleep(2);
      const winner = scheduler.dispatch(
        { ...request, runId: "run-2", attemptId: "attempt-2" },
        capacity(),
      );
      await Bun.sleep(2);
      releases[1]?.();
      await Bun.sleep(2);
      releases[0]?.();
      const decisions = await Promise.all([loser, winner]);

      // The insert race went to run-2; the loser could not claim the session
      // slot and is queued instead of rejected, while the pin stays on the
      // winner's placement.
      expect(decisions[1]).toMatchObject({ ok: true, runnerId: "runner-a", queued: false });
      expect(decisions[0]).toMatchObject({ ok: true, queued: true });
      expect(db.query("SELECT runner_id FROM sessions WHERE id = ?").get("session-1")).toEqual({
        runner_id: "runner-a",
      });
      expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
    } finally {
      subtle.digest = realDigest;
    }
  });

  test("a UNIQUE-race requeue with resumeSessionId keeps payload and fingerprint consistent", async () => {
    const { db, scheduler } = setup();
    const outbox = new CommandOutbox(db);
    const subtle = globalThis.crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    const releases: Array<() => void> = [];
    subtle.digest = ((...args: Parameters<typeof realDigest>) =>
      new Promise<ArrayBuffer>((resolve) =>
        releases.push(() => resolve(realDigest(...args))),
      )) as typeof subtle.digest;
    try {
      const loser = scheduler.dispatch({ ...request, resumeSessionId: "sdk-1" }, capacity());
      await Bun.sleep(2);
      const winner = scheduler.dispatch(
        { ...request, runId: "run-2", attemptId: "attempt-2" },
        capacity(),
      );
      await Bun.sleep(2);
      // Winner's enqueue fingerprint (release[1]): let it admit and claim the slot.
      releases[1]?.();
      await Bun.sleep(2);
      // Loser's precompute rewrite fingerprint (release[0]): unblocks its enqueue.
      releases[0]?.();
      await Bun.sleep(2);
      // Loser's enqueue fingerprint (release[2], new code): it then loses the
      // active_runs race and takes the synchronous requeue rewrite path.
      releases[2]?.();
      const [loserDecision, winnerDecision] = await Promise.all([loser, winner]);
      // Restore before the async fingerprint/enqueue assertions below; the mock
      // must only gate the dispatch race.
      subtle.digest = realDigest;

      expect(winnerDecision).toMatchObject({ ok: true, queued: false });
      expect(loserDecision).toMatchObject({ ok: true, queued: true });
      const commandId = (loserDecision as { commandId: string }).commandId;

      const row = db
        .query(
          "SELECT payload, payload_secure, fingerprint, runner_id, kind FROM command_outbox WHERE command_id = ?",
        )
        .get(commandId) as {
        payload: string;
        payload_secure: string | null;
        fingerprint: string;
        runner_id: string;
        kind: string;
      };
      const storedPayload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(storedPayload).not.toHaveProperty("resumeSessionId");
      expect(row.fingerprint).toBe(
        await fingerprintOf({
          commandId,
          runnerId: row.runner_id,
          kind: row.kind as "run.start",
          issuedAt: "",
          payload: storedPayload,
        }),
      );
      await expect(
        outbox.enqueue({
          commandId,
          runnerId: row.runner_id,
          kind: "run.start",
          issuedAt: new Date().toISOString(),
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          workspaceId: "workspace-1",
          payload: storedPayload,
          ...(row.payload_secure === null
            ? {}
            : { payloadSecure: JSON.parse(row.payload_secure) as unknown }),
          deliveryState: "queued",
          queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      subtle.digest = realDigest;
    }
  });
});

describe("scheduler cancel (§14.2)", () => {
  test("cancel enqueues a run.cancel addressed to the holding runner", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    const decision = await scheduler.cancel("run-1");

    expect(decision.ok).toBe(true);
    const rows = db
      .query(
        "SELECT kind, runner_id, run_id, attempt_id, session_id FROM command_outbox WHERE kind = 'run.cancel'",
      )
      .all();
    // The envelope carries the ids the runner's abort lookup needs — without
    // attemptId and runId the cancel reaches a runner that cannot find the run.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runner_id: "runner-a",
      run_id: "run-1",
      attempt_id: "attempt-1",
      session_id: "session-1",
    });
  });

  test("cancel delivery is part of the call, via the dispatch listener", async () => {
    const drained: string[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const scheduler = new Scheduler(db, {
      onDispatched: (runnerId) => drained.push(runnerId),
    });
    await scheduler.dispatch(request, capacity());

    await scheduler.cancel("run-1");

    // The start's drain happened on dispatch; the cancel needs its own, or it
    // sits in the outbox until the runner happens to reconnect.
    expect(drained).toEqual(["runner-a", "runner-a"]);
  });

  test("an unknown run is refused, not enqueued", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.cancel("run-nobody");

    expect(decision).toEqual({ ok: false, reason: "unknown_run" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 0 });
  });

  test("cancel keeps the active run — the terminal event releases it", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    await scheduler.cancel("run-1");

    // A cancel is a request, not an outcome (§14.2): the run keeps its slot
    // until the runner reports a terminal event, so a failed cancel cannot
    // wedge a second run onto a workspace that is still busy.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });
  });
});

describe("scheduler — rejected run.start frees the session slot (§9.4, §14.2)", () => {
  // Bug: Dispatcher.handleReceipt calls outbox.markRejected on a refused
  // run.start, but only scheduler.release() frees the active_runs row — and
  // release() was wired exclusively to terminal journal events
  // (run.finished / run.failed / run.interrupted in server.ts onEvents).
  //
  // A rejected start produces zero events, so release() was never called and
  // the active_runs row lived forever. The session was then permanently
  // `session_busy` and the runner slot was never reclaimed.
  //
  // Live proof in the field: two active_runs rows whose attempt_id matches a
  // rejected run.start row (delivery_state=rejected, rejection_reason=
  // unknown_workspace), with zero run_events for those attempts.
  //
  // Fix: Dispatcher.handleReceipt, on a rejected run.start, looks up the outbox
  // row and calls onRejectedStart(runId) → scheduler.release(runId). A rejected
  // start is terminal from the server's standpoint — only run.cancel rejections
  // must NOT release, because the original run may still execute (§14.2).

  /**
   * Simulates Dispatcher.handleReceipt's rejection path: marks the command
   * rejected, then — for a run.start — calls onRejectedStart so the slot is
   * freed. The Dispatcher lives in the control-server package and wires
   * onRejectedStart to scheduler.release; this helper mirrors that wiring.
   */
  function handleRejectedStart(
    outbox: CommandOutbox,
    scheduler: Scheduler,
    commandId: string,
    reason: string,
  ) {
    outbox.markRejected(commandId, reason);
    const row = outbox.get(commandId);
    if (row?.kind === "run.start" && row.runId !== undefined) {
      scheduler.release(row.runId);
    }
  }

  test("a runner rejection of run.start frees the slot so a second dispatch is not session_busy", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const outbox = new CommandOutbox(db);
    const scheduler = new Scheduler(db);

    const decision = await scheduler.dispatch(request, capacity());
    expect(decision).toMatchObject({ ok: true });

    // The session is pinned and a slot is held.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });

    const commandId = (decision as { commandId: string }).commandId;

    // The runner rejects run.start — exactly as Dispatcher.handleReceipt does
    // (apps/control-server/src/dispatch/dispatcher.ts). The outbox row is
    // retired and onRejectedStart fires, which calls scheduler.release(runId).
    handleRejectedStart(outbox, scheduler, commandId, "unknown_workspace");

    // The command is retired from delivery.
    expect(outbox.get(commandId)).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "unknown_workspace",
    });

    // The slot is freed: a rejected start is terminal from the server's
    // standpoint. A second dispatch on the same session should go through, not
    // 409 session_busy.
    expect(scheduler.activeRunFor("session-1")).toBeUndefined();

    const next = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );
    // The second dispatch must succeed: a rejected run.start is terminal from
    // the server's standpoint, so the slot should have been freed. Before the
    // fix this returned { ok: false, reason: "session_busy" }.
    expect(next).toMatchObject({ ok: true, runnerId: "runner-a" });
  });

  test("a runner cancellation rejection does NOT free the slot (§14.2)", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const outbox = new CommandOutbox(db);
    const scheduler = new Scheduler(db);

    await scheduler.dispatch(request, capacity());
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });

    // Dispatch a cancel command for the same run; the runner rejects it.
    // Dispatcher.handleReceipt must NOT call onRejectedStart for a run.cancel,
    // so the active run stays pinned until the terminal event arrives.
    const cancelDecision = await scheduler.cancel("run-1");
    expect(cancelDecision).toMatchObject({ ok: true });

    const commandId = (cancelDecision as { commandId: string }).commandId;

    // Simulate the rejection: markRejected is called, but onRejectedStart is
    // only invoked for run.start — a run.cancel rejection is skipped.
    outbox.markRejected(commandId, "cancelled");

    const row = outbox.get(commandId);
    // The dispatcher checks kind === "run.start" before calling onRejectedStart;
    // a run.cancel hits this branch and returns early, leaving the slot held.
    expect(row?.kind).toBe("run.cancel");

    // The slot is still held — the original run may still execute.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });
  });
});

describe("scheduler — sealSecurePayload (§18.1, P3-C Task 5b)", () => {
  test("with sealSecurePayload, the stored payloadSecure is the sealed value, not the cleartext object", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const sealed: Array<{ input: unknown; output: unknown }> = [];
    const scheduler = new Scheduler(db, {
      sealSecurePayload: (value) => {
        const s = `SEAL(${JSON.stringify(value)})`;
        sealed.push({ input: value, output: s });
        return s;
      },
    });

    const profileRequest = {
      ...request,
      profile: {
        profileId: "prof-1",
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN" as const,
        apiKey: "sk-secret-key",
        modelMapping: { sonnet: "prime" },
      },
    };

    await scheduler.dispatch(profileRequest, capacity());

    // The sealer was called with the cleartext payload.
    expect(sealed.length).toBe(1);
    const sealedInput = sealed[0]!.input as Record<string, unknown>;
    expect((sealedInput.profile as Record<string, unknown>).apiKey).toBe("sk-secret-key");

    // The stored payload_secure is the JSON-stringified output of the sealer,
    // not the original cleartext object. The sealer was called with the
    // cleartext payload (verified above); what is persisted is the sealer's
    // return value.
    const row = db
      .query("SELECT payload_secure FROM command_outbox WHERE run_id = ?")
      .get("run-1") as { payload_secure: string };
    const stored = JSON.parse(row.payload_secure) as string;
    expect(stored).toBe(sealed[0]!.output as string);
    expect(stored).toMatch(/^SEAL\(.*\)$/);
  });

  test("without a sealer a profile dispatch is refused and nothing is persisted", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const scheduler = new Scheduler(db);

    const profileRequest = {
      ...request,
      profile: {
        profileId: "prof-1",
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN" as const,
        apiKey: "sk-secret-key",
      },
    };

    // §18.1: the only durable copy of the cleartext payload is the sealed one.
    // Without a sealer the scheduler has no safe place to put the key, so the
    // dispatch is refused before anything is written — storing it cleartext
    // would put the credential on disk in plain sight.
    const decision = await scheduler.dispatch(profileRequest, capacity());
    expect(decision).toEqual({ ok: false, reason: "profile_secrets_unavailable" });

    // No command (which would later replay a cleartext or poisoned start), no
    // pin, no held slot.
    const rows = db.query("SELECT COUNT(*) AS n FROM command_outbox").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(scheduler.activeRunFor("session-1")).toBeUndefined();
  });

  test("the persisted payload redacts settings env values; the sealed copy keeps them", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const scheduler = new Scheduler(db, {
      sealSecurePayload: (value) => `SEAL(${JSON.stringify(value)})`,
    });

    const settings = {
      env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-env-secret" },
      permissions: { allow: ["Read"] },
    };
    await scheduler.dispatch(
      {
        ...request,
        profile: {
          profileId: "prof-1",
          name: "9Router",
          endpoint: "http://192.168.2.3:20128",
          authField: "ANTHROPIC_AUTH_TOKEN" as const,
          apiKey: "sk-secret-key",
          settings,
        },
      },
      capacity(),
    );

    const row = db
      .query("SELECT payload, payload_secure FROM command_outbox WHERE run_id = ?")
      .get("run-1") as { payload: string; payload_secure: string };
    const persisted = JSON.parse(row.payload) as {
      profile: { apiKey: string; settings: { env: Record<string, string> } };
    };
    expect(persisted.profile.apiKey).toBe("[REDACTED]");
    expect(persisted.profile.settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("[REDACTED]");
    expect(row.payload).not.toContain("sk-env-secret");
    // The non-secret settings stay readable in the record.
    expect(JSON.stringify(persisted.profile.settings)).toContain("Read");

    // The live frame is built from the sealed copy, so the runner still gets
    // the real value.
    const sealed = row.payload_secure.slice("SEAL(".length, -1);
    expect(sealed).toContain("sk-env-secret");
  });
});

describe("scheduler promote, release, and queued cancel (Task 3)", () => {
  test("promote admits a queued run when the session's slot frees", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity()); // run-1 admitted
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued
    expect(scheduler.release("run-1")).toBe("runner-a");

    expect(scheduler.promote("runner-a", capacity())).toEqual(["run-2"]);
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-2" });
    expect(
      db.query("SELECT delivery_state FROM command_outbox WHERE run_id = 'run-2'").get(),
    ).toEqual({ delivery_state: "pending" });
  });

  test("promotion is FIFO and skips an ineligible head", async () => {
    const { scheduler } = setup();
    const twoSlots = capacity({ maxConcurrentRuns: 2 });
    await scheduler.dispatch(request, scheduler.capacityFor("runner-a", twoSlots)); // run-1 admitted, session-1
    await scheduler.dispatch(
      {
        ...request,
        sessionId: "session-9",
        workspaceId: "workspace-9",
        runId: "run-9",
        attemptId: "attempt-9",
      },
      scheduler.capacityFor("runner-a", twoSlots),
    ); // capacity now full

    const full = capacity({ maxConcurrentRuns: 2, activeRuns: 2 });
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, full); // queued, session-1
    await scheduler.dispatch(
      {
        ...request,
        sessionId: "session-2",
        workspaceId: "workspace-2",
        runId: "run-3",
        attemptId: "attempt-3",
      },
      full,
    ); // queued, session-2

    // run-2 is older, but session-1 is still running run-1, so a freed slot must go to run-3.
    scheduler.release("run-9");
    expect(scheduler.promote("runner-a", twoSlots)).toEqual(["run-3"]);

    scheduler.release("run-1");
    expect(scheduler.promote("runner-a", twoSlots)).toEqual(["run-2"]);
  });

  test("promotion admits only as many runs as the freed slots allow", async () => {
    const { db, scheduler } = setup();
    const threeSlots = capacity({ maxConcurrentRuns: 3 });
    await scheduler.dispatch(request, scheduler.capacityFor("runner-a", threeSlots)); // session-1 / workspace-1, admitted
    await scheduler.dispatch(
      {
        ...request,
        sessionId: "session-2",
        workspaceId: "workspace-2",
        runId: "run-2",
        attemptId: "attempt-2",
      },
      scheduler.capacityFor("runner-a", threeSlots),
    ); // admitted
    await scheduler.dispatch(
      {
        ...request,
        sessionId: "session-3",
        workspaceId: "workspace-3",
        runId: "run-3",
        attemptId: "attempt-3",
      },
      scheduler.capacityFor("runner-a", threeSlots),
    ); // admitted, capacity now full
    const full = capacity({ maxConcurrentRuns: 3, activeRuns: 3 });
    for (const [index, session] of ["session-4", "session-5", "session-6"].entries()) {
      await scheduler.dispatch(
        {
          ...request,
          sessionId: session,
          workspaceId: `workspace-${index + 4}`,
          runId: `run-${index + 4}`,
          attemptId: `attempt-${index + 4}`,
        },
        full,
      );
    } // three queued
    const base = Date.now();
    db.query("UPDATE command_outbox SET created_at = ? WHERE run_id = 'run-4'").run(base);
    db.query("UPDATE command_outbox SET created_at = ? WHERE run_id = 'run-5'").run(base + 1);
    db.query("UPDATE command_outbox SET created_at = ? WHERE run_id = 'run-6'").run(base + 2);

    scheduler.release("run-1"); // one slot free, three candidates
    expect(scheduler.promote("runner-a", threeSlots)).toEqual(["run-4"]); // exactly one, not three
  });

  test("promotion skips a run whose workspace is busy", async () => {
    const { db, scheduler } = setup();
    // Sessions 1 and 2 both pinned to workspace-1, capacity 2.
    await scheduler.dispatch(request, capacity({ maxConcurrentRuns: 2 })); // run-1 admitted, workspace-1
    await scheduler.dispatch(
      { ...request, sessionId: "session-2", runId: "run-2", attemptId: "attempt-2" },
      capacity({ maxConcurrentRuns: 2 }),
    ); // queued: another session, same workspace

    expect(scheduler.promote("runner-a", capacity({ maxConcurrentRuns: 2 }))).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
  });

  test("promotion admits nothing while the runner is not ready", () => {
    const { scheduler } = setup();
    expect(scheduler.promote("runner-a", capacity({ state: "offline" }))).toEqual([]);
    expect(scheduler.promote("runner-a", capacity({ state: "connected" }))).toEqual([]);
  });

  test("promoting twice admits a queued run once", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity()); // run-1 admitted
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued
    scheduler.release("run-1");

    expect(scheduler.promote("runner-a", capacity())).toEqual(["run-2"]);
    expect(scheduler.promote("runner-a", capacity())).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM active_runs WHERE run_id = 'run-2'").get()).toEqual({
      n: 1,
    });
  });

  test("a fresh scheduler promotes durable queue state after a restart", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity());
    scheduler.release("run-1");

    const restarted = new Scheduler(db); // same database, new in-memory state
    expect(restarted.promote("runner-a", capacity())).toEqual(["run-2"]);
  });

  test("cancelling a queued run retires it without touching the runner", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity()); // run-1 admitted
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued

    expect(await scheduler.cancel("run-2")).toEqual({ ok: true, queued: true });
    expect(
      db
        .query("SELECT delivery_state, rejection_reason FROM command_outbox WHERE run_id = 'run-2'")
        .get(),
    ).toEqual({ delivery_state: "rejected", rejection_reason: "cancelled" });
    expect(
      db.query("SELECT COUNT(*) AS n FROM command_outbox WHERE kind = 'run.cancel'").get(),
    ).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
  });

  test("another owner cannot cancel this run", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity());

    expect(await scheduler.cancel("run-2", { ownerId: "user-2" })).toEqual({
      ok: false,
      reason: "unknown_run",
    });
    expect(await scheduler.cancel("run-2", { ownerId: "user-1" })).toEqual({
      ok: true,
      queued: true,
    });
  });

  test("cancelling an active run is unchanged and carries its command id", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());
    const decision = await scheduler.cancel("run-1");
    expect(decision).toMatchObject({ ok: true, queued: false });
    if (!decision.ok || decision.queued) throw new Error("expected an admitted active-run cancel");
    expect(decision.commandId).toMatch(/^cmd_/);
  });
});
