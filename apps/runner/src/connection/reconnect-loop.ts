/**
 * The Runner's connection loop (§6.2, §11.1, §14.3).
 *
 * Every connect runs the same sequence, and the order is not negotiable:
 *
 *   dial → hello → hello.ok → reconcile → reconcile.ok → ready
 *
 * `reconcile` is only sent after `hello.ok`, because the server refuses it
 * before negotiation. Sending it early would make the loop retry against its own
 * bug.
 *
 * Two close codes end the loop rather than triggering a retry, and both are
 * signals that retrying cannot help:
 *
 *  - **4000** (`superseded`): another connection took this runner's identity.
 *    Reconnecting would fight its own replacement.
 *  - **4001** (`revoked`): the credential is dead. Retrying hammers the server
 *    and never succeeds.
 *
 * Everything else retries with exponential backoff, capped and reset on success.
 * The cap matters: without it a long outage pushes the next attempt past any
 * useful interval, and the runner stays offline after the server recovers.
 *
 * `dial` and `sleep` are injected so the backoff can be tested without waiting.
 */

export type Link = {
  send(payload: string): unknown;
  close(): unknown;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: (code: number) => void): void;
};

export type LoopState =
  | "idle"
  | "connecting"
  | "ready"
  | "blocked"
  | "revoked"
  | "superseded"
  | "stopped";

export type LoopEvent =
  | { type: "connected"; generation: number }
  | { type: "ready" }
  | { type: "blocked"; reason: string }
  | { type: "disconnected"; code: number; retryInMs: number }
  | { type: "revoked" }
  | { type: "superseded" }
  | { type: "error"; reason: string };

export type RunnerInventoryItem = {
  runId: string;
  attemptId: string;
  state: string;
  processAlive?: boolean;
  approvalsAlive?: boolean;
  commandReceiptId?: string;
};

export type ReconnectLoopOptions = {
  runnerId: string;
  dial: () => Promise<Link>;
  hello: () => Record<string, unknown>;
  inventory: () => RunnerInventoryItem[];
  sleep: (ms: number) => Promise<void>;
  onEvent: (event: LoopEvent) => void;
  maxAttempts?: number;
};

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

/** Close codes that mean "do not reconnect" rather than "try again". */
const CLOSE_SUPERSEDED = 4000;
const CLOSE_REVOKED = 4001;

export class ReconnectLoop {
  readonly #options: ReconnectLoopOptions;
  #state: LoopState = "idle";
  #link: Link | undefined;
  #stopped = false;
  #backoffMs = INITIAL_BACKOFF_MS;
  #settled: Promise<void> = Promise.resolve();

  constructor(options: ReconnectLoopOptions) {
    this.#options = options;
  }

  get state(): LoopState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    // Only the first attempt is awaited. Startup must not be hostage to the
    // network: a runner whose control server is down still has to come up, log
    // why it is not connected, and keep trying. The retry chain lives in
    // `#settled`, so `settle()` can still observe it.
    await this.#attempt();
  }

  /** Resolves once no reconnect is in flight. Used by tests and shutdown. */
  async settle(): Promise<void> {
    // A retry can schedule another retry, so one await is not enough: follow
    // the chain until it stops being replaced.
    for (;;) {
      const current = this.#settled;
      await current;
      if (current === this.#settled) return;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#state = "stopped";
    try {
      this.#link?.close();
    } catch {
      // Already closed.
    }
  }

  async #attempt(): Promise<void> {
    if (this.#stopped) return;

    this.#state = "connecting";

    let link: Link;
    try {
      link = await this.#options.dial();
    } catch {
      this.#startRetry(0);
      return;
    }

    this.#link = link;

    link.onMessage((raw) => this.#handleMessage(raw));
    link.onClose((code) => {
      this.#handleClose(code);
    });

    link.send(JSON.stringify({ type: "hello", hello: this.#options.hello() }));
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;

    const record = message as Record<string, unknown>;

    switch (record["type"]) {
      case "hello.ok": {
        const generation = typeof record["generation"] === "number" ? record["generation"] : 0;
        this.#options.onEvent({ type: "connected", generation });

        // §14.3: reconciliation is what promotes `connected` to `ready`. It is
        // sent only now, because the server refuses it before negotiation.
        this.#link?.send(
          JSON.stringify({ type: "reconcile", runner: this.#options.inventory() }),
        );
        return;
      }

      case "reconcile.ok": {
        this.#state = "ready";
        // A successful connection resets the backoff; keeping the escalated
        // value would punish a healthy runner for an old outage.
        this.#backoffMs = INITIAL_BACKOFF_MS;
        this.#options.onEvent({ type: "ready" });
        return;
      }

      case "reconcile.blocked": {
        const reason = typeof record["reason"] === "string" ? record["reason"] : "unknown";
        // The connection stays open but the runner is not dispatchable. It must
        // not claim `ready`, or work lands on state neither side can vouch for.
        this.#state = "blocked";
        this.#options.onEvent({ type: "blocked", reason });
        return;
      }

      case "error": {
        this.#options.onEvent({
          type: "error",
          reason: typeof record["reason"] === "string" ? record["reason"] : "unknown",
        });
        return;
      }

      default:
        return;
    }
  }

  #handleClose(code: number): void {
    if (this.#stopped) return;

    if (code === CLOSE_REVOKED) {
      this.#state = "revoked";
      this.#options.onEvent({ type: "revoked" });
      return;
    }

    if (code === CLOSE_SUPERSEDED) {
      this.#state = "superseded";
      this.#options.onEvent({ type: "superseded" });
      return;
    }

    this.#startRetry(code);
  }

  /**
   * Begin a retry without waiting for it. The chain is tracked in `#settled` so
   * `settle()` can follow it, but nothing on the message/close path blocks on a
   * backoff — a socket callback that awaited thirty seconds would keep the
   * process from doing anything else.
   */
  #startRetry(code: number): void {
    if (this.#stopped) return;

    const delay = this.#backoffMs;
    this.#options.onEvent({ type: "disconnected", code, retryInMs: delay });

    const chain = (async () => {
      await this.#options.sleep(delay);
      if (this.#stopped) return;

      // Escalate for the next attempt. Capped so a long outage does not push
      // the next try past any useful interval.
      this.#backoffMs = Math.min(this.#backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);

      this.#attemptCount += 1;
      if (this.#options.maxAttempts !== undefined && this.#attemptCount >= this.#options.maxAttempts) {
        this.#state = "stopped";
        return;
      }

      await this.#attempt();
    })();

    // Assign before awaiting: a retry scheduled from inside this one replaces
    // the entry, and `settle()` uses identity to know it has reached the end.
    this.#settled = chain;
  }

  #attemptCount = 0;
}
