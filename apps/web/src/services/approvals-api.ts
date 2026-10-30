/**
 * The approval surface's HTTP half (§13.1), decided here and nowhere in a
 * component: which statuses collapse into which operator-facing outcome, and
 * that the decision only ever travels in the request body — never a URL
 * (§19.4, same rule as the prompt).
 */

import { authFetch } from "./auth-api.ts";

export type ApprovalDecision = "allow" | "deny";

export type DecisionOutcome =
  | "decided"
  | "conflict"
  | "expired"
  | "not_found"
  | "unauthorized"
  | "error";

export async function submitApprovalDecision(
  approvalId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string>,
): Promise<DecisionOutcome> {
  let response: Response;
  try {
    response = await authFetch(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers === undefined ? { decision } : { decision, answers }),
    });
  } catch {
    return "error";
  }

  if (response.status === 202) return "decided";
  if (response.status === 409) {
    // The route distinguishes a closed gate from a second decision by the body:
    // "expired" means reconciliation abandoned the approval (§14.3), anything
    // else means a decision was already recorded. Read the body only here, so
    // the happy path never pays for it.
    return (await response.text().catch(() => "")) === "expired" ? "expired" : "conflict";
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) return "unauthorized";
  return "error";
}
