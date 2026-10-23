#!/usr/bin/env bun
/**
 * Fault injection: event outbox survival across a real process crash (§22.3).
 *
 * Phase 1 claim under test: an ACK watermark never advances past a gap, and
 * unacknowledged events survive process death.
 *
 * Timeline:
 *   1. child process appends events 1, 2, 4 and ACKs "up to 4" — a gap at 3
 *   2. it reports the watermark, then is killed with SIGKILL mid-flight
 *   3. a second process reopens the same database and inspects the outbox
 *
 * A SIGKILL (not SIGTERM) is deliberate: it denies the process any cleanup, which
 * is the interesting case. WAL recovery has to do the work.
 *
 *   bun run scripts/integration/ack-gap-crash.ts
 *   bun run scripts/integration/ack-gap-crash.ts --docker
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const workdir = await mkdtemp(join(tmpdir(), "cc-web-ackgap-"));
const dbPath = join(workdir, "runner.sqlite");

const repoRoot = new URL("../..", import.meta.url).pathname;

/**
 * Import paths differ by environment: the host sees the real repo path, while a
 * container mounts it at /app. Generating host paths into a container script is
 * the easy mistake here, and it fails as a module-not-found rather than an
 * obvious path error.
 */
const moduleRoot = useDocker ? "/app/" : repoRoot;

/**
 * Database path also differs: the host has the real temp path, the container
 * sees only /data.
 */
const runtimeDbPath = useDocker ? "/data/runner.sqlite" : dbPath;

const writer = `
import { Database } from "bun:sqlite";
import { migrateRunnerDb } from "${moduleRoot}packages/runner-db/src/db.ts";
import { appendEvent, ackUpTo } from "${moduleRoot}packages/runner-db/src/event-outbox.ts";

const db = new Database(${JSON.stringify(runtimeDbPath)});
migrateRunnerDb(db);

for (const seq of [1, 2, 4]) {
  appendEvent(db, {
    eventId: "evt-" + seq,
    attemptId: "attempt-1",
    localSequence: seq,
    sessionId: "session-1",
    runId: "run-1",
    type: "message.delta",
    payload: { n: seq },
    occurredAt: new Date().toISOString(),
  });
}

// Server claims 1..4 but 3 does not exist here.
const result = ackUpTo(db, { attemptId: "attempt-1", sequence: 4 });
console.log(JSON.stringify({ watermark: result.ackedThrough }));

// Announce readiness, then die without closing the database. How it dies differs
// by environment: a host process can SIGKILL itself; a container's PID 1 cannot,
// so it waits to be killed from outside.
console.log("READY");
if (${useDocker}) {
  await new Promise(() => {});
} else {
  process.kill(process.pid, "SIGKILL");
}
`;

const reader = `
import { Database } from "bun:sqlite";
import { highestContiguousAcked, pendingEvents } from "${moduleRoot}packages/runner-db/src/event-outbox.ts";

const db = new Database(${JSON.stringify(runtimeDbPath)});
db.exec("PRAGMA busy_timeout = 5000");
console.log(JSON.stringify({
  acked: highestContiguousAcked(db, "attempt-1"),
  pending: pendingEvents(db, "attempt-1").map((e) => e.localSequence),
}));
`;

try {
  await Bun.write(join(workdir, "writer.ts"), writer);
  await Bun.write(join(workdir, "reader.ts"), reader);
  const watermark = useDocker ? await crashInDocker() : await crashInProcess();

  const observed = useDocker ? await readInDocker() : await readInProcess();

  console.log("\nwatermark before crash:", watermark);
  console.log("after reopen:         ", JSON.stringify(observed));

  const checks = [
    ["watermark stops at the gap", watermark === 2],
    ["unacknowledged event survives", observed.pending.includes(4)],
    ["watermark is not resurrected", observed.acked === 2],
  ] as const;

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "✓" : "✗"} ${name}`);
    if (!pass) failed++;
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${checks.length} checks, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
} finally {
  await rm(workdir, { recursive: true, force: true });
}

async function crashInProcess(): Promise<number> {
  const proc = Bun.spawn(["bun", "run", join(workdir, "writer.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  // SIGKILL is expected: 137 = 128 + 9.
  if (exitCode !== 137) {
    throw new Error(`writer exited ${exitCode} instead of dying by SIGKILL\n${out}`);
  }

  const line = out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`no watermark reported\n${out}`);
  return (JSON.parse(line) as { watermark: number }).watermark;
}

async function readInProcess(): Promise<{ acked: number; pending: number[] }> {
  const proc = Bun.spawn(["bun", "run", join(workdir, "reader.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim()) as { acked: number; pending: number[] };
}

/**
 * Read stdout line by line until `marker` appears.
 *
 * Buffering the whole stream is wrong here: a process that waits to be killed
 * never closes stdout, so `new Response(stream).text()` would block forever. We
 * need the READY signal while the process is still alive.
 */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (!buffer.includes(marker)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${marker}"\n${buffer}`);
      const { done, value } = await reader.read();
      if (done) throw new Error(`stream ended before "${marker}"\n${buffer}`);
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  } finally {
    reader.releaseLock();
  }
}

async function crashInDocker(): Promise<number> {
  // The process inside a container is PID 1 of its own PID namespace, and the
  // kernel does not deliver SIGKILL sent from inside that namespace to PID 1.
  // So the container is killed from outside — which is a more faithful model of
  // a host dying anyway.
  const name = `cc-web-ackgap-${Date.now()}`;
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "-v",
      `${workdir}:/data`,
      "-v",
      `${repoRoot}:/app:ro`,
      "-w",
      "/app",
      "cc-web-runner:dev",
      "bun",
      "run",
      "/data/writer.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const out = await readUntil(proc.stdout, "READY", 60_000);

  const line = out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`no watermark reported\n${out}`);

  // SIGKILL the container: no cleanup, WAL recovery has to handle it.
  const kill = Bun.spawnSync(["docker", "kill", "--signal", "SIGKILL", name]);
  if (kill.exitCode !== 0) throw new Error(`docker kill failed: ${kill.stderr.toString()}`);

  await proc.exited;
  return (JSON.parse(line) as { watermark: number }).watermark;
}

async function readInDocker(): Promise<{ acked: number; pending: number[] }> {
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${workdir}:/data`,
      "-v",
      `${repoRoot}:/app:ro`,
      "-w",
      "/app",
      "cc-web-runner:dev",
      "bun",
      "run",
      "/data/reader.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim()) as { acked: number; pending: number[] };
}
