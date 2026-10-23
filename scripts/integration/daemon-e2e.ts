#!/usr/bin/env bun
/**
 * End-to-end: the real runner daemon against the real control server (§22.2).
 *
 * Every other test fakes one side. This starts both as separate OS processes,
 * with the runner reading a real `identity.json` at mode 0600, and checks the
 * behaviour that only shows up when the two are actually talking:
 *
 *   1. the runner reaches `ready` over a real WebSocket
 *   2. kill the runner; the server sees the connection go away
 *   3. restart it; it reconnects and reaches `ready` again on a higher generation
 *   4. a runner with a bad credential comes up but never reaches `ready`
 *
 * Docker mode runs each runner as its own container with `--network host`, so
 * the connection crosses a real process boundary and the kill is a container
 * kill rather than a signal to a child. The control server always runs on the
 * host: it is the thing the runner is supposed to reach.
 *
 *   bun run scripts/integration/daemon-e2e.ts
 *   bun run scripts/integration/daemon-e2e.ts --docker
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const repoRoot = new URL("../..", import.meta.url).pathname;
const workdir = await mkdtemp(join(tmpdir(), "cc-web-daemon-"));

/** Inside a container the workdir is mounted at /data; on the host it is itself. */
const runnerIdentityDir = useDocker ? "/data/identity" : join(workdir, "identity");
const badIdentityDir = useDocker ? "/data/identity-bad" : join(workdir, "identity-bad");
const runnerModuleRoot = useDocker ? "/app/" : repoRoot;

/** The state endpoint the server exposes to this harness. */
const STATE_PORT = 8942;

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

type Output = {
  readonly text: string;
  until(marker: string, timeoutMs: number): Promise<string>;
};

function streamReader(stream: ReadableStream<Uint8Array> | number | undefined): Output {
  if (typeof stream !== "object" || stream === null) {
    throw new Error("expected a piped stream; the subprocess was spawned without stdout/stderr: 'pipe'");
  }

  // One reader for the process lifetime. Taking a second one later would throw
  // `ReadableStream is locked`, and the process would look silent instead.
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // Killed; what it printed is still evidence.
    }
  })();

  return {
    get text() {
      return buffer;
    },
    async until(marker, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${JSON.stringify(marker)}; got: ${buffer.slice(-600)}`);
        }
        await Bun.sleep(25);
      }
      return buffer;
    },
  };
}

/** A runner process, however it was started, with a way to kill it hard. */
type RunnerHandle = {
  output: Output;
  errors: Output;
  kill(): Promise<void>;
};

const serverScript = `
import { Database } from "bun:sqlite";
import { migrate } from "${repoRoot}packages/control-db/src/db.ts";
import { AuthService } from "${repoRoot}apps/control-server/src/auth/auth-service.ts";
import { createSigner } from "${repoRoot}apps/control-server/src/auth/tokens.ts";
import { createServer } from "${repoRoot}apps/control-server/src/server.ts";

const db = new Database(":memory:");
migrate(db);

const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(21)) });

const handle = createServer({
  db,
  auth,
  allowedOrigins: ["https://cc.example.test"],
  verifyRunnerCredential: (c) => c === "cck_valid"
    ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
    : { ok: false, reason: "unknown" },
});

console.log("READY " + handle.server.port);

const state = () => JSON.stringify({
  state: handle.runnerGateway.stateOf("runner-a"),
  generation: handle.runnerGateway.generationOf("runner-a") ?? null,
  promotions: handle.runnerGateway.promotions.get("runner-a") ?? 0,
});

Bun.serve({ port: ${STATE_PORT}, fetch() { return new Response(state()); } });
`;

const runnerScript = (identityDir: string) => `
import { startDaemon } from "${runnerModuleRoot}apps/runner/src/daemon.ts";

const daemon = await startDaemon({
  identityDir: ${JSON.stringify(identityDir)},
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  onEvent: (event) => console.log("EVENT " + JSON.stringify(event)),
});

