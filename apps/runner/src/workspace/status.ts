/**
 * Snapshot status: classify a workspace's current files against the most recent
 * run-start baseline (§7.7). Returns modified / created / deleted / excluded
 * entries, counts, and a stable digest the whole-workspace revert plan reuses.
 *
 * This module is read-only: it never writes the workspace, only reads it. It
 * intentionally does not import the mutation handler — status and revert share
 * a digest, not code, so a status bug cannot pull revert in with it.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BINARY_SNIFF_BYTES, MAX_SNAPSHOT_FILE_BYTES, MAX_STATUS_ENTRIES } from "@cc-web/protocol";
import { latestSnapshot } from "@cc-web/runner-db";
import type { GitSpawn } from "../git/spawn.ts";
import { gitSpawn } from "../git/spawn.ts";
import { type Collected, collectWorkspaceFiles } from "./collect.ts";

export type StatusOutcome =
  | { ok: true; result: SnapshotStatusResult }
  | { ok: false; code: string };

export type SnapshotStatusResult = {
  op: "snapshot.status";
  baseline: {
    attemptId: string;
    sessionId: string | null;
    capturedAt: string;
    partial: boolean;
    fileCount: number;
  } | null;
  entries: SnapshotEntry[];
  counts: { modified: number; created: number; deleted: number; excluded: number };
  digest: string | null;
  truncated: boolean;
};

export type SnapshotEntry = {
  path: string;
  status: "modified" | "created" | "deleted" | "excluded";
  snapshotHash: string | null;
  currentHash: string | null;
  size: number | null;
  revertable: boolean;
  reason?: string;
};

type SnapshotStatusOptions = {
  db: Database;
  spawn?: GitSpawn;
  maxEntries?: number;
};

/**
 * Build a snapshot status function bound to `db` (and an optional spawn seam).
 *
 * Reproduction rule: a baseline captured with `collector: "git"` must be
 * compared against a current collection that also used git. If the collection
 * falls back to a walk, the two sets are incomparable and the caller is refused
 * `SNAPSHOT_INCOMPARABLE` rather than producing a misleading diff.
 */
export function createSnapshotStatus(options: SnapshotStatusOptions) {
  const { db, spawn, maxEntries } = options;
  const cap = maxEntries ?? MAX_STATUS_ENTRIES;

  return async function status(root: string): Promise<StatusOutcome> {
    const latest = latestSnapshot(db, root);

    // No baseline: the literal empty answer the protocol pins.
    if (latest === undefined) {
      return {
        ok: true,
        result: {
          op: "snapshot.status",
          baseline: null,
          entries: [],
          counts: { modified: 0, created: 0, deleted: 0, excluded: 0 },
          digest: null,
          truncated: false,
        },
      };
    }

    // Mode reproduction: a git baseline must be compared against a git collection.
    const collected: Collected = await collectWorkspaceFiles(root, {
      spawn: spawn ?? gitSpawn,
      maxEntries: cap,
    });

    if (latest.run.collector === "git" && collected.mode === "walk") {
      return { ok: false, code: "SNAPSHOT_INCOMPARABLE" };
    }

    const result = await computeStatus(latest, collected, root, cap);
    return { ok: true, result };
  };
}

/**
 * Plan computation for the whole-workspace revert (§7.7, next task).
 *
 * Returns the same `SnapshotStatusResult` the status op does, wrapped so the
 * revert handler can distinguish "no baseline to revert to" from a computed
 * plan. `NO_SNAPSHOT` mirrors the mutation handler's guard; `SNAPSHOT_INCOMPARABLE`
 * propagates the mode-reproduction refusal.
 */
export async function computeSnapshotPlan(
  options: { db: Database; spawn?: GitSpawn },
  root: string,
): Promise<{ plan: SnapshotStatusResult } | { code: "NO_SNAPSHOT" | "SNAPSHOT_INCOMPARABLE" }> {
  const status = createSnapshotStatus(options);
  const outcome = await status(root);
  if (outcome.ok) return { plan: outcome.result };
  if (outcome.code === "SNAPSHOT_INCOMPARABLE") return { code: "SNAPSHOT_INCOMPARABLE" };
  return { code: "NO_SNAPSHOT" };
}

/**
 * Compute the status result from a baseline and a current collection.
 *
 * The baseline entries arrive sorted by path (from `latestSnapshot`); the
 * collected.now set is also sorted by `collectWorkspaceFiles`. This function
 * builds a merged, path-sorted entry list, applies the entry cap, computes
 * counts over what is returned, and derives the digest (null when truncated
 * or when there is no baseline — the latter is handled by the caller).
 */
