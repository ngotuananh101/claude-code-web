import { describe, expect, test } from "bun:test";
import type { SnapshotStatusResult } from "@cc-web/protocol";
import { canApplyPlan, summarisePlan } from "./revert.ts";

/**
 * Pure revert-panel logic: counting a previewed workspace revert into the
 * three buckets the panel labels, and gating the apply on the invariants the
 * runner enforces (§7.8).
 *
 * The plan is derived from `entries`, which is the source of truth the panel
 * renders; `counts` is a server summary and is not trusted here.
 */

/** Minimal baseline shape the runner reports. */
function baseline(
  overrides: {
    attemptId?: string;
    sessionId?: string | null;
    capturedAt?: string;
    partial?: boolean;
    fileCount?: number;
  } = {},
): {
  attemptId: string;
  sessionId: string | null;
  capturedAt: string;
  partial: boolean;
  fileCount: number;
} {
  return {
    attemptId: "a1",
    sessionId: null,
    capturedAt: new Date(1000).toISOString(),
    partial: false,
    fileCount: 0,
    ...overrides,
  };
}

/**
 * A full `SnapshotStatusResult` with `digest: "d1"` and a complete, untruncated
 * baseline. `counts` drives the synthesized `entries` array so the two never
 * disagree — `summarisePlan` reads `entries`, never `counts`.
 *
 * The default includes one modified entry so that `statusOf()` represents a
 * safe-to-apply plan (the brief's pinned test asserts `canApplyPlan(statusOf())`
 * is `{ ok: true }`); callers override to probe an empty or oversized plan.
 */
function statusOf(
  counts: { modified?: number; created?: number; deleted?: number; excluded?: number } = {},
): SnapshotStatusResult {
  const { modified = 1, created = 0, deleted = 0, excluded = 0 } = counts;
  const entries: SnapshotStatusResult["entries"] = [
    ...Array.from({ length: modified }, (_, i) => ({
      op: "snapshot.status" as const,
      path: `m${i}`,
      status: "modified" as const,
      snapshotHash: "s",
      currentHash: "c",
      size: 1,
      revertable: true,
    })),
    ...Array.from({ length: created }, (_, i) => ({
      op: "snapshot.status" as const,
      path: `c${i}`,
      status: "created" as const,
      snapshotHash: null,
      currentHash: "c",
      size: 1,
      revertable: true,
    })),
    ...Array.from({ length: deleted }, (_, i) => ({
      op: "snapshot.status" as const,
      path: `d${i}`,
      status: "deleted" as const,
      snapshotHash: "s",
      currentHash: null,
      size: 1,
      revertable: true,
    })),
    ...Array.from({ length: excluded }, (_, i) => ({
      op: "snapshot.status" as const,
      path: `e${i}`,
      status: "excluded" as const,
      snapshotHash: null,
      currentHash: null,
      size: null,
      revertable: false,
      reason: "credential",
    })),
  ] as SnapshotStatusResult["entries"];
  return {
    op: "snapshot.status",
    baseline: baseline({ fileCount: modified + created + deleted + excluded }),
    entries,
    counts: { modified, created, deleted, excluded },
    digest: "d1",
    truncated: false,
  };
}

describe("summarisePlan", () => {
  test("summarises a plan into restores, deletions and conflicts", () => {
    const status = statusOf({ modified: 1, created: 2, deleted: 3, excluded: 4 });
    expect(summarisePlan(status)).toEqual({ restores: 4, deletions: 2, conflicts: 4 });
  });
});

describe("canApplyPlan", () => {
  test("apply is refused with a reason for every unsafe baseline", () => {
    expect(canApplyPlan(statusOf())).toEqual({ ok: true });
    expect(canApplyPlan({ ...statusOf(), baseline: null }).ok).toBe(false);
    expect(canApplyPlan({ ...statusOf(), baseline: baseline({ partial: true }) }).ok).toBe(false);
    expect(canApplyPlan({ ...statusOf(), truncated: true }).ok).toBe(false);
    expect(canApplyPlan({ ...statusOf(), digest: null }).ok).toBe(false);
    expect(canApplyPlan(statusOf({ modified: 301 })).ok).toBe(false);
  });
});
