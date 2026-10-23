#!/usr/bin/env bun

/**
 * Integration probe: one enrollment token, N real processes racing to consume it.
 *
 * Runs each consumer in a *separate process* against a *shared SQLite file*, then
 * once in separate Docker containers with separate filesystems. The in-memory
 * unit test proves the conditional UPDATE is correct in one process; this proves
 * the guarantee survives real process and filesystem boundaries, which is where
 * WAL, locking and busy-timeout behaviour actually matter.
 *
 *   bun run scripts/integration/enrollment-race.ts
 *   bun run scripts/integration/enrollment-race.ts --docker
 */

import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnrollment, migrate } from "../../packages/control-db/src/index.ts";

const useDocker = process.argv.includes("--docker");
const CONSUMERS = 8;

type Outcome = { ok: boolean; reason?: string; who?: string };

const workdir = await mkdtemp(join(tmpdir(), "cc-web-race-"));
const dbPath = join(workdir, "control.sqlite");

try {
  // Seed: one token, valid for an hour.
  const seed = new Database(dbPath, { create: true });
  migrate(seed);
  const { token } = createEnrollment(seed, { ownerId: "owner-1", ttlMs: 3_600_000 });
  seed.close();

  const results = useDocker
    ? await raceInDocker(token, dbPath)
    : await raceInProcesses(token, dbPath);

  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  console.log("\nconsumers:", results.length);
  console.log("winners:  ", winners.length, winners.map((w) => w.who).join(", ") || "(none)");
  console.log("losers:   ", losers.length, [...new Set(losers.map((l) => l.reason))].join(", "));

  const pass = winners.length === 1 && losers.every((l) => l.reason === "consumed");
  console.log(`\n${pass ? "PASS" : "FAIL"} — exactly one winner, the rest "consumed"`);
  process.exit(pass ? 0 : 1);
} finally {
  await rm(workdir, { recursive: true, force: true });
}

/** Each consumer is a separate OS process hitting the same database file. */
async function raceInProcesses(token: string, path: string): Promise<Outcome[]> {
  const script = `
    import { Database } from "bun:sqlite";
    import { consumeEnrollment } from ${JSON.stringify(
      new URL("../../packages/control-db/src/enrollment.ts", import.meta.url).pathname,
    )};
    const db = new Database(${JSON.stringify(path)});
    db.exec("PRAGMA busy_timeout = 5000");
    const r = consumeEnrollment(db, { token: ${JSON.stringify(token)} });
    console.log(JSON.stringify(r));
    db.close();
  `;
  const scriptPath = join(workdir, "consume.ts");
  await Bun.write(scriptPath, script);

  const procs = Array.from({ length: CONSUMERS }, (_, _i) =>
    Bun.spawn(["bun", "run", scriptPath], { stdout: "pipe", stderr: "pipe" }),
  );

  const outcomes: Outcome[] = [];
  for (const [i, proc] of procs.entries()) {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    try {
      const parsed = JSON.parse(out.trim()) as { ok: boolean; reason?: string };
      outcomes.push({ ...parsed, who: `proc-${i}` });
    } catch {
      outcomes.push({ ok: false, reason: "probe-crashed", who: `proc-${i}` });
    }
  }
  return outcomes;
}

/**
 * Each consumer is a container with its own root filesystem, sharing only the
 * database directory through a bind mount. Proves the guarantee does not depend
 * on same-host process semantics.
 */
async function raceInDocker(token: string, path: string): Promise<Outcome[]> {
  const dir = path.replace(/\/control\.sqlite$/, "");

  // The probe must exist on the shared volume *before* any container starts,
  // otherwise every container races a file that is not there yet.
  await Bun.write(
    join(dir, "consume.ts"),
    `import { Database } from "bun:sqlite";
     import { consumeEnrollment } from "/app/packages/control-db/src/enrollment.ts";
     const db = new Database("/data/control.sqlite");
     db.exec("PRAGMA busy_timeout = 5000");
     console.log(JSON.stringify(consumeEnrollment(db, { token: ${JSON.stringify(token)} })));
     db.close();`,
  );

  const procs = Array.from({ length: CONSUMERS }, (_, _i) =>
    Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        // Only the data directory is shared. Each container has its own
        // filesystem, process table and SQLite connection.
        "-v",
        `${dir}:/data`,
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "cc-web-runner:dev",
        "bun",
        "run",
        "/data/consume.ts",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );

  const outcomes: Outcome[] = [];
  for (const [i, proc] of procs.entries()) {
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    try {
      outcomes.push({ ...(JSON.parse(out.trim()) as Outcome), who: `ctr-${i}` });
    } catch {
      outcomes.push({ ok: false, reason: `probe-crashed: ${err.slice(0, 120)}`, who: `ctr-${i}` });
    }
  }
  return outcomes;
}
