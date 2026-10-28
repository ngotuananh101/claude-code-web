import type { SnapshotStatusResult } from "@cc-web/protocol";
import { MAX_REVERT_FILES } from "@cc-web/protocol";

/**
 * Pure revert-panel logic (§7.8).
 *
 * `summarisePlan` counts the previewed workspace revert into the three buckets
 * the panel labels: restores (files the apply will rewrite from baseline blobs),
 * deletions (files the apply will remove) and conflicts (entries no automatic
 * action can touch — they need the operator's eyes). Entries are the source of
 * truth the panel renders; `counts` is a server summary and is not trusted here.
 *
 * `canApplyPlan` gates the apply on the invariants the runner enforces before
 * a whole-workspace revert: a complete baseline, an untruncated list, a digest,
 * something to do, and a plan within the apply budget.
 */

export function summarisePlan(status: SnapshotStatusResult): {
  restores: number;
  deletions: number;
  conflicts: number;
} {
  let restores = 0;
  let deletions = 0;
  let conflicts = 0;
  for (const entry of status.entries) {
    switch (entry.status) {
      case "modified":
      case "deleted":
        restores += 1;
        break;
      case "created":
        deletions += 1;
        break;
      case "excluded":
        conflicts += 1;
        break;
    }
  }
  return { restores, deletions, conflicts };
}

export function canApplyPlan(
  status: SnapshotStatusResult,
): { ok: true } | { ok: false; reason: string } {
  if (status.baseline === null) {
    return { ok: false, reason: "Chưa có bản chụp lúc bắt đầu chạy." };
  }
  if (status.baseline.partial) {
    return { ok: false, reason: "Bản chụp không đầy đủ." };
  }
  if (status.truncated) {
    return { ok: false, reason: "Danh sách thay đổi quá dài." };
  }
  if (status.digest === null) {
    return { ok: false, reason: "Không có kế hoạch để áp dụng." };
  }
  const plan = summarisePlan(status);
  const actionable = plan.restores + plan.deletions;
  if (actionable === 0) {
    return { ok: false, reason: "Không có gì để khôi phục." };
  }
  if (actionable > MAX_REVERT_FILES) {
    return { ok: false, reason: "Phạm vi quá lớn — hãy khôi phục từng phần." };
  }
  return { ok: true };
}
