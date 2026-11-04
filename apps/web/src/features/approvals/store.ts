import { reactive } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/lib/i18n";
import { type ApprovalDecision, submitApprovalDecision } from "../../services/approvals-api";

/**
 * Per-approval UI state (§13.2), keyed by approval id and module-level so the
 * card, the journal, and any future surface agree on one answer.
 *
 * `deciding` drives the optimistic "Đang chuyển quyết định…" the moment the
 * owner clicks; `decision` is what was accepted — the journal's
 * `approval.resolved` remains the authority and the card prefers it, this is
 * only the gap between the POST and the runner's confirmation event.
 */

export type ApprovalUiState = {
  deciding: boolean;
  decision?: ApprovalDecision;
  /** The server closed the gate without a decision (reconcile abandon, §14.3). */
  closed?: boolean;
};

const states = reactive(new Map<string, ApprovalUiState>());

export function approvalUi(approvalId: string): ApprovalUiState {
  let state = states.get(approvalId);
  if (state === undefined) {
    state = { deciding: false };
    states.set(approvalId, state);
  }
  return state;
}

/**
 * Read an approval's UI state without creating one. Surfaces that merely ask
 * "has this browser closed it?" — the process accordion — must not grow the
 * map for every approval in the transcript.
 */
export function peekApprovalUi(approvalId: string): ApprovalUiState | undefined {
  return states.get(approvalId);
}

export async function submitDecision(
  approvalId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string>,
): Promise<void> {
  const state = approvalUi(approvalId);
  state.deciding = true;
  const outcome = await submitApprovalDecision(approvalId, decision, answers);
  state.deciding = false;

  if (outcome === "decided") {
    state.decision = decision;
    toast.success(decision === "allow" ? t("approval.allowedToast") : t("approval.deniedToast"));
    return;
  }
  if (outcome === "conflict") {
    toast.info(t("approval.alreadyRecorded"));
    return;
  }
  if (outcome === "expired") {
    state.closed = true;
    toast.info(t("approval.closedNoLonger"));
    return;
  }
  if (outcome === "not_found") {
    toast.error(t("approval.notFound"));
    return;
  }
  if (outcome === "unauthorized") {
    toast.error(t("approval.loginExpired"));
    return;
  }
  toast.error(t("approval.failed"));
}
