/**
 * Display-side parse of an approval's terminal events (F4).
 *
 * The journal is the authority on an approval's outcome (§13.2). The runner
 * only ever emits `approval.resolved` with decision "allow"|"deny" and
 * `approval.expired` with a reason string, so a payload outside that shape is
 * garbage, not an allow — parsing it strictly keeps a garbled event from
 * rendering a card as permitted.
 */

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
