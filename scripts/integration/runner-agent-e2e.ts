#!/usr/bin/env bun
/**
 * End-to-end: the compiled runner binary executes a REAL agent run (§20.3).
 *
 * `runner-binary.ts` proves the compiled artifact's connector behaviors. This
 * one proves the thing the architecture doc says was never verified: that the
 * binary can run the Claude Agent SDK for real. Inside a single executable the
 * SDK cannot resolve its native CLI — the asset is embedded at build time and
 * extracted at first use — so every link has to hold at once:
 *
 *   1. `build:runner` embeds the platform CLI into dist/cc-web-runner
 *   2. the binary connects to a real control server and reaches `ready`
 *   3. the scheduler dispatches a run; the REAL adapter (no injected `sdk`)
 *      extracts the CLI out of `$bunfs` and spawns it
 *   4. the CLI boots: a `session.updated` event carries the SDK's init frame
 *   5. the run reaches a terminal state whose error is never asset-shaped
 *
 * The acceptable terminal outcomes are deliberately broad — with host
 * credentials the run finishes; on a CI host without any, it fails with an
 * auth-shaped error ("Not logged in · Please run /login"); a sandboxed host
 * may fail on network. All of them prove the CLI ran. The one outcome this
 * probe exists to catch is the SDK's asset-resolution failure
 * ("Native CLI binary … not found"), which would mean the wrong binary shipped.
 *
 *   bun run scripts/integration/runner-agent-e2e.ts
 */

import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;
const workdir = await mkdtemp(join(tmpdir(), "cc-web-agent-e2e-"));
const workspaceHost = join(workdir, "project");
const runnerHome = join(workdir, "runner-home");
const identityPath = join(runnerHome, "identity.json");
const runnerDbPath = join(runnerHome, "runner.db");
const binary = join(repoRoot, "dist", "cc-web-runner");
const CONTROL_PORT = 8947;

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
    throw new Error("expected a piped stream; spawn the subprocess with stdout/stderr: 'pipe'");
  }
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

const serverScript = `
import { Database } from "bun:sqlite";
import { CommandOutbox, migrate, Scheduler } from "${repoRoot}packages/control-db/src/index.ts";
import { AuthService } from "${repoRoot}apps/control-server/src/auth/auth-service.ts";
import { createSigner } from "${repoRoot}apps/control-server/src/auth/tokens.ts";
import { createServer } from "${repoRoot}apps/control-server/src/server.ts";

const db = new Database("${join(workdir, "control.sqlite")}");
migrate(db);

// The hello's workspace declaration carries a foreign key into runners, and
// the credential verifier below is a stub — so the row the declaration
// references must exist before the runner connects.
db.query("INSERT INTO runners (id, owner_id, created_at, revoked_at) VALUES ('runner-a', 'user-1', ?, NULL)").run(Date.now());

const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
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

try {
  Bun.serve({
    port: ${CONTROL_PORT},
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/state") {
        return Response.json({ state: handle.runnerGateway.stateOf("runner-a") });
      }
      if (url.pathname === "/dispatch") {
        const decision = await handle.scheduler.dispatch(
          {
            sessionId: "session-1",
            runId: "run-1",
            attemptId: "attempt-1",
            workspaceId: "default",
            ownerId: "user-1",
            prompt:
              "Use the Bash tool to run the command 'echo hi', then reply with exactly the word OK and nothing else.",
          },
          {
            runnerId: "runner-a",
            state: handle.runnerGateway.stateOf("runner-a"),
            maxConcurrentRuns: 1,
            activeRuns: 0,
          },
        );
        return Response.json(decision);
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log("HTTP_READY");
} catch (error) {
  console.error("HTTP_SERVE_FAILED " + String(error));
  process.exit(1);
}
`;

let serverProc: Bun.Subprocess | undefined;
let runnerProc: Bun.Subprocess | undefined;