console.log("DAEMON_STARTED " + daemon.identity.runnerId);
`;

let serverProc: Bun.Subprocess | undefined;
const containers: string[] = [];

try {
  // --- server ---
  const serverFile = join(workdir, "server.ts");
  await writeFile(serverFile, serverScript);

  serverProc = Bun.spawn(["bun", "run", serverFile], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const serverOut = streamReader(serverProc.stdout);
  const serverErr = streamReader(serverProc.stderr);

  let port: number;
  try {
    const ready = await serverOut.until("READY ", 30_000);
    port = Number(ready.split("READY ")[1]!.split("\n")[0]!.trim());
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver stderr: ${serverErr.text.slice(-2000)}`);
  }

  // --- identities, mode 0600 ---
  const writeIdentity = async (dir: string, credential: string) => {
    await Bun.$`mkdir -p ${dir}`.quiet();
    const path = join(dir, "identity.json");
    await writeFile(
      path,
      JSON.stringify({
        runnerId: "runner-a",
        controlUrl: `ws://127.0.0.1:${port}/ws/runner`,
        credential,
      }),
      { mode: 0o600 },
    );
    // `mode` on writeFile is masked by the umask; assert the real mode.
    await chmod(path, 0o600);
  };

  await writeIdentity(join(workdir, "identity"), "cck_valid");
  await writeIdentity(join(workdir, "identity-bad"), "cck_wrong");

  const runnerFile = join(workdir, "runner.ts");
  const badRunnerFile = join(workdir, "runner-bad.ts");
  await writeFile(runnerFile, runnerScript(runnerIdentityDir));
  await writeFile(badRunnerFile, runnerScript(badIdentityDir));

  const readState = async () =>
    (await fetch(`http://127.0.0.1:${STATE_PORT}/`).then((r) => r.json())) as {
      state: string;
      generation: number | null;
      promotions: number;
    };

  async function startRunner(script: string, label: string): Promise<RunnerHandle> {
    if (!useDocker) {
      const proc = Bun.spawn(["bun", "run", script], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
      return {
        output: streamReader(proc.stdout),
        errors: streamReader(proc.stderr),
        kill: async () => {
          proc.kill("SIGKILL");
          await proc.exited.catch(() => {});
        },
      };
    }

    // One container per runner process, so killing it is a container kill and a
    // restart is a fresh container — the same shape as a real deployment.
    const name = `cc-web-daemon-${label}-${Date.now()}`;
    containers.push(name);
    const proc = Bun.spawn(
      [
        "docker", "run", "--rm", "--name", name,
        "--network", "host",
        "-v", `${repoRoot}:/app`,
        "-v", `${workdir}:/data`,
        "cc-web-runner:dev",
        "bun", "run", `/data/${script.slice(workdir.length + 1)}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    return {
      output: streamReader(proc.stdout),
      errors: streamReader(proc.stderr),
      kill: async () => {
        // `docker kill` reaches the container's main process; the image has no
        // pkill or pgrep, and signal 9 matches what SIGKILL means here.
        await Bun.$`docker kill -s KILL ${name}`.quiet().catch(() => {});
        await proc.exited.catch(() => {});
      },
    };
  }

  const waitForPromotions = async (target: number, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let state = await readState();
    while (state.promotions < target && Date.now() < deadline) {
      await Bun.sleep(50);
      state = await readState();
    }
    return state;
  };

  const startAndAwaitBoot = async (script: string, label: string) => {
    const runner = await startRunner(script, label);
    try {
      await runner.output.until("DAEMON_STARTED", 60_000);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
      );
    }
    return runner;
  };

  // --- 1. first connection reaches ready ---
  const first = await startAndAwaitBoot(runnerFile, "first");
  let state = await waitForPromotions(1);

  check("the runner daemon reaches ready over a real socket", state.promotions >= 1, `promotions=${state.promotions}`);
  check("the ready state is recorded on the server", state.state === "ready", `state=${state.state}`);
  const firstGeneration = state.generation;

  // --- 2. kill the runner ---
  await first.kill();
  await Bun.sleep(300);

  const afterKill = await readState();
  check("the server sees the connection go away", afterKill.state === "offline", `state=${afterKill.state}`);

  // --- 3. restart reaches ready again on a higher generation ---
  const second = await startAndAwaitBoot(runnerFile, "second");
  state = await waitForPromotions(2);

  check("the restarted runner reaches ready again", state.promotions >= 2, `promotions=${state.promotions}`);
  check(
    "the reconnect holds a higher generation",
    state.generation !== null && firstGeneration !== null && state.generation > firstGeneration,
    `first=${firstGeneration} second=${state.generation}`,
  );

  await second.kill();

  // --- 4. a bad credential comes up but never promotes ---
  const bad = await startAndAwaitBoot(badRunnerFile, "bad");

  // The daemon starts even though it cannot connect: startup is not hostage to
  // the control server. What it must not do is claim to be connected.
  try {
    await bad.output.until('"type":"disconnected"', 20_000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nbad-runner stderr: ${bad.errors.text.slice(-2000)}`);
  }

  await Bun.sleep(1000);
  const finalState = await readState();
  check(
    "a runner with a bad credential never promotes",
    finalState.promotions === 2,
    `promotions=${finalState.promotions} (unchanged)`,
  );
  check(
    "a refused credential is never reported as ready",
    !bad.output.text.includes('"type":"ready"'),
    bad.output.text.includes('"type":"ready"') ? "saw a ready event" : "no ready event",
  );

  await bad.kill();
} finally {
  for (const name of containers) {
    await Bun.$`docker rm -f ${name}`.quiet().catch(() => {});
  }
  serverProc?.kill("SIGKILL");
  await rm(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`mode: ${useDocker ? "docker" : "process"}`);
  process.exit(1);
}
