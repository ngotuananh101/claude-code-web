/**
 * Content-addressed run-start baseline capture (§15.2, §15.4).
 *
 * Composes the collector (`collectWorkspaceFiles`), the runner-db snapshot store
 * (`recordSnapshot`, `pruneSnapshots`) and the content-addressable blob store
 * under `<homeDir>/snapshots/blobs/<hash>` into one operation: at the start of a
 * run, record what the workspace looked like so a later revert can restore it,
 * and so an inspection can report what changed.
 *
 * Production callers pass `{ db, homeDir, spawn? }`; `now` and `limits` exist
 * only for tests. The production caps come from the protocol module and are
 * applied when `limits` is absent.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_FILE_BYTES,
  SNAPSHOT_RETENTION,
} from "@cc-web/protocol";
import { pruneSnapshots, recordSnapshot, type SnapshotEntry } from "@cc-web/runner-db";
import { redactErrorText } from "../execution/redact.ts";
import type { GitSpawn } from "../git/spawn.ts";
import { gitSpawn } from "../git/spawn.ts";
import { type Collected, collectWorkspaceFiles } from "./collect.ts";

/** `<homeDir>/snapshots/blobs/<hash>`. Content-addressed on disk by sha256 hex. */
export function blobPath(homeDir: string, hash: string): string {
  return join(homeDir, "snapshots", "blobs", hash);
}

type CaptureOptions = {
  db: Database;
  homeDir: string;
  spawn?: GitSpawn;
  now?: () => number;
  limits?: { fileBytes?: number; totalBytes?: number; entries?: number };
};

type CaptureResult = { ok: true } | { ok: false; reason: string };

/**
 * Build a baseline capturer bound to `db` and `homeDir`.
 *
 * Returns a function `(workspacePath, attemptId, sessionId) => Promise<CaptureResult>`
 * that collects the workspace, writes content-addressed blobs and a manifest
 * row, then prunes old baselines for the same workspace. The capture never
 * throws: any failure returns `{ ok: false, reason }` with the error text
 * redacted and truncated.
 */
export function createBaselineCapture(options: CaptureOptions) {
  const { db, homeDir, spawn, now = Date.now } = options;
  const fileBytes = options.limits?.fileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
  const totalBytes = options.limits?.totalBytes ?? MAX_SNAPSHOT_BYTES;
  const entries = options.limits?.entries ?? MAX_SNAPSHOT_ENTRIES;

  return async function capture(
    workspacePath: string,
    attemptId: string,
    sessionId: string,
  ): Promise<CaptureResult> {
    try {
      const collected: Collected = await collectWorkspaceFiles(workspacePath, {
        spawn: spawn ?? gitSpawn,
        maxEntries: entries,
      });

      const snapshotEntries: SnapshotEntry[] = [];
      let partial = collected.truncated;
      let total = 0;
      let overCap = false;

      // Collector exclusions become excluded rows first, in collection order,
      // before the kept files are processed.
      for (const excluded of collected.excluded) {
        snapshotEntries.push({
          path: excluded.path,
          state: "excluded",
          hash: null,
          size: null,
          mode: null,
          reason: excluded.reason,
        });
      }

      const blobsDir = join(homeDir, "snapshots", "blobs");
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });

      for (const rel of collected.paths) {
        const absolute = join(workspacePath, rel);

        // Re-stat: a file may have vanished between collection and capture. A
        // missing or non-regular file is skipped rather than recorded; the
        // collector already owns the reasons for the exclusions it reported.
        const info = await lstat(absolute).catch(() => null);
        if (info === null) continue;
        if (info.isSymbolicLink() || !info.isFile()) continue;

        if (info.size > fileBytes) {
          snapshotEntries.push({
            path: rel,
            state: "excluded",
            hash: null,
            size: info.size,
            mode: info.mode,
            reason: "oversize",
          });
          continue;
        }

        if (overCap) {
          snapshotEntries.push({
            path: rel,
            state: "excluded",
            hash: null,
            size: info.size,
            mode: info.mode,
            reason: "unbaselined",
          });
          continue;
        }

        const bytes = await readFile(absolute);
        total += bytes.byteLength;
        if (total > totalBytes) {
          overCap = true;
          partial = true;
          snapshotEntries.push({
            path: rel,
            state: "excluded",
            hash: null,
            size: info.size,
            mode: info.mode,
            reason: "unbaselined",
          });
          continue;
        }

        const hash = createHash("sha256").update(bytes).digest("hex");
        const target = blobPath(homeDir, hash);
        try {
          // `wx` fails if the file already exists — content-addressed, so an
          // existing blob is identical and need not be rewritten.
          await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code !== "EEXIST") throw err;
        }

        snapshotEntries.push({
          path: rel,
          state: "kept",
          hash,
          size: info.size,
          mode: info.mode,
        });
      }

      recordSnapshot(db, {
        attemptId,
        workspacePath,
        sessionId,
        collector: collected.mode,
        capturedAt: now(),
        partial,
        entries: snapshotEntries,
      });

      const orphaned = pruneSnapshots(db, workspacePath, SNAPSHOT_RETENTION);
      for (const hash of orphaned) {
        await rm(blobPath(homeDir, hash), { force: true });
      }

      return { ok: true };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error ?? "unknown error");
      return { ok: false, reason: redactErrorText(text).slice(0, 200) };
    }
  };
}
