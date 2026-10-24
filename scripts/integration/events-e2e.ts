#!/usr/bin/env bun
/**
 * End-to-end: a run's events reach the server journal (§12.1, §12.2).
 *
 * The durable-delivery side of events, crossing a real process boundary like
 * dispatch-e2e but proving the other direction: what a run leaves in the
 * runner's event outbox must arrive in the server's `run_events` table —
 * ordered, sequenced per session, and exactly once no matter how many times it
 * is sent.
 *
 *   1. a runner connects, reaches `ready`, and executes a dispatched run
 *   2. the server journal holds the run's events in order, with session
 *      sequences 1..N allocated at ingest
 *   3. the runner's outbox rows are retired by the server's ACK
 *   4. a lost ACK is simulated: the rows are flipped back to unacknowledged,
 *      the runner is restarted, and the whole batch is sent again
 *   5. the journal is unchanged — the resend answered `duplicate` for every
 *      row, no new sequence was allocated, nothing was audited as a conflict —
 *      and the re-ACK retires the rows again
 *
 * The last step is the whole design on one page: persist → send → ACK makes
 * delivery at-least-once, and journal dedup by event id makes it exactly-once
 * for the reader.
 *
 * Docker mode runs the runner in its own container on `--network host`, the
 * same as dispatch-e2e:
 *
 *   bun run scripts/integration/events-e2e.ts
 *   bun run scripts/integration/events-e2e.ts --docker
 */

import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const repoRoot = new URL("../..", import.meta.url).pathname;
const workdir = await mkdtemp(join(tmpdir(), "cc-web-events-"));

const runnerIdentityDir = useDocker ? "/data/identity" : join(workdir, "identity");
const runnerHomeHost = join(workdir, "runner-home");
const runnerHome = useDocker ? "/data/runner-home" : runnerHomeHost;
const workspaceHost = join(workdir, "project");
const workspace = useDocker ? "/data/project" : workspaceHost;
const runnerModuleRoot = useDocker ? "/app/" : repoRoot;
const runnerDbHost = join(runnerHomeHost, "runner.db");
const controlDbHost = join(workdir, "control.sqlite");

const CONTROL_PORT = 8944;

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
 * Reads a SQLite file another process is writing, through a fresh short-lived
 * connection per call. The journal is the evidence here — a socket write is not
 * — so the harness reads the databases rather than trusting either side's logs.
 */
