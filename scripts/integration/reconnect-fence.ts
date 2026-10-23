#!/usr/bin/env bun
/**
 * Fault injection: a half-open socket cannot rewrite server state (§6.3, §22.3).
 *
 * Phase 1 claim under test: when a Runner's process dies without sending a FIN,
 * its socket is still open from the network's point of view. A reconnect from a
 * new process must fence the old one, and the server's run state must survive
 * the ambiguity without inventing an outcome.
 *
 * Timeline:
 *   1. a control server starts and registers one run for runner-a
 *   2. runner #1 connects, negotiates, reconciles — sees the run as its own
 *   3. runner #1 is SIGKILLed mid-flight; it gets no chance to clean up
 *   4. runner #2 connects from a fresh process and reconciles an empty inventory
 *   5. the server must report `interrupted`, never `completed`/`failed`
 *   6. runner #2 must hold a strictly higher generation than runner #1
 *
 * What this proves, and what it does not: a SIGKILL denies the process cleanup,
 * but the OS still closes its socket, so this is not a *half-open* socket. True
 * half-open needs a network partition, which `--network host` cannot produce.
 * The fencing of a still-open superseded socket is covered directly by
 * route.test.ts, which keeps the old socket alive and sends on it.
 *
 * Docker mode runs runner #2 in a separate container so the reconnect crosses a
 * real process and network boundary, not just a fresh Bun context.
 *
 *   bun run scripts/integration/reconnect-fence.ts
 *   bun run scripts/integration/reconnect-fence.ts --docker
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const workdir = await mkdtemp(join(tmpdir(), "cc-web-reconnect-"));
const repoRoot = new URL("../..", import.meta.url).pathname;

/**
 * Two module roots, not one: the control server always runs on the host and
 * resolves against the repo, while containerized runners see it mounted at
 * /app. Generating the host path into a container script — or vice versa — fails
 * as a bare module-not-found.
 */
const serverModuleRoot = repoRoot;
const _runnerModuleRoot = useDocker ? "/app/" : repoRoot;

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

/**
 * Reads a process's stdout across several markers.
 *
 * A `ReadableStream` can only be locked once, so this takes a reader for the
 * lifetime of the process and hands back the text seen so far. Reading it again
 * per marker is the easy mistake here, and it fails as "Invalid state:
 * ReadableStream is locked" far from the real cause.
 */
function streamReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // The process was killed; what it already printed is still evidence.
    }
  })();

  return {
    get text() {
      return buffer;
    },
    async until(marker: string, timeoutMs: number): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${JSON.stringify(marker)}; got: ${buffer.slice(-400)}`,
          );
        }
        await Bun.sleep(20);
      }
      return buffer;
    },
    async done() {
      await pump;
    },
  };
}

/** State is polled via /state rather than sampled after a fixed sleep: a
 * container cold start is slower than any delay worth hardcoding, and a sleep
 * that is too short makes the harness read state before the runner connected. */
const serverScript = `
import { RunRegistry } from "${serverModuleRoot}packages/protocol/src/run-registry.ts";
import { RunnerGateway } from "${serverModuleRoot}apps/control-server/src/websocket/runner/runner-gateway.ts";
import { runnerWebSocket, upgradeRunner } from "${serverModuleRoot}apps/control-server/src/websocket/runner/route.ts";

const runs = new RunRegistry();
runs.createRun({
  runId: "run-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  runnerId: "runner-a",
});

const gateway = new RunnerGateway({
  policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
  verifyCredential: (c) => (c === "cck_valid" ? { ok: true, runnerId: "runner-a", ownerId: "owner-1" } : { ok: false, reason: "unknown" }),
  runs,
});

let promotionsSeen = 0;

const server = Bun.serve({
  port: 8931,
  fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/state") {
      return Response.json({
        promotions: gateway.promotions.get("runner-a") ?? 0,
        ready: gateway.stateOf("runner-a") === "ready",
        observed: runs.get("run-1")?.observedState ?? null,
      });
    }
    const upgraded = upgradeRunner(request, srv, gateway);
    return upgraded.ok ? undefined : new Response("refused", { status: upgraded.status });
  },
  websocket: runnerWebSocket(gateway),
});


console.log("READY");
`;

const runnerScript = `
const socket = new WebSocket("ws://127.0.0.1:8931/ws/runner", {
  headers: { Authorization: "Bearer cck_valid" },
});

const hello = {
  protocolVersion: 1, runnerId: "runner-a", bootId: "boot-1",
  runnerVersion: "0.0.0", sdkVersion: "0.3.309", platform: "linux/x64",
  maxConcurrentRuns: 1, activeRuns: [], eventOffsets: [],
};

