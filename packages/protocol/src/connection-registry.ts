/**
 * Connection generation registry (§6.3).
 *
 * Purpose: make it impossible for a superseded socket to affect state. When a
 * Runner reconnects, the old socket may still be alive — half-open, buffering,
 * or in another process entirely after an identity clone. Every inbound message
 * must be checked against the current generation before it is applied.
 *
 * Generations are per runner and monotonic. A message claiming a generation the
 * server never issued (future or unknown) is rejected, not treated as newer.
 */

export type OpenParams = {
  runnerId: string;
  bootId: string;
  connectionId: string;
};

export type OpenResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "revoked" };

export type TrafficCheck =
  | { ok: true }
  | { ok: false; reason: "unknown_runner" | "stale_generation" | "unknown_generation" };

type CurrentConnection = {
  connectionId: string;
  generation: number;
  bootId: string;
};

export class ConnectionRegistry {
  #current = new Map<string, CurrentConnection>();
  #lastGeneration = new Map<string, number>();
  #revoked = new Set<string>();

  open(params: OpenParams): OpenResult {
    if (this.#revoked.has(params.runnerId)) {
      return { ok: false, reason: "revoked" };
    }

    const generation = (this.#lastGeneration.get(params.runnerId) ?? 0) + 1;

    // The previous connection is fenced by overwriting the current entry: any
    // message still carrying its generation now fails the check below.
    this.#current.set(params.runnerId, {
      connectionId: params.connectionId,
      generation,
      bootId: params.bootId,
    });
    this.#lastGeneration.set(params.runnerId, generation);

    return { ok: true, generation };
  }

  checkTraffic(params: {
    runnerId: string;
    connectionId: string;
    generation: number;
  }): TrafficCheck {
    if (this.#revoked.has(params.runnerId)) {
      return { ok: false, reason: "stale_generation" };
    }

    const current = this.#current.get(params.runnerId);
    if (!current) {
      // Distinguish "never seen" from "seen and superseded": they lead to
      // different operator actions.
      const seenBefore = this.#lastGeneration.has(params.runnerId);
      return { ok: false, reason: seenBefore ? "stale_generation" : "unknown_runner" };
    }

    if (params.generation !== current.generation) {
      // A future generation is as invalid as a past one. Accepting either would
      // let a forged claim take over the identity.
      return {
        ok: false,
        reason: params.generation < current.generation ? "stale_generation" : "unknown_generation",
      };
    }

    if (params.connectionId !== current.connectionId) {
      return { ok: false, reason: "stale_generation" };
    }

    return { ok: true };
  }

  isCurrent(runnerId: string, connectionId: string, generation: number): boolean {
    return this.checkTraffic({ runnerId, connectionId, generation }).ok;
  }

  current(runnerId: string): CurrentConnection | undefined {
    return this.#current.get(runnerId);
  }

  close(params: { runnerId: string; connectionId: string; generation: number }): void {
    const current = this.#current.get(params.runnerId);
    // Guard on identity: a late close from the old socket must not evict the
    // connection that replaced it.
    if (
      current &&
      current.connectionId === params.connectionId &&
      current.generation === params.generation
    ) {
      this.#current.delete(params.runnerId);
    }
  }

  revoke(runnerId: string): void {
    this.#revoked.add(runnerId);
    this.#current.delete(runnerId);
  }

  isRevoked(runnerId: string): boolean {
    return this.#revoked.has(runnerId);
  }
}