async function computeStatus(
  snapshot: {
    run: {
      attemptId: string;
      sessionId: string | null;
      capturedAt: number;
      partial: boolean;
      fileCount: number;
    };
    entries: Array<{
      path: string;
      state: string;
      hash: string | null;
      size: number | null;
      mode: number | null;
      reason: string | null;
    }>;
  },
  collected: Collected,
  root: string,
  maxEntries: number,
): Promise<SnapshotStatusResult> {
  // Index baseline entries by path for O(1) lookup; keep the kept/excluded split
  // because each carries different fields (hash vs reason).
  const baseline = new Map<
    string,
    {
      hash: string | null;
      size: number | null;
      mode: number | null;
      reason: string | null;
      state: string;
    }
  >();
  for (const e of snapshot.entries) {
    baseline.set(e.path, {
      hash: e.hash,
      size: e.size,
      mode: e.mode,
      reason: e.reason,
      state: e.state,
    });
  }

  // Build current hashes for regular files in the collected-now set. Symlinks
  // and non-regular files are already in collected.excluded in the common case;
  // the lstat/re-read here is a race guard and also catches oversize/binary
  // files that the collector admits (it only filters by name, not content).
  const currentHashes = new Map<string, { hash: string; size: number; mode: number }>();
  const currentExcluded = new Map<string, string>();
  for (const rel of collected.paths) {
    const absolute = join(root, rel);
    const info = await lstat(absolute).catch(() => null);
    // The file may have vanished between collection and hashing.
    if (info === null) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      currentExcluded.set(rel, "non_regular");
      continue;
    }
    if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      currentExcluded.set(rel, "oversize");
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      currentExcluded.set(rel, "unreadable");
      continue;
    }
    // Binary sniff: a NUL byte in the first sniff window excludes the file.
    const sniff = bytes.subarray(0, BINARY_SNIFF_BYTES);
    if (sniff.includes(0)) {
      currentExcluded.set(rel, "binary");
      continue;
    }
    currentHashes.set(rel, {
      hash: sha256(bytes),
      size: info.size,
      mode: info.mode & 0o777,
    });
  }

  // Merge: union of baseline and current-now paths, sorted.
  const allPaths = new Set<string>([...baseline.keys(), ...collected.paths]);
  const sortedPaths = [...allPaths].sort();

  const entries: SnapshotEntry[] = [];
  let truncated = false;

  for (const path of sortedPaths) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const b = baseline.get(path);
    const c = currentHashes.get(path);
    const excReason = currentExcluded.get(path);

    if (b === undefined && c === undefined) {
      // Not in baseline and not hashable now. Two possibilities:
      // (a) the collector flagged it (symlink / credential / non-regular); or
      // (b) the status layer excluded it (oversize / binary / unreadable /
      //     non_regular race). Either way it is `excluded`, never `created`.
      if (excReason !== undefined) {
        entries.push({
          path,
          status: "excluded",
          snapshotHash: null,
          currentHash: null,
          size: null,
          revertable: false,
          reason: excReason,
        });
        continue;
      }
      const exc = collected.excluded.find((e) => e.path === path);
      if (exc !== undefined) {
        entries.push({
          path,
          status: "excluded",
          snapshotHash: null,
          currentHash: null,
          size: null,
          revertable: false,
          reason: exc.reason,
        });
      }
      continue;
    }

    if (b === undefined) {
      // Not in baseline, present now -> created.
      entries.push({
        path,
        status: "created",
        snapshotHash: null,
        currentHash: c!.hash,
        size: c!.size,
        revertable: true,
      });
      continue;
    }

    if (c === undefined) {
      // In baseline, not hashable now. Baseline reasons win first (existing
      // tests pin the "excluded from baseline" reason), then the status-layer
      // exclusion reasons (oversize / binary / unreadable / non_regular), then
      // the remaining baseline entry is a genuine deletion.
      const entry: SnapshotEntry = {
        path,
        status: b.state === "excluded" ? "excluded" : "deleted",
        snapshotHash: b.hash,
        currentHash: null,
        size: b.size,
        revertable: b.state === "kept" && b.hash !== null,
      };
      if (b.state === "excluded") {
        entry.reason = b.reason ?? "excluded from baseline";
      } else if (excReason !== undefined) {
        // The file is still on disk but excluded now (oversize/binary/etc.);
        // it must not be reported as deleted nor offered for restore.
        entry.status = "excluded";
        entry.revertable = false;
        entry.reason = excReason;
      }
      entries.push(entry);
      continue;
    }

    // Present in both.
    if (b.state === "excluded") {
      // The baseline excluded it but it is on disk now: still excluded here.
      entries.push({
        path,
        status: "excluded",
        snapshotHash: null,
        currentHash: c.hash,
        size: c.size,
        revertable: false,
        reason: b.reason ?? "excluded from baseline",
      });
      continue;
    }

    // kept in baseline + present now: unchanged files (identical hash) are
    // omitted entirely — only a status diff is reported.
    if (b.hash === c.hash) continue;

    entries.push({
      path,
      status: "modified",
      snapshotHash: b.hash,
      currentHash: c.hash,
      size: c.size,
      revertable: true,
    });
  }

  // Also surface current-now excluded paths (symlinks etc.) that the collector
  // returned separately, when not already merged above.
  for (const exc of collected.excluded) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    if (entries.some((e) => e.path === exc.path)) continue;
    entries.push({
      path: exc.path,
      status: "excluded",
      snapshotHash: null,
      currentHash: null,
      size: null,
      revertable: false,
      reason: exc.reason,
    });
  }

  // Counts over the entries actually returned (post-cap), as the panel shows.
  const counts = { modified: 0, created: 0, deleted: 0, excluded: 0 };
  for (const e of entries) {
    counts[e.status]++;
  }

  // Digest: null when truncated or when there is no baseline. The baseline is
  // guaranteed non-null here (caller handles that case), so truncation is the
  // only nullifier.
  const digest = truncated
    ? null
    : sha256(
        Buffer.from(
          `${snapshot.run.attemptId}\n` +
            entries
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
              .map((e) => `${e.status}\t${e.path}\t${e.snapshotHash ?? ""}\t${e.currentHash ?? ""}`)
              .join("\n"),
          "utf8",
        ),
      );

  return {
    op: "snapshot.status",
    baseline: {
      attemptId: snapshot.run.attemptId,
      sessionId: snapshot.run.sessionId,
      capturedAt: new Date(snapshot.run.capturedAt).toISOString(),
      partial: snapshot.run.partial,
      fileCount: snapshot.run.fileCount,
    },
    entries,
    counts,
    digest,
    truncated,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
