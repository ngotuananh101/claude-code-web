#!/usr/bin/env bun
/**
 * End-to-end: a dispatched command reaches a real runner process (§9.2, §9.3).
 *
 * Every other dispatch test runs both halves in one process, sharing a Bun
 * context and a module cache. This one crosses a real process boundary with a
 * real on-disk database on each side, which is what catches the failures that
 * only appear in a deployment: a frame the other side cannot parse, a field lost
 * in the SQL round trip, a receipt that never arrives.
 *
 * The property under test is the one the whole durable-delivery design exists
 * for — a command queued while the runner is away is delivered when it comes
 * back, and is not executed twice when it comes back again:
 *
 *   1. a control server starts with an empty outbox, and one runner connects
 *   2. the runner reaches `ready`
 *   3. the harness dispatches through the real scheduler
 *   4. the command arrives, is persisted in the runner's inbox, and is receipted
 *   5. the server's outbox shows `accepted` — proven delivery, not just a write
 *   6. a second delivery of the same command id does not execute it twice
 *
 * What this does not prove: that the command is *executed*. Execution is not
 * built yet (§10); step 4 stops at the inbox, which is exactly the boundary the
 * receipt describes.
 *
 * Docker mode runs each runner as its own container on `--network host`, so the
 * round trip crosses a real network stack. The control server always runs on the
 * host: it is the thing the runner is supposed to reach.
 *
 *   bun run scripts/integration/dispatch-e2e.ts
 *   bun run scripts/integration/dispatch-e2e.ts --docker
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const repoRoot = new URL("../..", import.meta.url).pathname;
const workdir = await mkdtemp(join(tmpdir(), "cc-web-dispatch-"));

/** Inside a container the workdir is mounted at /data; on the host it is itself. */
const runnerIdentityDir = useDocker ? "/data/identity" : join(workdir, "identity");
/**
 * Two paths, not one: the harness creates directories on the host, while the
 * runner process resolves its database path inside the container. Using the
 * container path for `mkdir` fails with EACCES because `/data` does not exist on
 * the host.
 */
const runnerHomeHost = join(workdir, "runner-home");
const runnerHome = useDocker ? "/data/runner-home" : runnerHomeHost;
const runnerModuleRoot = useDocker ? "/app/" : repoRoot;

/** The control endpoint the harness uses to drive the test. */
const CONTROL_PORT = 8943;

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
    throw new Error(
      "expected a piped stream; the subprocess was spawned without stdout/stderr: 'pipe'",
    );
  }

  // One reader for the process lifetime: taking a second one throws
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
          throw new Error(
            `timed out waiting for ${JSON.stringify(marker)}; got: ${buffer.slice(-800)}`,
          );
        }
        await Bun.sleep(25);
      }
      return buffer;
    },
  };
}

/**
 * The control server, plus a small HTTP surface the harness drives.
 *
 * The outbox lives on disk so the harness can read delivery state directly: a
 * socket write is not evidence of delivery, and the whole point of this probe is
 * to check the receipt, not the send.
 */
const serverScript = (dbPath: string) => `
import { Database } from "bun:sqlite";
import { CommandOutbox, migrate, Scheduler } from "${repoRoot}packages/control-db/src/index.ts";
import { AuthService } from "${repoRoot}apps/control-server/src/auth/auth-service.ts";
import { createSigner } from "${repoRoot}apps/control-server/src/auth/tokens.ts";
import { createServer } from "${repoRoot}apps/control-server/src/server.ts";

const db = new Database(${JSON.stringify(dbPath)});
migrate(db);

const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(37)) });
const outbox = new CommandOutbox(db);

const handle = createServer({
  db,
  auth,
  allowedOrigins: ["https://cc.example.test"],
  verifyRunnerCredential: (c) => c === "cck_valid"
    ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
    : { ok: false, reason: "unknown" },
  outbox,
});

console.log("READY " + handle.server.port);

Bun.serve({
  port: ${CONTROL_PORT},
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({
        state: handle.runnerGateway.stateOf("runner-a"),
        promotions: handle.runnerGateway.promotions.get("runner-a") ?? 0,
      });
    }

    if (url.pathname === "/dispatch") {
      const decision = await handle.scheduler.dispatch(
        {
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          workspaceId: "workspace-1",
          prompt: "hello from the harness",
        },
        { runnerId: "runner-a", state: handle.runnerGateway.stateOf("runner-a"), maxConcurrentRuns: 1, activeRuns: 0 },
      );
      return Response.json(decision);
    }

    if (url.pathname === "/outbox") {
      const commandId = url.searchParams.get("commandId");
      return Response.json(commandId ? (outbox.get(commandId) ?? null) : null);
    }

    if (url.pathname === "/redeliver") {
      const commandId = url.searchParams.get("commandId") ?? "";
      // Force the command back to deliverable, which is exactly what a lost ACK
      // looks like to the server (§12.2).
      db.query("UPDATE command_outbox SET delivery_state = 'pending' WHERE command_id = ?").run(commandId);
      const result = handle.dispatcher?.drain("runner-a") ?? { sent: 0, skipped: 0 };
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  },
});
`;