let generation = null;
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.type === "hello.ok") {
    generation = msg.generation;
    socket.send(JSON.stringify({ type: "reconcile", runner: ${"${INVENTORY}"} }));
  }
  if (msg.type === "reconcile.ok" || msg.type === "reconcile.blocked") {
    console.log("RECONCILED " + JSON.stringify({ ready: msg.ready === true, generation }));
  }
});
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "hello", hello }));
});
`;

/** The generation the server issued, recovered from the runner's own log. */
function generationOf(output: string): number | null {
  const line = output.split("\n").find((l) => l.startsWith("RECONCILED "));
  if (!line) return null;
  const parsed = JSON.parse(line.slice("RECONCILED ".length)) as { generation: number | null };
  return parsed.generation;
}

const liveInventory = JSON.stringify([
  { runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true },
]);
const emptyInventory = "[]";

let serverProcess: Bun.Subprocess | undefined;
let containerName: string | undefined;

try {
  const serverFile = join(workdir, "server.ts");
  await Bun.write(serverFile, serverScript);

  const runnerFile = join(workdir, "runner.ts");
  await Bun.write(runnerFile, runnerScript.replace("${INVENTORY}", liveInventory));

  // The control server always runs on the host; only the runners are containerized.
  const serverProc = Bun.spawn(["bun", "run", serverFile], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  serverProcess = serverProc;

  const serverOut = streamReader(serverProc.stdout);
  const serverErr = streamReader(serverProc.stderr);
  try {
    await serverOut.until("READY", 30000);
  } catch (error) {
    // The stderr is the only thing that explains a server that never printed
    // READY; swallowing it leaves a bare timeout.
    throw new Error(`${(error as Error).message}\nserver stderr: ${serverErr.text.slice(-2000)}`);
  }

  let firstOut = "";

  if (useDocker) {
    containerName = `cc-web-reconnect-${Date.now()}`;
    await Bun.$`docker run -d --name ${containerName} --network host -v ${repoRoot}:/app -v ${workdir}:/data cc-web-runner:dev sleep infinity`.quiet();
    await Bun.$`docker exec ${containerName} bun --version`.quiet();

    // Runner #1: reconciles while the run is genuinely alive. Spawned rather
    // than awaited with `.text()`, which would block until the process exits —
    // and this one deliberately holds its socket open.
    const first = Bun.spawn(["docker", "exec", containerName, "bun", "run", "/data/runner.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    firstOut = await streamReader(first.stdout).until("RECONCILED", 60000);
    check(
      "first connection reconciles and promotes to ready",
      firstOut.includes('"ready":true'),
      firstOut
        .trim()
        .split("\n")
        .find((l) => l.startsWith("RECONCILED")) ?? "no reconcile result",
    );

    // SIGKILL from outside the container: PID 1 in its own namespace ignores
    // the signal, and the test would then prove nothing.
    await Bun.$`docker kill --signal SIGKILL ${containerName}`.quiet();
    first.kill("SIGKILL");
    await first.exited.catch(() => {});
  } else {
    const first = Bun.spawn(["bun", "run", runnerFile], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    firstOut = await streamReader(first.stdout).until("RECONCILED", 30000);
    check(
      "first connection reconciles and promotes to ready",
      firstOut.includes('"ready":true'),
      firstOut
        .trim()
        .split("\n")
        .find((l) => l.startsWith("RECONCILED")) ?? "no reconcile result",
    );

    first.kill("SIGKILL");
    await first.exited;
  }

  // Runner #2 in a fresh process: nothing is alive, so the run cannot be
  // claimed as finished.
  const secondFile = join(workdir, "runner2.ts");
  await Bun.write(secondFile, runnerScript.replace("${INVENTORY}", emptyInventory));

  let secondOut: string;
  if (useDocker) {
    const second = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "-v",
        `${repoRoot}:/app`,
        "-v",
        `${workdir}:/data`,
        "cc-web-runner:dev",
        "bun",
        "run",
        "/data/runner2.ts",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    secondOut = await streamReader(second.stdout).until("RECONCILED", 90000);
    second.kill("SIGKILL");
    await second.exited.catch(() => {});
  } else {
    const second = Bun.spawn(["bun", "run", secondFile], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    secondOut = await streamReader(second.stdout).until("RECONCILED", 30000);
    second.kill("SIGKILL");
    await second.exited;
  }

  check(
    "reconnect after an unclean exit still promotes to ready",
    secondOut.includes('"ready":true'),
    secondOut
      .trim()
      .split("\n")
      .find((l) => l.startsWith("RECONCILED")) ?? "no reconcile result",
  );

  // Wait for the consequence, not for a delay: the run must become interrupted
  // because runner #2 reconciled with nothing alive.
  const deadline = Date.now() + 60000;
  let state = { promotions: 0, observed: null as string | null };
  while (Date.now() < deadline) {
    state = (await fetch("http://127.0.0.1:8931/state").then((r) => r.json())) as typeof state;
    if (state.observed !== null && state.promotions >= 2) break;
    await Bun.sleep(100);
  }

  check(
    "the vanished run is interrupted, not silently completed or failed",
    state.observed === "interrupted",
    `observed=${state.observed}`,
  );
  check(
    "both connections were promoted to ready",
    state.promotions >= 2,
    `promotions=${state.promotions}`,
  );

  const firstGen = generationOf(firstOut);
  const secondGen = generationOf(secondOut);
  check(
    "the reconnect holds a strictly higher generation than the dead connection",
    firstGen !== null && secondGen !== null && secondGen > firstGen,
    `first=${firstGen} second=${secondGen}`,
  );
} finally {
  if (containerName) {
    await Bun.$`docker rm -f ${containerName}`.quiet().catch(() => {});
  }
  serverProcess?.kill("SIGKILL");
  await rm(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`mode: ${useDocker ? "docker" : "process"}`);
  process.exit(1);
}
