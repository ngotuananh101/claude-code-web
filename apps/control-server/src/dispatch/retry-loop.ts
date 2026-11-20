import type { CommandOutbox } from "@cc-web/control-db";

export type RetryTickOptions = {
  outbox: CommandOutbox;
  promoteRunner: (runnerId: string) => void;
  log?: (message: string) => void;
};

/** Revisit queued starts so cancelling a cooldown anchor cannot strand its siblings. */
export function runRetryTick(options: RetryTickOptions): void {
  const log = options.log ?? ((message: string) => console.warn(message));
  for (const runnerId of options.outbox.runnersWithQueuedStarts()) {
    try {
      // Re-enter normal admission: a due deadline is not permission to bypass
      // readiness, negotiated capacity, session ownership, or workspace locks.
      options.promoteRunner(runnerId);
    } catch (error) {
      log(`run-retry: promotion failed for ${runnerId}: ${String(error)}`);
    }
  }
}

/** Persisted deadlines survive restart; this loop owns only the wakeup, not queue state. */
export function startRetryLoop(options: RetryTickOptions & { intervalMs?: number }): {
  stop(): void;
} {
  const log = options.log ?? ((message: string) => console.warn(message));
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      runRetryTick(options);
    } catch (error) {
      log(`run-retry: tick failed: ${String(error)}`);
    }
  };
  const timer = setInterval(tick, options.intervalMs ?? 1_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
