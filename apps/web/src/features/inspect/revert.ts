import type { SnapshotStatusResult } from "@cc-web/protocol";
import { MAX_REVERT_FILES } from "@cc-web/protocol";
import { t } from "@/lib/i18n";

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
    return { ok: false, reason: t("inspect.revertNoSnapshot") };
  }
  if (status.baseline.partial) {
    return { ok: false, reason: t("inspect.snapshotIncomplete") };
  }
  if (status.truncated) {
    return { ok: false, reason: t("inspect.revertTooMany") };
  }
  if (status.digest === null) {
    return { ok: false, reason: t("inspect.revertNoPlan") };
  }
  const plan = summarisePlan(status);
  const actionable = plan.restores + plan.deletions;
  if (actionable === 0) {
    return { ok: false, reason: t("inspect.revertNothing") };
  }
  if (actionable > MAX_REVERT_FILES) {
    return { ok: false, reason: t("inspect.revertScopeTooLarge") };
  }
  return { ok: true };
}
