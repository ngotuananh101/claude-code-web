import type { RpcResultFrame } from "@cc-web/protocol";

/** How long an HTTP caller waits for a runner's `rpc.result` before giving up. */
export const RPC_WAIT_MS = 10_000;

export type PendingRpcRequestsOptions = {
  timeoutMs?: number;
  /** Timer seam, so tests can advance a virtual clock instead of sleeping. */
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
};

type Waiter = {
  resolve: (frame: RpcResultFrame) => void;
  reject: (error: { code: string }) => void;
  timer: unknown;
};

/**
 * Waiters for bounded RPC calls, keyed by command id.
 *
 * In memory on purpose (Ruling 3): the waiter IS the HTTP request, and that
 * request cannot outlive the process, so persisting a pending request would
 * only leave rows nobody will ever answer. A frame that arrives with no waiter
 * is dropped rather than treated as an error — the caller may have timed out
 * a millisecond earlier, and that race is expected.
 */
export class PendingRpcRequests {
  readonly #timeoutMs: number;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #unschedule: (handle: unknown) => void;
  readonly #waiters = new Map<string, Waiter>();

  constructor(options: PendingRpcRequestsOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? RPC_WAIT_MS;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.#unschedule =
      options.unschedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  register(commandId: string): Promise<RpcResultFrame> {
    // A second waiter on one command id would be answered by the same frame,
    // and the first would hang until the timeout. Failing it loudly keeps the
    // bug visible at the call site instead of as a mystery timeout.
    this.reject(commandId, "DUPLICATE_COMMAND_ID");

    return new Promise<RpcResultFrame>((resolve, reject) => {
      const timer = this.#schedule(() => {
        this.#waiters.delete(commandId);
        reject({ code: "RUNNER_UNAVAILABLE" });
      }, this.#timeoutMs);

      this.#waiters.set(commandId, { resolve, reject, timer });
    });
  }

  /** Answers a waiting request. Returns false when nobody was waiting. */
  settle(frame: RpcResultFrame): boolean {
    const waiter = this.#take(frame.commandId);
    if (waiter === undefined) return false;
    waiter.resolve(frame);
    return true;
  }

  /** Fails a waiting request with a wire error code. False when nobody waited. */
  reject(commandId: string, code: string): boolean {
    const waiter = this.#take(commandId);
    if (waiter === undefined) return false;
    waiter.reject({ code });
    return true;
  }

  size(): number {
    return this.#waiters.size;
  }

  #take(commandId: string): Waiter | undefined {
    const waiter = this.#waiters.get(commandId);
    if (waiter === undefined) return undefined;
    this.#waiters.delete(commandId);
    this.#unschedule(waiter.timer);
    return waiter;
  }
}
