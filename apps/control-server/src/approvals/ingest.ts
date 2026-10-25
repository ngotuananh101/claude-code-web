import type { Database } from "bun:sqlite";
import { type ApprovalKind, closeApproval, upsertApprovalRequested } from "@cc-web/control-db";
import type { RunnerEvent, RunRegistry } from "@cc-web/protocol";

/**
 * Projecting approval events out of the journal (§13.1).
 *
 * Every ingested event passes through here after `ingestEvent` commits. Three
 * shapes matter:
 *
 *  - `approval.requested` becomes the durable row a decision route answers
 *    from, plus the registry's `waiting_for_approval` observation.
 *  - `approval.resolved` / `approval.expired` close that row and resume the
 *    run. `resolved` after `decided` is the normal path; the CAS refuses a
 *    second close either way.
 *
 * The hook runs for duplicates too, on purpose: the projection writes are
 * idempotent (`INSERT OR IGNORE`, CAS closes), so a redelivered event heals a
 * projection a crash skipped instead of corrupting one. A conflict — same id,
 * different content — projects nothing.
 *
 * The payload is untrusted runner content: every field is type-checked here,
 * and a malformed request is dropped rather than stored half-typed.
 */

const KINDS: ReadonlySet<string> = new Set(["tool_permission", "user_question"]);

/** Defensive display cap — the runner already truncates; this is the second belt. */
const SUMMARY_LIMIT = 2_000;

type RequestedPayload = {
  approvalId: string;
  kind: ApprovalKind;
  toolName: string;
  inputHash: string;
  expiresAt: number;
  inputSummary?: string;
  questions?: unknown;
};

function asRequestedPayload(payload: unknown): RequestedPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const kind = record["kind"];
  if (
    typeof record["approvalId"] !== "string" ||
    record["approvalId"] === "" ||
    typeof kind !== "string" ||
    !KINDS.has(kind) ||
    typeof record["toolName"] !== "string" ||
    record["toolName"] === "" ||
    typeof record["inputHash"] !== "string" ||
    record["inputHash"] === "" ||
    typeof record["expiresAt"] !== "number" ||
    !Number.isFinite(record["expiresAt"])
  ) {
    return undefined;
  }
  return {
    approvalId: record["approvalId"],
    kind: kind as ApprovalKind,
    toolName: record["toolName"],
    inputHash: record["inputHash"],
    expiresAt: record["expiresAt"],
    ...(typeof record["inputSummary"] === "string" ? { inputSummary: record["inputSummary"] } : {}),
    questions: record["questions"],
  };
}

function terminalApprovalId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as Record<string, unknown>)["approvalId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * For `user_question` the structured questions ARE the human-readable summary
 * of what was asked — the runner redacted and truncated them before emitting,
 * so they are safe to project for the card to render.
 */
function summaryOf(payload: RequestedPayload): string {
  if (payload.kind === "user_question" && payload.questions !== undefined) {
    return JSON.stringify(payload.questions);
  }
  return (payload.inputSummary ?? "").slice(0, SUMMARY_LIMIT);
}

export function projectApprovalEvent(db: Database, runs: RunRegistry, event: RunnerEvent): void {
  if (event.type === "approval.requested") {
    const payload = asRequestedPayload(event.payload);
    if (payload === undefined) return;

    upsertApprovalRequested(db, {
      approvalId: payload.approvalId,
      sessionId: event.sessionId,
      runId: event.runId,
      attemptId: event.attemptId,
      runnerId: event.runnerId,
      kind: payload.kind,
      toolName: payload.toolName,
      inputHash: payload.inputHash,
      inputSummary: summaryOf(payload),
      expiresAt: payload.expiresAt,
    });
    runs.markWaitingForApproval(event.runId, event.attemptId);
    return;
  }

  if (event.type === "approval.resolved" || event.type === "approval.expired") {
    const approvalId = terminalApprovalId(event.payload);
    if (approvalId === undefined) return;

    closeApproval(db, {
      approvalId,
      state: event.type === "approval.resolved" ? "resolved" : "expired",
    });
    runs.markApprovalResolved(event.runId, event.attemptId);
  }
}
