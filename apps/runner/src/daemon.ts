/**
 * Runner daemon composition (§3.3, §6.2, §11.1).
 *
 * Reads the persisted identity, opens the local database, dials the control
 * server, and runs the reconnect loop until stopped. The credential never leaves
 * this process except as the `Authorization` header on the upgrade (§6.2).
 *
 * The command path is deliberately thin: `onCommand` calls `handleCommand`,
 * which persists to the inbox and returns the receipt. That order — persist,
 * then answer — is what makes the server's at-least-once delivery safe, so it
 * lives in one tested function rather than being open-coded here.
 *
 * Deliberately no retry logic here: that lives in `ReconnectLoop`, which is
 * tested. This file is the part that cannot be tested without a real machine —
 * reading files and wiring objects together.
 */

import { Database } from "bun:sqlite";
import { PROTOCOL_VERSION } from "@cc-web/protocol";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { ReconnectLoop, type RunnerInventoryItem } from "./connection/reconnect-loop.ts";
import { dialWebSocket } from "./connection/websocket-link.ts";
import { handleCommand } from "./execution/command-handler.ts";
import { loadIdentity, type RunnerIdentity } from "./identity/identity-store.ts";

export type DaemonOptions = {
  identityDir: string;
  runnerVersion: string;
  sdkVersion: string;
  /** Override for tests; defaults to `<identityDir>/runner.db`. */
  databasePath?: string;
  /** Runs this runner currently believes are in flight (§14.3). */
  inventory?: () => RunnerInventoryItem[];
  /**
   * Called for a command the runner accepted, after it is durable. Execution
   * itself is not built yet (§10); the daemon logs the acceptance so the
   * delivered-not-executed state is visible rather than silent.
   */
  onAccepted?: (command: unknown) => void;
  onEvent?: (event: unknown) => void;
};

export type Daemon = {
  loop: ReconnectLoop;
  identity: RunnerIdentity;
  /** The local database, exposed so callers can inspect stored receipts. */
  db: Database;
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

  const db = new Database(options.databasePath ?? `${options.identityDir}/runner.db`);
  // Idempotent, so a crash during an earlier migration is not a boot loop.
  migrateRunnerDb(db);

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
    onCommand: async (command) => {
      const result = handleCommand(db, command, { localRunnerId: identity.runnerId });

      // Only a first acceptance is new work. A redelivery returns the stored
      // receipt and reaches here with `execute: false`, which is what stops the
      // same run from being started twice (§9.3).
      if (result.execute) options.onAccepted?.(command);

      return result.receipt;
    },
  });

  await loop.start();

  return {
    loop,
    identity,
    db,
    stop: () => {
      loop.stop();
      db.close();
    },
  };
}

/** One id per process start; a restart is a new boot. */
const BOOT_ID = crypto.randomUUID();
function bootId(): string {
  return BOOT_ID;
}
