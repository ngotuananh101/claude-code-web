#!/usr/bin/env bun
/**
 * End-to-end: the browser sees a session — replay, live tail, resync (§12.5).
 *
 * The journal exists so the browser can be late: late to connect, slow during
 * a run, or back after retention has trimmed history. This probe drives the
 * whole §12.5 contract across real processes:
 *
 *   1. a run completes while nobody is watching; a browser then subscribes
 *      with `afterSessionSequence: 0` and the whole run is replayed, in order,
 *      marked not-live
 *   2. a second run on the same session executes with the browser already
 *      subscribed: its events arrive as they commit, marked live
 *   3. the client's combined view is contiguous with no duplicates across the
 *      replay/live boundary
 *   4. simulated retention (early rows deleted): a subscription whose offset
 *      points into the deleted range is answered `session.resync_required`
 *      naming the earliest surviving sequence — never a silently truncated
 *      stream
 *
 * The model is faked at the adapter seam exactly as in dispatch-e2e; the
 * browser is a real WebSocket client speaking the real frames.
 *
 *   bun run scripts/integration/browser-replay-e2e.ts
 *   bun run scripts/integration/browser-replay-e2e.ts --docker
 */

import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useDocker = process.argv.includes("--docker");
const repoRoot = new URL("../..", import.meta.url).pathname;
const workdir = await mkdtemp(join(tmpdir(), "cc-web-replay-"));

const runnerIdentityDir = useDocker ? "/data/identity" : join(workdir, "identity");
const runnerHomeHost = join(workdir, "runner-home");
const runnerHome = useDocker ? "/data/runner-home" : runnerHomeHost;
const workspaceHost = join(workdir, "project");
const workspace = useDocker ? "/data/project" : workspaceHost;
const runnerModuleRoot = useDocker ? "/app/" : repoRoot;
const runnerDbHost = join(runnerHomeHost, "runner.db");
const controlDbHost = join(workdir, "control.sqlite");

const CONTROL_PORT = 8945;
const ORIGIN = "https://cc.example.test";

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