function readRows<T>(dbPath: string, query: string, ...params: (string | number | null)[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

const serverScript = `
import { Database } from "bun:sqlite";
import { CommandOutbox, migrate, Scheduler } from "${repoRoot}packages/control-db/src/index.ts";
import { AuthService } from "${repoRoot}apps/control-server/src/auth/auth-service.ts";
import { createSigner } from "${repoRoot}apps/control-server/src/auth/tokens.ts";
import { createServer } from "${repoRoot}apps/control-server/src/server.ts";

const db = new Database(${JSON.stringify(controlDbHost)});
migrate(db);

const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(41)) });
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

    return new Response("not found", { status: 404 });
  },
});
`;

/** The runner daemon with the model faked at the adapter seam, as in dispatch-e2e. */
const runnerScript = `
import { startDaemon } from "${runnerModuleRoot}apps/runner/src/daemon.ts";

const daemon = await startDaemon({
  identityDir: ${JSON.stringify(runnerIdentityDir)},
  databasePath: ${JSON.stringify(`${runnerHome}/runner.db`)},
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  workspacePathFor: (id) => (id === "workspace-1" ? ${JSON.stringify(workspace)} : undefined),
  sdk: (input) => (async function* () {
    console.log("SDK_CALL " + JSON.stringify({ prompt: input.prompt, cwd: input.cwd }));
    yield { type: "system", subtype: "init", session_id: "sdk-session-1" };
    yield { type: "assistant", message: { role: "assistant", content: "done" } };
    yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01 };
  })(),
});

console.log("DAEMON_STARTED " + daemon.identity.runnerId);
`;

let serverProc: Bun.Subprocess | undefined;
const containers: string[] = [];

try {
  // --- server ---
  const serverFile = join(workdir, "server.ts");
  await writeFile(serverFile, serverScript);

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
  await Bun.$`mkdir -p ${join(workdir, "identity")} ${runnerHomeHost} ${workspaceHost}`.quiet();
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
  await writeFile(runnerFile, runnerScript);

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

    const name = `cc-web-events-${Date.now()}`;
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

  type JournalRow = {
    type: string;
    session_sequence: number;
    local_sequence: number;
    runner_id: string;
  };

  const journal = () =>
    readRows<JournalRow>(
      controlDbHost,
      "SELECT type, session_sequence, local_sequence, runner_id FROM run_events WHERE attempt_id = ? ORDER BY session_sequence",
      "attempt-1",
    );

  const conflictCount = () =>
    readRows<{ n: number }>(controlDbHost, "SELECT COUNT(*) AS n FROM event_ingest_conflicts")[0]
      ?.n ?? -1;

  const unacked = () =>
    readRows<{ n: number }>(
      runnerDbHost,
      "SELECT COUNT(*) AS n FROM event_outbox WHERE attempt_id = ? AND acknowledged = 0",
      "attempt-1",
    )[0]?.n ?? -1;

  // --- 1. connect, dispatch, execute ---
  const runner = await startRunner();
  try {
    await runner.output.until("DAEMON_STARTED", 60_000);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
    );
  }

  const state = await waitForState((s) => s.state === "ready");
  check("the runner reaches ready", state.state === "ready", `state=${state.state}`);

  const decision = (await fetch(control("/dispatch"), { method: "POST" }).then((r) =>
    r.json(),
  )) as {
    ok: boolean;
    reason?: string;
  };
  check("the dispatch is accepted", decision.ok === true, `ok=${decision.ok}`);

  try {
    await runner.output.until("SDK_CALL ", 20_000);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
    );
  }

  // --- 2. the journal fills, in order, with sequences allocated at ingest ---
  const EXPECTED = "run.started,session.updated,message.completed,run.finished";
  let rows: JournalRow[] = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    rows = journal();
    if (rows.length >= 4) break;
    await Bun.sleep(50);
  }

  check(
    "the journal holds the run's events in order",
    rows.map((r) => r.type).join(",") === EXPECTED,
    rows.map((r) => r.type).join(",") || "empty",
  );
  check(
    "session sequences are allocated 1..N at ingest (§12.1)",
    rows.map((r) => r.session_sequence).join(",") === "1,2,3,4" &&
      rows.map((r) => r.local_sequence).join(",") === "1,2,3,4",
    `session=${rows.map((r) => r.session_sequence).join(",")} local=${rows.map((r) => r.local_sequence).join(",")}`,
  );
  check(
    "the journal attributes the events to the authenticated runner",
    rows.every((r) => r.runner_id === "runner-a"),
    rows[0]?.runner_id ?? "empty",
  );

  // --- 3. the ACK retires the runner's rows ---
  let retired = false;
  const ackDeadline = Date.now() + 20_000;
  while (Date.now() < ackDeadline) {
    if (unacked() === 0) {
      retired = true;
      break;
    }
    await Bun.sleep(50);
  }
  check("the server's ACK retires every outbox row", retired, `unacked=${unacked()}`);

  // --- 4. simulate a lost ACK: un-retire the rows, restart, resend ---
  await runner.kill();
  await Bun.sleep(300);
  const offline = await waitForState((s) => s.state === "offline", 10_000);
  check(
    "the server sees the runner go away",
    offline.state === "offline",
    `state=${offline.state}`,
  );

  // Exactly what a lost ACK looks like on the runner's side: the journal has
  // the events, the outbox still believes them undelivered.
  const flip = new Database(runnerDbHost);
  try {
    flip.prepare("UPDATE event_outbox SET acknowledged = 0 WHERE attempt_id = ?").run("attempt-1");
  } finally {
    flip.close();
  }
  check("the lost-ACK simulation leaves rows pending", unacked() === 4, `unacked=${unacked()}`);

  const resumed = await startRunner();
  try {
    await resumed.output.until("DAEMON_STARTED", 60_000);
    const back = await waitForState((s) => s.promotions >= 2, 20_000);
    check(
      "the restarted runner is promoted again",
      back.promotions >= 2,
      `promotions=${back.promotions}`,
    );

    // The pump sends the batch on ready; the journal must answer `duplicate`
    // for every row and the re-ACK must retire them again.
    let resettled = false;
    const resendDeadline = Date.now() + 20_000;
    while (Date.now() < resendDeadline) {
      if (unacked() === 0) {
        resettled = true;
        break;
      }
      await Bun.sleep(50);
    }

    // --- 5. exactly once for the reader, however many times sent ---
    const after = journal();
    check(
      "the resend adds nothing to the journal",
      after.length === 4 && after.map((r) => r.type).join(",") === EXPECTED,
      `rows=${after.length} (${after.map((r) => r.type).join(",")})`,
    );
    check(
      "the resend allocated no new session sequence",
      after.map((r) => r.session_sequence).join(",") === "1,2,3,4",
      after.map((r) => r.session_sequence).join(","),
    );
    check(
      "the resend was audited as nothing",
      conflictCount() === 0,
      `conflicts=${conflictCount()}`,
    );
    check("the re-ACK retires the rows again", resettled, `unacked=${unacked()}`);
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