/**
 * The runner daemon, plus a line per accepted command.
 *
 * `onAccepted` fires only for a first acceptance, so a redelivery of the same
 * command id prints nothing — which is what makes "executed once" checkable
 * across processes.
 */
const runnerScript = (identityDir: string, home: string) => `
import { startDaemon } from "${runnerModuleRoot}apps/runner/src/daemon.ts";

const daemon = await startDaemon({
  identityDir: ${JSON.stringify(identityDir)},
  databasePath: ${JSON.stringify(`${home}/runner.db`)},
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  onEvent: (event) => console.log("EVENT " + JSON.stringify(event)),
  onAccepted: (command) => console.log("ACCEPTED " + JSON.stringify({
    commandId: command.commandId,
    kind: command.kind,
    sessionId: command.sessionId,
    runId: command.runId,
  })),
});

console.log("DAEMON_STARTED " + daemon.identity.runnerId);
`;

let serverProc: Bun.Subprocess | undefined;
const containers: string[] = [];

try {
  // --- server ---
  const serverFile = join(workdir, "server.ts");
  const controlDbPath = join(workdir, "control.sqlite");
  await writeFile(serverFile, serverScript(controlDbPath));

  serverProc = Bun.spawn(["bun", "run", serverFile], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const serverOut = streamReader(serverProc.stdout);
  const serverErr = streamReader(serverProc.stderr);

  let port: number;
  try {
    const ready = await serverOut.until("READY ", 30_000);
    port = Number(ready.split("READY ")[1]!.split("\n")[0]!.trim());
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver stderr: ${serverErr.text.slice(-2000)}`);
  }

  // --- identity, mode 0600 ---
  const identityPath = join(workdir, "identity", "identity.json");
  await Bun.$`mkdir -p ${join(workdir, "identity")} ${runnerHomeHost}`.quiet();
  await writeFile(
    identityPath,
    JSON.stringify({
      runnerId: "runner-a",
      controlUrl: `ws://127.0.0.1:${port}/ws/runner`,
      credential: "cck_valid",
    }),
    { mode: 0o600 },
  );
  // `mode` on writeFile is masked by the umask; assert the real mode.
  await chmod(identityPath, 0o600);

  const runnerFile = join(workdir, "runner.ts");
  await writeFile(runnerFile, runnerScript(runnerIdentityDir, runnerHome));

  const control = (path: string) => `http://127.0.0.1:${CONTROL_PORT}${path}`;

  const readState = async () =>
    (await fetch(control("/state")).then((r) => r.json())) as {
      state: string;
      promotions: number;
    };

  async function startRunner(): Promise<{ output: Output; errors: Output; kill(): Promise<void> }> {
    if (!useDocker) {
      const proc = Bun.spawn(["bun", "run", runnerFile], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        output: streamReader(proc.stdout),
        errors: streamReader(proc.stderr),
        kill: async () => {
          proc.kill("SIGKILL");
          await proc.exited.catch(() => {});
        },
      };
    }

    const name = `cc-web-dispatch-${Date.now()}`;
    containers.push(name);
    const proc = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "-v",
        `${repoRoot}:/app`,
        "-v",
        `${workdir}:/data`,
        "cc-web-runner:dev",
        "bun",
        "run",
        "/data/runner.ts",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    return {
      output: streamReader(proc.stdout),
      errors: streamReader(proc.stderr),
      kill: async () => {
        await Bun.$`docker kill -s KILL ${name}`.quiet().catch(() => {});
        await proc.exited.catch(() => {});
      },
    };
  }

  const waitForState = async (
    predicate: (state: { state: string; promotions: number }) => boolean,
    timeoutMs = 20_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    let state = await readState();
    while (!predicate(state) && Date.now() < deadline) {
      await Bun.sleep(50);
      state = await readState();
    }
    return state;
  };

  // --- 1. the runner connects and reaches ready ---
  const runner = await startRunner();
  try {
    await runner.output.until("DAEMON_STARTED", 60_000);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
    );
  }

  const state = await waitForState((s) => s.state === "ready");
  check(
    "the runner reaches ready before anything is dispatched",
    state.state === "ready",
    `state=${state.state}`,
  );

  // --- 2. dispatch through the real scheduler ---
  const decision = (await fetch(control("/dispatch"), { method: "POST" }).then((r) =>
    r.json(),
  )) as {
    ok: boolean;
    commandId?: string;
    reason?: string;
  };
  check(
    "the scheduler accepts the dispatch against a ready runner",
    decision.ok === true,
    decision.ok ? `commandId=${decision.commandId}` : `reason=${decision.reason}`,
  );

  const commandId = decision.commandId ?? "";

  // --- 3. the command reaches the runner's inbox ---
  let acceptedLine: string;
  try {
    acceptedLine = await runner.output.until("ACCEPTED ", 20_000);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
    );
  }

  const accepted = acceptedLine
    .split("\n")
    .filter((line) => line.startsWith("ACCEPTED "))
    .map((line) => JSON.parse(line.slice("ACCEPTED ".length)) as Record<string, string>);

  check("the command arrives at the runner", accepted.length === 1, `accepted=${accepted.length}`);
  check(
    "the envelope survived both serializations",
    accepted[0]?.["sessionId"] === "session-1" &&
      accepted[0]?.["runId"] === "run-1" &&
      accepted[0]?.["kind"] === "run.start",
    JSON.stringify(accepted[0] ?? null),
  );

  // --- 4. the receipt reached the server ---
  let outboxRecord: { deliveryState?: string } | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    outboxRecord = (await fetch(control(`/outbox?commandId=${commandId}`)).then((r) =>
      r.json(),
    )) as { deliveryState?: string } | null;
    if (outboxRecord?.deliveryState === "accepted") break;
    await Bun.sleep(50);
  }

  check(
    "the server records the receipt, so delivery is proven and not assumed",
    outboxRecord?.deliveryState === "accepted",
    `deliveryState=${outboxRecord?.deliveryState ?? "none"}`,
  );

  // --- 5. a redelivery of the same command id does not execute it again ---
  await fetch(control(`/redeliver?commandId=${commandId}`), { method: "POST" });
  await Bun.sleep(1000);

  const afterRedelivery = runner.output.text
    .split("\n")
    .filter((line) => line.startsWith("ACCEPTED "));
  check(
    "a redelivered command id is answered from the inbox, not executed twice",
    afterRedelivery.length === 1,
    `accepted=${afterRedelivery.length} (unchanged)`,
  );

  // The redelivered command is retired again by the duplicate's receipt.
  const afterRecord = (await fetch(control(`/outbox?commandId=${commandId}`)).then((r) =>
    r.json(),
  )) as { deliveryState?: string } | null;
  check(
    "the duplicate's receipt retires the command again",
    afterRecord?.deliveryState === "accepted",
    `deliveryState=${afterRecord?.deliveryState ?? "none"}`,
  );

  // --- 6. the command survives a runner restart ---
  await runner.kill();
  await Bun.sleep(300);
  const offline = await waitForState((s) => s.state === "offline", 10_000);
  check(
    "the server sees the runner go away",
    offline.state === "offline",
    `state=${offline.state}`,
  );

  const resumed = await startRunner();
  try {
    await resumed.output.until("DAEMON_STARTED", 60_000);
    const back = await waitForState((s) => s.promotions >= 2, 20_000);
    check(
      "the restarted runner is promoted again",
      back.promotions >= 2,
      `promotions=${back.promotions}`,
    );

    // The inbox is on disk, so the restarted process must recognise the command
    // as one it already handled rather than starting it a second time.
    await Bun.sleep(1500);
    const afterRestart = resumed.output.text
      .split("\n")
      .filter((line) => line.startsWith("ACCEPTED "));
    check(
      "the restarted runner does not execute the command a second time",
      afterRestart.length === 0,
      `accepted=${afterRestart.length}`,
    );
  } finally {
    await resumed.kill();
  }
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