/** Reads a SQLite file another process is writing, through a fresh connection. */
function readColumn<T>(dbPath: string, query: string, ...params: (string | number)[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

type BrowserFrame = {
  type: string;
  sessionId?: string;
  live?: boolean;
  through?: number;
  fromSequence?: number;
  events?: Array<{ sessionSequence: number; type: string }>;
};

/** A real browser WebSocket: origin and cookie on the upgrade, frames after. */
async function browserClient(
  url: string,
  cookie: string,
): Promise<{
  frames: BrowserFrame[];
  send(message: unknown): void;
  close(): void;
  waitUntil(predicate: (frames: BrowserFrame[]) => boolean, timeoutMs?: number): Promise<void>;
}> {
  const frames: BrowserFrame[] = [];
  const socket = new WebSocket(url, {
    headers: { Origin: ORIGIN, Cookie: cookie },
  } as never);

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("browser socket failed to open")));
  });
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as BrowserFrame);
  });
  await opened;

  return {
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    async waitUntil(predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for frames; got: ${JSON.stringify(frames.slice(-6))}`);
        }
        await Bun.sleep(25);
      }
    },
  };
}

const serverScript = `
import { Database } from "bun:sqlite";
import { CommandOutbox, migrate, Scheduler } from "${repoRoot}packages/control-db/src/index.ts";
import { createBetterAuth, signUpOwner } from "${repoRoot}apps/control-server/src/auth/better-auth.ts";
import { createServer } from "${repoRoot}apps/control-server/src/server.ts";

const db = new Database(${JSON.stringify(controlDbHost)});
migrate(db);

const auth = createBetterAuth(db, { baseURL: "http://control.test", trustedOrigins: [${JSON.stringify(ORIGIN)}] });
await signUpOwner(auth, { username: "owner", password: "dev-password" });
const ownerId = db.query("SELECT id FROM user WHERE username = 'owner'").get().id;

// Ownership (§12.5): this owner's runner. A session inherits ownership from
// the runner that owns its work, so the row has to exist before any dispatch.
db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)")
  .run("runner-a", ownerId, 1);

const outbox = new CommandOutbox(db);

const handle = createServer({
  db,
  auth,
  allowedOrigins: [${JSON.stringify(ORIGIN)}],
  verifyRunnerCredential: (c) => c === "cck_valid"
    ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
    : { ok: false, reason: "unknown" },
  outbox,
});

// A real sign-in: the cookie pair the harness sends on the browser upgrade.
const signIn = await auth.handler(new Request("http://control.test/api/auth/sign-in/username", {
  method: "POST",
  headers: { "content-type": "application/json", origin: ${JSON.stringify(ORIGIN)} },
  body: JSON.stringify({ username: "owner", password: "dev-password" }),
}));
const cookiePair = signIn.headers.get("set-cookie").split(";")[0];

console.log("COOKIE " + cookiePair);
console.log("READY " + handle.server.port);

Bun.serve({
  port: ${CONTROL_PORT},
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({ state: handle.runnerGateway.stateOf("runner-a") });
    }

    if (url.pathname === "/dispatch") {
      const run = Number(url.searchParams.get("run") ?? "1");
      const decision = await handle.scheduler.dispatch(
        {
          sessionId: "session-1",
          runId: "run-" + run,
          attemptId: "attempt-" + run,
          workspaceId: "workspace-1",
          prompt: "hello from the harness, run " + run,
        },
        { runnerId: "runner-a", state: handle.runnerGateway.stateOf("runner-a"), maxConcurrentRuns: 1, activeRuns: 0 },
      );
      return Response.json(decision);
    }

    if (url.pathname === "/release") {
      // Frees the session slot once a run is terminal. In the product this is a
      // projection's job; here the harness drives it explicitly.
      handle.scheduler.release("run-" + (url.searchParams.get("run") ?? "1"));
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});
`;

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
let browser: Awaited<ReturnType<typeof browserClient>> | undefined;

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
  let cookie: string;
  try {
    const out = await serverOut.until("READY ", 30_000);
    port = Number(out.split("READY ")[1]!.split("\n")[0]!.trim());
    cookie = out.split("COOKIE ")[1]!.split("\n")[0]!.trim();
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
    (await fetch(control("/state")).then((r) => r.json())) as { state: string };

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

    const name = `cc-web-replay-${Date.now()}`;
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

  const waitForState = async (state: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let current = await readState();
    while (current.state !== state && Date.now() < deadline) {
      await Bun.sleep(50);
      current = await readState();
    }
    return current;
  };

  const waitForAttempt = async (attemptId: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = readColumn<{ state: string }>(
        runnerDbHost,
        "SELECT state FROM local_attempts WHERE attempt_id = ?",
        attemptId,
      )[0];
      if (row !== undefined && row.state !== "starting") return row;
      if (Date.now() > deadline) return row ?? { state: "missing" };
      await Bun.sleep(50);
    }
  };

  // --- 1. a run completes while nobody is watching ---
  const runner = await startRunner();
  try {
    await runner.output.until("DAEMON_STARTED", 60_000);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stderr: ${runner.errors.text.slice(-2000)}\nserver stderr: ${serverErr.text.slice(-2000)}`,
    );
  }

  const ready = await waitForState("ready");
  check("the runner reaches ready", ready.state === "ready", `state=${ready.state}`);

  const first = (await fetch(control("/dispatch?run=1"), { method: "POST" }).then((r) =>
    r.json(),
  )) as { ok: boolean };
  check("the first dispatch is accepted", first.ok === true, `ok=${first.ok}`);

  const attempt1 = await waitForAttempt("attempt-1");
  check("the first run completes", attempt1.state === "finished", `state=${attempt1.state}`);

  // --- 2. the browser arrives late and replays ---
  browser = await browserClient(`ws://127.0.0.1:${port}/ws/browser`, cookie);
  browser.send({ type: "subscribe", sessionId: "session-1", afterSessionSequence: 0 });
  await browser.waitUntil((frames) =>
    frames.some((f) => f.type === "session.events" && (f.through ?? 0) >= 4),
  );

  const replay = browser.frames.find((f) => f.type === "session.events");
  check(
    "the whole run is replayed in order, marked not-live",
    replay !== undefined &&
      replay.live === false &&
      replay.events!.map((e) => [e.sessionSequence, e.type]).join("|") ===
        "1,run.started|2,session.updated|3,message.completed|4,run.finished",
    replay === undefined ? "no replay frame" : replay.events!.map((e) => e.type).join(","),
  );

  // --- 3. a second run while the browser is watching ---
  await fetch(control("/release?run=1"), { method: "POST" });
  const second = (await fetch(control("/dispatch?run=2"), { method: "POST" }).then((r) =>
    r.json(),
  )) as { ok: boolean };
  check(
    "the second dispatch is accepted on the freed session",
    second.ok === true,
    `ok=${second.ok}`,
  );

  try {
    await browser.waitUntil((frames) =>
      frames.some((f) => f.type === "session.events" && f.live === true && (f.through ?? 0) >= 8),
    );
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nrunner stdout: ${runner.output.text
        .split("\n")
        .filter((l) => l.startsWith("SDK_CALL") || l.startsWith("EVENT"))
        .join(
          " | ",
        )}\nrunner stderr: ${runner.errors.text.slice(-1500)}\nserver stderr: ${serverErr.text.slice(-1500)}\njournal: ${JSON.stringify(readColumn(controlDbHost, "SELECT session_sequence, type, attempt_id FROM run_events ORDER BY session_sequence"))}\nattempt-2: ${JSON.stringify(readColumn(runnerDbHost, "SELECT state FROM local_attempts WHERE attempt_id = 'attempt-2'"))}`,
    );
  }
  const attempt2 = await waitForAttempt("attempt-2");

  const liveSequences = browser.frames
    .filter((f) => f.type === "session.events" && f.live === true)
    .flatMap((f) => f.events!.map((e) => e.sessionSequence));
  check(
    "the live tail carries the second run as it commits",
    liveSequences.join(",") === "5,6,7,8",
    liveSequences.join(","),
  );

  const seen = browser.frames
    .filter((f) => f.type === "session.events")
    .flatMap((f) => f.events!.map((e) => e.sessionSequence));
  check(
    "the combined view is contiguous with no duplicate across replay and live",
    seen.join(",") === "1,2,3,4,5,6,7,8",
    seen.join(","),
  );
  check("the second run completes", attempt2.state === "finished", `state=${attempt2.state}`);

  browser.close();
  browser = undefined;

  // --- 4. retention: an offset into deleted history answers resync_required ---
  const trim = new Database(controlDbHost);
  try {
    trim
      .prepare("DELETE FROM run_events WHERE session_id = ? AND session_sequence <= 2")
      .run("session-1");
  } finally {
    trim.close();
  }

  const resyncClient = await browserClient(`ws://127.0.0.1:${port}/ws/browser`, cookie);
  try {
    resyncClient.send({ type: "subscribe", sessionId: "session-1", afterSessionSequence: 0 });
    await resyncClient.waitUntil((frames) =>
      frames.some((f) => f.type === "session.resync_required"),
    );

    const resync = resyncClient.frames.find((f) => f.type === "session.resync_required");
    check(
      "an offset into deleted history is answered resync_required, never a truncated stream",
      resync !== undefined && resync.fromSequence === 3,
      resync === undefined ? "no resync frame" : `fromSequence=${resync.fromSequence}`,
    );

    // And the prescribed recovery — resubscribe from the named sequence — works.
    resyncClient.send({ type: "subscribe", sessionId: "session-1", afterSessionSequence: 3 });
    await resyncClient.waitUntil(
      (frames) => frames.filter((f) => f.type === "session.events").at(-1)?.through === 8,
    );
    const recovered = resyncClient.frames.filter((f) => f.type === "session.events").at(-1)!;
    check(
      "resubscribing from the named sequence replays the surviving tail",
      recovered.events!.map((e) => e.sessionSequence).join(",") === "4,5,6,7,8",
      recovered.events!.map((e) => e.sessionSequence).join(","),
    );
  } finally {
    resyncClient.close();
  }

  await runner.kill();
} finally {
  browser?.close();
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
