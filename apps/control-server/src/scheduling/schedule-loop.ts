/**
 * The scheduling tick (§11.5, spec §5.4).
 *
 * The control server owns the clock: every `intervalMs` (15s by default) it
 * reads the active rows whose `next_fire_at` has passed and turns each into an
 * ordinary `run.start` — same capacity, same lock, same session pin as a
 * user-started run. Nothing here special-cases the runner's executor; a
 * scheduled run is a normal turn whose `run.started` carries `scheduleId`.
 *
 * Two guards keep one slot from firing twice, and their order matters:
 *
 *  1. If the origin attempt is still active, its in-process CLI timer may
 *     still fire — the server yields this slot to it.
 *  2. The run id is deterministic per slot, and `runKnown` checks every table
 *     a dispatch would touch, so a crash between dispatch and advance cannot
 *     fire the same slot again on the next boot.
 */

import type { Database } from "bun:sqlite";
import {
  advanceSchedule,
  computeNextFire,
  dueSchedules,
  type RunnerState,
  runKnown,
  type ScheduleRecord,
  type Scheduler,
  sessionPin,
  workspacesForOwner,
} from "@cc-web/control-db";

export type ScheduleTickOptions = {
  db: Database;
  scheduler: Scheduler;
  /** The live view of each runner; only `stateOf` is needed to build capacity. */
  runnerGateway: { stateOf(runnerId: string): RunnerState };
  now?: () => number;
  log?: (message: string) => void;
};

export type ScheduleLoopOptions = ScheduleTickOptions & { intervalMs?: number };

const DEFAULT_INTERVAL_MS = 15_000;

/** One pass over every due row. A failure in one row never stops the others. */
export async function runScheduleTick(options: ScheduleTickOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.warn(message));

  for (const row of dueSchedules(options.db, now())) {
    try {
      await fireSchedule(options, row, now(), log);
    } catch (error) {
      log(`scheduled-tasks: tick failed for ${row.scheduleId}: ${String(error)}`);
    }
  }
}

async function fireSchedule(
  options: ScheduleTickOptions,
  row: ScheduleRecord,
  firedAt: number,
  log: (message: string) => void,
): Promise<void> {
  const { db, scheduler, runnerGateway } = options;

  const pin = sessionPin(db, row.sessionId);
  if (pin === undefined) {
    // The session row is gone: there is no runner to fire on and no owner to
    // ask. Keep the row as a tombstone rather than retrying forever.
    advanceSchedule(db, row.scheduleId, { state: "orphaned" });
    return;
  }

  const active = scheduler.activeRunFor(row.sessionId);
  if (active?.attemptId === row.originAttemptId) {
    advance(db, row, firedAt, log);
    return;
  }

  const runId = `run_sched_${row.scheduleId}_${row.nextFireAt}`;
  if (runKnown(db, runId)) {
    advance(db, row, firedAt, log);
    return;
  }

  const workspacePath = workspacesForOwner(db, pin.ownerId).find(
    (workspace) => workspace.workspaceId === pin.workspaceId && workspace.runnerId === pin.runnerId,
  )?.path;
  const state = runnerGateway.stateOf(pin.runnerId);
  const decision = await scheduler.dispatch(
    {
      sessionId: row.sessionId,
      runId,
      attemptId: crypto.randomUUID(),
      workspaceId: pin.workspaceId,
      prompt: row.prompt,
      ownerId: pin.ownerId,
      scheduleId: row.scheduleId,
      scheduleCron: row.cron,
      ...(workspacePath === undefined ? {} : { workspacePath }),
    },
    scheduler.capacityFor(pin.runnerId, {
      runnerId: pin.runnerId,
      state,
      maxConcurrentRuns: 1,
      activeRuns: 0,
    }),
  );

  // A refusal (offline, not ready, at capacity, session busy) means "not now":
  // the row stays due exactly as it is, and the next tick retries it.
  if (decision.ok) advance(db, row, firedAt, log);
}

/**
 * Move a row past the slot that just fired. A one-shot finishes; a recurring
 * one moves to the next slot after the one it fired (no catch-up of missed
 * slots, per the design's non-goals). A cron that stopped parsing is not
 * retried forever — the row is cancelled and the log says why.
 */
function advance(
  db: Database,
  row: ScheduleRecord,
  firedAt: number,
  log: (message: string) => void,
): void {
  if (!row.recurring) {
    advanceSchedule(db, row.scheduleId, { state: "done", lastFiredAt: firedAt });
    return;
  }

  const next = computeNextFire(row.cron, row.timezone, Math.max(firedAt, row.nextFireAt) + 1);
  if (next === undefined) {
    log(
      `scheduled-tasks: cron "${row.cron}" in ${row.timezone} no longer parses; cancelling ${row.scheduleId}`,
    );
    advanceSchedule(db, row.scheduleId, { state: "cancelled" });
    return;
  }

  advanceSchedule(db, row.scheduleId, {
    state: "active",
    nextFireAt: next,
    lastFiredAt: firedAt,
  });
}

/**
 * Start the interval. The first tick fires immediately, and a tick that is
 * still running makes the next interval skip — a slow dispatch must not stack
 * passes on the same rows.
 */
export function startScheduleLoop(options: ScheduleLoopOptions): { stop(): void } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.warn(message));
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    void runScheduleTick(options)
      .catch((error) => log(`scheduled-tasks: tick threw: ${String(error)}`))
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}
