/**
 * What the runner does with an incoming command (§9.3, §9.4).
 *
 * The order is the design:
 *
 *   1. validate the envelope
 *   2. persist to the inbox — this is what makes a redelivery harmless
 *   3. answer with a receipt
 *   4. only then hand it to the executor
 *
 * A receipt sent before the commit would promise durable acceptance for
 * something a crash can still erase, and the server would stop redelivering a
 * command nobody has. The reverse mistake — executing before acknowledging — is
 * invisible until the first duplicate, at which point the work runs twice.
 *
 * Refusals are answered with a receipt too. Silence would leave the command
 * pending on the server forever, and the operator would see a run that was never
 * going to start.
 */

import type { Database } from "bun:sqlite";
import { acceptCommand, type CommandEnvelope } from "@cc-web/runner-db";

export type CommandReceipt = {
  commandId: string;
  attemptId: string;
  accepted: boolean;
  reason?: string;
};

export type HandleResult = {
  receipt: CommandReceipt;
  /** True only for a first acceptance: the caller must not run a duplicate. */
  execute: boolean;
};

export type HandleOptions = {
  /** The runner's own id; a command addressed elsewhere is refused (§9.3). */
  localRunnerId: string;
  now?: number;
};

export function handleCommand(db: Database, raw: unknown, options: HandleOptions): HandleResult {
  const parsed = asEnvelope(raw);
  if (!parsed) {
    // Enough of the envelope to answer, even when the rest is unusable. A
    // receipt without a command id cannot be matched, so an anonymous
    // malformed frame gets a placeholder the caller is expected to log.
    return {
      receipt: {
        commandId: typeof raw === "object" && raw !== null ? String(idOf(raw)) : "",
        attemptId: "",
        accepted: false,
        reason: "malformed",
      },
      execute: false,
    };
  }

  const accepted = acceptCommand(db, parsed, {
    localRunnerId: options.localRunnerId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (!accepted.ok) {
    return {
      receipt: {
        commandId: parsed.commandId,
        attemptId: parsed.attemptId ?? "",
        accepted: false,
        reason: accepted.reason,
      },
      execute: false,
    };
  }

  return {
    receipt: {
      commandId: parsed.commandId,
      attemptId: parsed.attemptId ?? "",
      accepted: true,
    },
    // A duplicate is already in the inbox: its work is either running or done,
    // and either way this call must not start it again.
    execute: !accepted.duplicate,
  };
}

function idOf(value: unknown): unknown {
  const record = value as Record<string, unknown>;
  return typeof record["commandId"] === "string" ? record["commandId"] : "";
}

function asEnvelope(value: unknown): CommandEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const commandId = record["commandId"];
  const runnerId = record["runnerId"];
  const kind = record["kind"];
  const issuedAt = record["issuedAt"];
  const protocolVersion = record["protocolVersion"];

  if (
    typeof commandId !== "string" ||
    commandId === "" ||
    typeof runnerId !== "string" ||
    runnerId === "" ||
    typeof kind !== "string" ||
    kind === "" ||
    typeof issuedAt !== "string" ||
    typeof protocolVersion !== "number"
  ) {
    return undefined;
  }

  const envelope: CommandEnvelope = {
    protocolVersion,
    commandId,
    runnerId,
    kind,
    issuedAt,
    payload: record["payload"],
  };

  // Optional fields are copied only when they are the expected type, so a
  // malformed value becomes "absent" rather than a value the inbox would store
  // and later trust.
  for (const key of ["expiresAt", "sessionId", "runId", "attemptId", "workspaceId"] as const) {
    const field = record[key];
    if (typeof field === "string") envelope[key] = field;
  }
  if (typeof record["assignmentEpoch"] === "number") {
    envelope.assignmentEpoch = record["assignmentEpoch"];
  }

  return envelope;
}
