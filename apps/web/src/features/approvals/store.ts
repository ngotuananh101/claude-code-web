import { reactive } from "vue";
import { toast } from "vue-sonner";
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
    toast.success(decision === "allow" ? "Đã cho phép." : "Đã từ chối.");
    return;
  }
  if (outcome === "conflict") {
    toast.info("Quyết định này đã được ghi nhận trước đó.");
    return;
  }
  if (outcome === "not_found") {
    toast.error("Phê duyệt không còn tồn tại — có thể đã hết hạn.");
    return;
  }
  if (outcome === "unauthorized") {
    toast.error("Đăng nhập đã hết hạn — hãy đăng nhập lại.");
    return;
  }
  toast.error("Không chuyển được quyết định — thử lại.");
}
