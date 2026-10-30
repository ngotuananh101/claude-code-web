/**
 * Display-side parse of an approval's terminal events (F4).
 *
 * The journal is the authority on an approval's outcome (§13.2). The runner
 * only ever emits `approval.resolved` with decision "allow"|"deny" and
 * `approval.expired` with a reason string, so a payload outside that shape is
 * garbage, not an allow — parsing it strictly keeps a garbled event from
 * rendering a card as permitted.
 */

import { APPROVAL_NO_EXPIRY } from "@cc-web/protocol";

export type ApprovalTerminal = { decision?: "allow" | "deny"; reason?: string };

export function mapApprovalTerminals(
  rows: ReadonlyArray<{ type: string; payload: unknown }>,
): Map<string, ApprovalTerminal> {
  const terminals = new Map<string, ApprovalTerminal>();
  for (const { type, payload } of rows) {
    if (type !== "approval.resolved" && type !== "approval.expired") continue;
    const record = (payload ?? {}) as Record<string, unknown>;
    const approvalId = record["approvalId"];
    if (typeof approvalId !== "string") continue;
    if (type === "approval.resolved") {
      const decision = record["decision"];
      if (decision !== "allow" && decision !== "deny") continue;
      terminals.set(approvalId, { decision });
    } else {
      const reason = record["reason"];
      terminals.set(approvalId, typeof reason === "string" && reason !== "" ? { reason } : {});
    }
  }
  return terminals;
}

/**
 * Whether a `requested` row outlived its window with no closing event.
 *
 * A non-expiring gate is parked at `APPROVAL_NO_EXPIRY` by the runner, so it
 * never counts as expired here either.
 */
export function isDisplayExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  if (expiresAt >= APPROVAL_NO_EXPIRY - 10_000) return false;
  return expiresAt < now;
}

export type DecisionAvailability = {
  /** The journal's terminal for this approval, once one has arrived. */
  terminal?: ApprovalTerminal | undefined;
  /** The gate's wire expiry; absent means the payload said nothing. */
  expiresAt?: number | undefined;
  /** Set when this browser was told the server closed the gate (§14.3). */
  closed?: boolean | undefined;
  now?: number | undefined;
};

/**
 * Whether a card still needs a human.
 *
 * One rule for both the card and the process accordion, so the summary can
 * never say "Đang chờ phê duyệt…" about a card that has already gone
 * read-only. Three ways a gate closes before its journal terminal arrives: the
 * server answered that it was abandoned (409 "expired"), its displayed window
 * passed without an event, or this browser already decided.
 */
export function approvalNeedsDecision(input: DecisionAvailability): boolean {
  if (input.terminal !== undefined) return false;
  if (input.closed === true) return false;
  return !isDisplayExpired(input.expiresAt, input.now);
}
