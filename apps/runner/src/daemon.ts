/**
 * Runner daemon composition (§3.3, §6.2, §11.1).
 *
 * Reads the persisted identity, dials the control server, and runs the
 * reconnect loop until stopped. The credential never leaves this process except
 * as the `Authorization` header on the upgrade (§6.2).
 *
 * Deliberately no retry logic here: that lives in `ReconnectLoop`, which is
 * tested. This file is the part that cannot be tested without a real machine —
 * reading a file and wiring two objects together.
 */

import { loadIdentity, type RunnerIdentity } from "./identity/identity-store.ts";
import { ReconnectLoop, type RunnerInventoryItem } from "./connection/reconnect-loop.ts";
import { dialWebSocket } from "./connection/websocket-link.ts";
import { PROTOCOL_VERSION } from "@cc-web/protocol";

export type DaemonOptions = {
  identityDir: string;
  runnerVersion: string;
  sdkVersion: string;
  /** Runs this runner currently believes are in flight (§14.3). */
  inventory?: () => RunnerInventoryItem[];
  onEvent?: (event: unknown) => void;
};

export type Daemon = {
  loop: ReconnectLoop;
  identity: RunnerIdentity;
  stop(): void;
};

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const loaded = await loadIdentity(options.identityDir);
  if (!loaded.ok) {
    // A missing or partial identity is an operator problem; retrying would only
    // obscure it.
    throw new Error(`cannot start runner: identity ${loaded.reason} in ${options.identityDir}`);
  }

  const identity = loaded.identity;

  const loop = new ReconnectLoop({
    runnerId: identity.runnerId,
    dial: () =>
      dialWebSocket({
        url: identity.controlUrl,
        credential: identity.credential,
      }),
    hello: () => ({
      protocolVersion: PROTOCOL_VERSION,
      runnerId: identity.runnerId,
      // Stable for the process lifetime: a reconnect from the same process is
      // the same boot, and the server uses the generation, not this, to fence.
      bootId: bootId(),
      runnerVersion: options.runnerVersion,
      sdkVersion: options.sdkVersion,
      platform: `${process.platform}/${process.arch}`,
      maxConcurrentRuns: 1,
      activeRuns: [],
      eventOffsets: [],
    }),
    inventory: options.inventory ?? (() => []),
    sleep: (ms) => Bun.sleep(ms),
    onEvent: (event) => options.onEvent?.(event),
  });

  await loop.start();

  return {
    loop,
    identity,
    stop: () => loop.stop(),
  };
}

/** One id per process start; a restart is a new boot. */
const BOOT_ID = crypto.randomUUID();
function bootId(): string {
  return BOOT_ID;
}