try {
  // --- 1. build the binary through build:runner (the asset-shim path) ---
  console.log("building dist/cc-web-runner (bun run build:runner)…");
  const build = Bun.spawnSync(["bun", "run", "build:runner", "--outfile", binary], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  check(
    "build:runner compiles the binary with the embedded CLI asset",
    build.exitCode === 0,
    build.exitCode === 0 ? `built ${binary}` : new TextDecoder().decode(build.stderr).slice(0, 300),
  );
  if (build.exitCode !== 0) process.exit(1);

  // --- 2. the control server ---
  await Bun.$`mkdir -p ${runnerHome} ${workspaceHost}`.quiet();
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
    // Two servers, two roles: createServer binds its own port and owns the
    // websocket endpoint the runner dials (READY); the harness Bun.serve below
    // carries only /state + /dispatch (HTTP_READY). The identity must name the
    // createServer port.
    const ready = await serverOut.until("READY ", 30_000);
    port = Number(ready.split("READY ")[1]!.split("\n")[0]!.trim());
    await serverOut.until("HTTP_READY", 30_000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver stderr: ${serverErr.text.slice(-2000)}`);
  }
  const control = (path: string) => `http://127.0.0.1:${CONTROL_PORT}${path}`;
  const wsPort = port;

  // --- 3. setup + connect the compiled binary ---
  const setup = Bun.spawnSync(
    [binary, "setup", "--server", `http://127.0.0.1:${wsPort}`, "--runner-id", "runner-a"],
    {
      env: { ...process.env, CC_WEB_RUNNER_HOME: runnerHome, CC_WEB_RUNNER_TOKEN: "cck_valid" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const identity = JSON.parse(await readFile(identityPath, "utf8")) as Record<string, string>;
  const mode = (await stat(identityPath)).mode & 0o777;
  check(
    "the binary's setup writes a 0600 identity for the live server",
    setup.exitCode === 0 &&
      identity["controlUrl"] === `ws://127.0.0.1:${port}/ws/runner` &&
      mode === 0o600,
    `exit=${setup.exitCode} mode=${mode.toString(8)}`,
  );

  runnerProc = Bun.spawn([binary, "connect"], {
    cwd: workspaceHost,
    env: {
      ...process.env,
      CC_WEB_RUNNER_HOME: runnerHome,
      CC_WEB_RUNNER_DEFAULT_WORKSPACE: workspaceHost,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const runnerOut = streamReader(runnerProc.stdout);
  const runnerErr = streamReader(runnerProc.stderr);

  const readyDeadline = Date.now() + 30_000;
  let state = "";
  while (state !== "ready" && Date.now() < readyDeadline) {
    try {
      state = ((await fetch(control("/state")).then((r) => r.json())) as { state: string }).state;
    } catch (error) {
      throw new Error(
        `state fetch failed: ${(error as Error).message}\nserver stderr: ${serverErr.text.slice(0, 2500)}`,
      );
    }
    if (state !== "ready") await Bun.sleep(50);
  }
  check(
    "the compiled binary's runner reaches ready",
    state === "ready",
    runnerOut.text.slice(-200) || runnerErr.text.slice(-200),
  );

  // --- 4. dispatch one real run ---
  const decision = (await fetch(control("/dispatch"), { method: "POST" }).then((r) =>
    r.json(),
  )) as { ok: boolean; commandId?: string; reason?: string };
  check(
    "the scheduler accepts the dispatch",
    decision.ok === true,
    decision.ok ? `commandId=${decision.commandId}` : `reason=${decision.reason}`,
  );

  // --- 5. wait for the terminal event in the runner's own outbox ---
  const terminalDeadline = Date.now() + 180_000;
  type EventRow = { type: string; payload: string };
  let events: EventRow[] = [];
  const readEvents = (): EventRow[] => {
    const db = new Database(runnerDbPath, { readonly: true });
    try {
      return db
        .query(
          "SELECT type, payload FROM event_outbox WHERE attempt_id = 'attempt-1' ORDER BY local_sequence",
        )
        .all() as EventRow[];
    } finally {
      db.close();
    }
  };
  while (Date.now() < terminalDeadline) {
    try {
      events = readEvents();
    } catch {
      // The runner may not have created its database yet.
    }
    if (events.some((e) => e.type === "run.finished" || e.type === "run.failed")) break;
    await Bun.sleep(250);
  }
  check(
    "the run reaches a terminal event",
    events.some((e) => e.type === "run.finished" || e.type === "run.failed"),
    `events: [${events.map((e) => e.type).join(", ")}]`,
  );

  const initArrived = events.some((e) => e.type === "session.updated");
  check(
    "the real CLI booted: the SDK's init frame arrived as session.updated",
    initArrived,
    initArrived ? "init present" : "no session.updated event",
  );

  const terminal = events.find((e) => e.type === "run.finished" || e.type === "run.failed");
  const terminalPayload = terminal ? (JSON.parse(terminal.payload) as { error?: string }) : {};
  const assetShaped = /Native CLI binary|Reinstall|pathToClaudeCodeExecutable/i.test(
    terminalPayload.error ?? "",
  );
  check(
    "the terminal outcome is never an asset-resolution failure",
    !assetShaped,
    terminal?.type === "run.failed"
      ? (terminalPayload.error ?? "").slice(0, 120)
      : (terminal?.type ?? "no terminal event"),
  );

  // --- live streaming (§12.3): a run that reached the model streams the
  // normalized frames — message.started plus at least one text fragment.
  // A credential-shaped failure never gets there, so the assertions gate on it.
  const finished = terminal?.type === "run.finished";
  const startedRows = events.filter((e) => e.type === "message.started");
  const deltaRows = events.filter((e) => e.type === "message.delta");
  const deltasWellFormed =
    deltaRows.length > 0 &&
    deltaRows.every((e) => {
      const payload = JSON.parse(e.payload) as { messageId?: unknown; text?: unknown };
      return (
        typeof payload.messageId === "string" &&
        payload.messageId !== "" &&
        typeof payload.text === "string"
      );
    });
  check(
    "a finished run streams message.started",
    !finished || startedRows.length > 0,
    `message.started rows: ${startedRows.length}`,
  );
  check(
    "a finished run streams well-formed message.delta fragments",
    !finished || deltasWellFormed,
    `message.delta rows: ${deltaRows.length}`,
  );

  // --- 5b. tool events: block starts announce the call, tool_result closes it ---
  const toolStartedRows = events.filter((e) => e.type === "tool.started");
  const toolCompletedRows = events.filter((e) => e.type === "tool.completed");
  const toolStartedIds = new Set(
    toolStartedRows
      .map((e) => (JSON.parse(e.payload) as { toolCallId?: unknown }).toolCallId)
      .filter((id): id is string => typeof id === "string" && id !== ""),
  );
  const toolStartedWellFormed = toolStartedRows.every((e) => {
    const payload = JSON.parse(e.payload) as { toolCallId?: unknown; toolName?: unknown };
    return (
      typeof payload.toolCallId === "string" &&
      payload.toolCallId !== "" &&
      typeof payload.toolName === "string" &&
      payload.toolName !== ""
    );
  });
  const toolCorrelated = toolCompletedRows.every((e) => {
    const payload = JSON.parse(e.payload) as { toolCallId?: unknown };
    return typeof payload.toolCallId === "string" && toolStartedIds.has(payload.toolCallId);
  });
  check(
    "a finished run announces tool calls with ids and names",
    !finished || (toolStartedRows.length > 0 && toolStartedWellFormed),
    `tool.started rows: ${toolStartedRows.length}`,
  );
  check(
    "every tool.completed correlates with an announced tool call",
    !finished || (toolCompletedRows.length > 0 && toolCorrelated),
    `tool.completed rows: ${toolCompletedRows.length}`,
  );

  // --- 6. the attempt settles and the workspace lock is released ---
  const lockDeadline = Date.now() + 10_000;
  let locked = 1;
  while (Date.now() < lockDeadline) {
    const db = new Database(runnerDbPath, { readonly: true });
    try {
      locked = (db.query("SELECT COUNT(*) AS n FROM workspace_locks").get() as { n: number }).n;
    } finally {
      db.close();
    }
    if (locked === 0) break;
    await Bun.sleep(100);
  }
  check("the workspace lock outlives nothing", locked === 0, `workspace_locks rows: ${locked}`);
} catch (error) {
  check(
    "probe completed without an unexpected error",
    false,
    String((error as Error)?.message ?? error).slice(0, 300),
  );
} finally {
  runnerProc?.kill("SIGKILL");
  await runnerProc?.exited.catch(() => {});
  serverProc?.kill("SIGKILL");
  await serverProc?.exited.catch(() => {});
  await rm(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
