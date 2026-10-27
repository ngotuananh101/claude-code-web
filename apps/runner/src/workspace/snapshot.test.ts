import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { createBaselineCapture } from "./snapshot.ts";

const dirs: string[] = [];
async function dir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const noGit = async () => ({ exitCode: 1, stdout: "" });

test("captures content into a content-addressed blob and a kept row", async () => {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "a.ts"), "export {};\n");
  const capture = createBaselineCapture({ db, homeDir: home, spawn: noGit });
  expect(await capture(root, "a-1", "s-1")).toEqual({ ok: true });
  expect(await readFile(join(home, "snapshots", "blobs", sha("export {};\n")), "utf8")).toBe(
    "export {};\n",
  );
  const row = db
    .query("SELECT path, state, hash FROM file_snapshots WHERE attempt_id = 'a-1'")
    .get() as { path: string; state: string; hash: string };
  expect(row).toEqual({ path: "a.ts", state: "kept", hash: sha("export {};\n") });
});

test("a file over the per-file cap is recorded excluded, not omitted", async () => {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "big.bin"), "0123456789");
  const capture = createBaselineCapture({
    db,
    homeDir: home,
    spawn: noGit,
    limits: { fileBytes: 4 },
  });
  expect(await capture(root, "a-1", "s-1")).toEqual({ ok: true });
  const row = db.query("SELECT state, reason FROM file_snapshots").get() as {
    state: string;
    reason: string;
  };
  expect(row).toEqual({ state: "excluded", reason: "oversize" });
});

test("crossing the byte cap marks the run partial and leaves later files unbaselined", async () => {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "a.ts"), "1234");
  await writeFile(join(root, "b.ts"), "5678");
  const capture = createBaselineCapture({
    db,
    homeDir: home,
    spawn: noGit,
    limits: { totalBytes: 4 },
  });
  await capture(root, "a-1", "s-1");
  const run = db.query("SELECT partial FROM snapshot_runs WHERE attempt_id = 'a-1'").get() as {
    partial: number;
  };
  expect(run.partial).toBe(1);
  const reasons = db.query("SELECT path, state, reason FROM file_snapshots ORDER BY path").all();
  expect(reasons).toEqual([
    { path: "a.ts", state: "kept", reason: null },
    { path: "b.ts", state: "excluded", reason: "unbaselined" },
  ]);
});

test("pruning keeps five baselines and deletes the unreferenced blob", async () => {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  const capture = createBaselineCapture({ db, homeDir: home, spawn: noGit });
  for (let i = 0; i < 6; i++) {
    await writeFile(join(root, "a.ts"), `v${i}`);
    await capture(root, `a-${i}`, "s-1");
  }
  expect(existsSync(join(home, "snapshots", "blobs", sha("v0")))).toBe(false);
  expect(existsSync(join(home, "snapshots", "blobs", sha("v5")))).toBe(true);
});
