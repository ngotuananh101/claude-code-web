import type { Database } from "bun:sqlite";

/**
 * Run-start file snapshots (§15.4, §18.2).
 *
 * A baseline is one `snapshot_runs` row (the run) plus its `file_snapshots`
 * children (the manifest). Content is content-addressed on disk by hash; the
 * database stores references only, so retention must keep a hash alive until
 * *every* run that references it is pruned.
 */

export type SnapshotState = "kept" | "excluded";

export type SnapshotEntry = {
  path: string;
  state: SnapshotState;
  hash: string | null;
  size: number | null;
  mode: number | null;
  reason?: string;
};

export type SnapshotRun = {
  attemptId: string;
  workspacePath: string;
  sessionId: string | null;
  collector: string;
  capturedAt: number;
  partial: boolean;
  fileCount: number;
};

export type SnapshotRunInput = {
  attemptId: string;
  workspacePath: string;
  sessionId?: string;
  collector: string;
  capturedAt: number;
  partial: boolean;
  entries: SnapshotEntry[];
};

export type StoredSnapshotEntry = {
  attempt_id: string;
  path: string;
  state: string;
  hash: string | null;
  size: number | null;
  mode: number | null;
  reason: string | null;
};

/**
 * Record a run-start baseline: the run row and every manifest entry, atomically.
 */
export function recordSnapshot(db: Database, input: SnapshotRunInput): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO snapshot_runs
       (attempt_id, workspace_path, session_id, collector, captured_at, partial, file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.attemptId,
      input.workspacePath,
      input.sessionId ?? null,
      input.collector,
      input.capturedAt,
      input.partial ? 1 : 0,
      input.entries.length,
    );

    const insertEntry = db.prepare(
      `INSERT INTO file_snapshots
       (attempt_id, path, state, hash, size, mode, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of input.entries) {
      insertEntry.run(
        input.attemptId,
        entry.path,
        entry.state,
        entry.hash ?? null,
        entry.size ?? null,
        entry.mode ?? null,
        entry.reason ?? null,
      );
    }
  });

  tx();
}

/** The newest baseline for a workspace, or undefined. */
export function latestSnapshot(
  db: Database,
  workspacePath: string,
): { run: SnapshotRun; entries: StoredSnapshotEntry[] } | undefined {
  const run = db
    .prepare(
      `SELECT attempt_id, workspace_path, session_id, collector, captured_at, partial, file_count
     FROM snapshot_runs
     WHERE workspace_path = ?
     ORDER BY captured_at DESC, attempt_id DESC
     LIMIT 1`,
    )
    .get(workspacePath) as {
    attempt_id: string;
    workspace_path: string;
    session_id: string | null;
    collector: string;
    captured_at: number;
    partial: number;
    file_count: number;
  } | null;

  if (run === null) return undefined;

  const entries = db
    .prepare(
      `SELECT attempt_id, path, state, hash, size, mode, reason
     FROM file_snapshots
     WHERE attempt_id = ?
     ORDER BY path`,
    )
    .all(run.attempt_id) as StoredSnapshotEntry[];

  return {
    run: {
      attemptId: run.attempt_id,
      workspacePath: run.workspace_path,
      sessionId: run.session_id,
      collector: run.collector,
      capturedAt: run.captured_at,
      partial: run.partial !== 0,
      fileCount: run.file_count,
    },
    entries,
  };
}

/**
 * Keep the newest `keep` runs for a workspace; delete the rest and their entries.
 * Returns the hashes that no surviving row references — i.e. hashes that may be
 * garbage-collected from on-disk blobs. A hash shared between a pruned run and a
 * surviving run is never returned.
 */
export function pruneSnapshots(db: Database, workspacePath: string, keep: number): string[] {
  const tx = db.transaction(() => {
    // Attempt ids to drop: everything outside the newest `keep`. SQLite needs a
    // LIMIT when OFFSET is used, so `LIMIT -1 OFFSET keep` skips the newest `keep`
    // rows and yields the rest.
    const toDrop = db
      .prepare(
        `SELECT attempt_id FROM snapshot_runs
       WHERE workspace_path = ?
       ORDER BY captured_at DESC, attempt_id DESC
       LIMIT -1 OFFSET ?`,
      )
      .all(workspacePath, keep) as Array<{ attempt_id: string }>;

    if (toDrop.length === 0) return [] as string[];

    // Candidate hashes owned by rows about to be deleted. A hash may be shared
    // with a surviving run; that is checked again after the delete.
    const ids = toDrop.map((r) => r.attempt_id);
    const placeholders = ids.map(() => "?").join(",");

    const candidates = db
      .prepare(
        `SELECT DISTINCT hash FROM file_snapshots
       WHERE attempt_id IN (${placeholders}) AND hash IS NOT NULL`,
      )
      .all(...ids) as Array<{ hash: string }>;

    const deleteEntries = db.prepare(
      `DELETE FROM file_snapshots WHERE attempt_id IN (${placeholders})`,
    );
    const deleteRuns = db.prepare(
      `DELETE FROM snapshot_runs WHERE attempt_id IN (${placeholders})`,
    );

    deleteEntries.run(...ids);
    deleteRuns.run(...ids);

    // A candidate is truly orphaned only when no surviving row still references
    // its hash.
    const orphaned: string[] = [];
    const probe = db.prepare("SELECT 1 FROM file_snapshots WHERE hash = ? LIMIT 1");

    for (const { hash } of candidates) {
      if (probe.get(hash) === null) orphaned.push(hash);
    }

    return orphaned;
  });

  return tx();
}
