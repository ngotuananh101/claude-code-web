/**
 * The seam between the inbox and the executor (§9.3, §10.1).
 *
 * `handleCommand` answers the receipt. This module decides what happens next,
 * and it is the only place where the two facts that make execution safe meet:
 * the inbox says "first delivery", and the attempt table says "workspace free".
 * Splitting those across call sites is how a delivery eventually gets run twice.
 *
 * Shutdown is explicit. A fire-and-forget `void executeRun(...)` would let
 * `stop()` close the database underneath a run that is still writing events, so
 * every in-flight run is tracked and `settle()` waits for them.
 */

import type { Database } from "bun:sqlite";
import {
  acceptCommand,
  beginAttempt,
  type CommandEnvelope,
  recoverStaleAttempts,
} from "@cc-web/runner-db";
import { asCommandEnvelope, commandIdOf } from "./envelope.ts";
import { executeRun, type SdkStream } from "./executor.ts";

export type CommandReceipt = {
  commandId: string;
  attemptId: string;
  accepted: boolean;
  reason?: string;
};

export type ControllerOptions = {
  db: Database;
  localRunnerId: string;
  /** Resolves a workspace id to its canonical path, or undefined if unregistered. */
  workspacePathFor: (workspaceId: string) => string | undefined;
  sdk: SdkStream;
  /** Injected clock, so expiry is testable without waiting for it. */
  now?: () => number;
};

export class RunController {
  readonly #db: Database;
  readonly #localRunnerId: string;
  readonly #workspacePathFor: (workspaceId: string) => string | undefined;
  readonly #sdk: SdkStream;
  readonly #now: () => number;

  /** Every run in flight, so shutdown can wait rather than guess. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: ControllerOptions) {
    this.#db = options.db;
    this.#localRunnerId = options.localRunnerId;
    this.#workspacePathFor = options.workspacePathFor;
    this.#sdk = options.sdk;
    this.#now = options.now ?? Date.now;

    // §9.7: whatever was in flight when the previous process died is
    // interrupted, not resumed. Doing it here means it happens before the first
    // command can be accepted, not some time later.
    recoverStaleAttempts(this.#db);
  }

  async handle(command: unknown): Promise<CommandReceipt> {
    const parsed = asCommandEnvelope(command);
    if (parsed === undefined) {
      return {
        commandId: commandIdOf(command),
        attemptId: "",
        accepted: false,
        reason: "malformed",
      };
    }

    const accepted = acceptCommand(this.#db, parsed, {
      localRunnerId: this.#localRunnerId,
      now: this.#now(),
    });
    if (!accepted.ok) {
      return {
        commandId: parsed.commandId,
        attemptId: parsed.attemptId ?? "",
        accepted: false,
        reason: accepted.reason,
      };
    }

    // A duplicate is already in the inbox and its work is running or done.
    // Answering from the stored state is the whole point (§9.3).
    if (accepted.duplicate) {
      return receipt(parsed, true);
    }

    const attemptId = parsed.attemptId ?? parsed.commandId;
    const workspacePath =
      parsed.workspaceId === undefined ? undefined : this.#workspacePathFor(parsed.workspaceId);

    if (workspacePath === undefined) {
      // Refusing here — before an attempt row exists — leaves nothing for
      // reconciliation to explain. The command stays accepted in the inbox,
      // which is honest: it was delivered, it just cannot run on this host.
      return { ...receipt(parsed, false), reason: "unknown_workspace" };
    }

    const begun = beginAttempt(this.#db, {
      attemptId,
      sessionId: parsed.sessionId ?? "",
      runId: parsed.runId ?? "",
      workspacePath,
      now: this.#now(),
    });

    if (!begun.ok) {
      return {
        ...receipt(parsed, false),
        reason: begun.reason === "workspace_locked" ? "workspace_busy" : "attempt_exists",
      };
    }

    // The attempt is recorded, so the run is now this process's responsibility.
    // Tracked rather than awaited: the receipt must not wait for a run that can
    // take minutes (§9.4 — accepted is not started).
    const run = executeRun(this.#db, parsed, { workspacePath, sdk: this.#sdk })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight.delete(run);
      });
    this.#inFlight.add(run);

    return receipt(parsed, true);
  }

  /** Resolves when no run is in flight. Used before closing the database. */
  async settle(): Promise<void> {
    // A run can finish and release another; follow the set until it is empty.
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
  }
}

function receipt(command: CommandEnvelope, accepted: boolean): CommandReceipt {
  return {
    commandId: command.commandId,
    attemptId: command.attemptId ?? "",
    accepted,
  };
}
