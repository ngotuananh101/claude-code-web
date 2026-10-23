/**
 * Parsing an untrusted frame into a command envelope (§9.1, §9.3).
 *
 * Everything on the socket is untrusted, and this is the one place it becomes
 * typed. The rule that matters: an optional field is copied only when it is the
 * expected type. A malformed value becomes "absent" — a state the inbox already
 * understands — rather than a value it would store and later trust.
 */

import type { CommandEnvelope } from "@cc-web/runner-db";

export function asCommandEnvelope(value: unknown): CommandEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const { commandId, runnerId, kind, issuedAt, protocolVersion } = record;
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

  for (const key of ["expiresAt", "sessionId", "runId", "attemptId", "workspaceId"] as const) {
    const field = record[key];
    if (typeof field === "string") envelope[key] = field;
  }
  if (typeof record["assignmentEpoch"] === "number") {
    envelope.assignmentEpoch = record["assignmentEpoch"];
  }

  return envelope;
}

/** The command id, if the frame carries one — enough to answer a refusal. */
export function commandIdOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const id = (value as Record<string, unknown>)["commandId"];
  return typeof id === "string" ? id : "";
}
