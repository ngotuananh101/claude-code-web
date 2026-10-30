/**
 * Runner daemon composition (§3.3, §6.2, §11.1).
 *
 * Reads the persisted identity, opens the local database, dials the control
 * server, and runs the reconnect loop until stopped. The credential never leaves
 * this process except as the `Authorization` header on the upgrade (§6.2).
 *
 * The command path is deliberately thin: `onCommand` hands the frame to
 * `RunController`, which persists it to the inbox, answers the receipt, and
 * starts the run. That order — persist, then answer, then execute — is what
 * makes the server's at-least-once delivery safe, so it lives in a tested
 * module rather than being open-coded here.
 *
 * Deliberately no retry logic here: that lives in `ReconnectLoop`, which is
 * tested. This file is the part that cannot be tested without a real machine —
 * reading files and wiring objects together.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { createSdkStream } from "@cc-web/agent-adapter";
import {
  type DeclaredWorkspace,
  PROTOCOL_VERSION,
  type RpcResultFrame,
  type RunnerModel,
} from "@cc-web/protocol";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { BROWSE_CAPABILITIES, createBrowseHandler } from "./browse/handler.ts";
import {
  CLEANUP_CAPABILITIES,
  cleanOrphanedTemp,
  createCleanupHandler,
} from "./cleanup/handler.ts";
import { EventPump } from "./connection/event-pump.ts";
import {
  type CommandOutcome,
  ReconnectLoop,
  type RunnerInventoryItem,
} from "./connection/reconnect-loop.ts";
import { dialWebSocket } from "./connection/websocket-link.ts";
import type { ExecuteOptions, SdkStream } from "./execution/executor.ts";
import { RunController } from "./execution/run-controller.ts";
import { prepareBranch } from "./git/checkout.ts";
import { gitSpawn } from "./git/spawn.ts";
import { loadIdentity, type RunnerIdentity } from "./identity/identity-store.ts";
import { createInspectHandler, INSPECT_CAPABILITIES } from "./inspection/handler.ts";
import { createMutationHandler, MUTATION_CAPABILITIES } from "./mutation/handler.ts";
import { createSessionsHandler, SESSIONS_CAPABILITIES } from "./sessions/handler.ts";
import { createBaselineCapture } from "./workspace/snapshot.ts";
import { createSnapshotStatus } from "./workspace/status.ts";

/**
 * A declaration is an array, or a thunk producing one. The thunk is how M4
 * keeps branches fresh: it is re-evaluated every time a hello or reconcile
 * frame is built, so a reconnect re-lists the workspace's heads instead of
 * replaying whatever the boot happened to see.
 */
export type DeclaredWorkspacesOption = DeclaredWorkspace[] | (() => DeclaredWorkspace[]);

/** The full set of command kinds this runner implements, unioned per lane. */
const RUNNER_CAPABILITIES: string[] = [
  ...INSPECT_CAPABILITIES,
  ...MUTATION_CAPABILITIES,
  ...BROWSE_CAPABILITIES,
  ...SESSIONS_CAPABILITIES,
  ...CLEANUP_CAPABILITIES,
];

/** The read-only command kinds the daemon routes to the inspection handler. */
const INSPECT_KINDS = new Set(["workspace.inspect", "config.inspect"]);

/** The read-only directory-browse command kinds the daemon routes to the browse handler. */
const BROWSE_KINDS = new Set(["workspace.fs.browse"]);

/** The read-only session-inspection command kinds routed to the sessions handler. */
const SESSIONS_KINDS = new Set(["workspace.sessions.list", "workspace.sessions.messages"]);

/** The write/revert command kinds the daemon routes to the mutation handler. */
const MUTATION_KINDS = new Set([
  "workspace.file.write",
  "workspace.file.revert",
  "workspace.revert",
]);

/**
 * Whether a raw command frame is an inspection. Reads `kind` defensively: a
 * non-object frame is not an inspection, and falls through to the controller,
 * which already refuses malformed commands with a receipt.
 */
function isInspectKind(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const kind = (command as Record<string, unknown>)["kind"];
  return typeof kind === "string" && INSPECT_KINDS.has(kind);
}

/** Same seam as `isInspectKind`, but for the write/revert lane. */
function isMutationKind(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const kind = (command as Record<string, unknown>)["kind"];
  return typeof kind === "string" && MUTATION_KINDS.has(kind);
}

/** Recognizes the read-only directory-browse lane. */
function isBrowseKind(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const kind = (command as Record<string, unknown>)["kind"];
  return typeof kind === "string" && BROWSE_KINDS.has(kind);
}

/** Recognizes the read-only session-inspection lane. */
function isSessionsKind(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const kind = (command as Record<string, unknown>)["kind"];
  return typeof kind === "string" && SESSIONS_KINDS.has(kind);
}

/** The session temp-directory cleanup command kind the daemon routes to the cleanup handler. */
const CLEANUP_KINDS = new Set(["session.cleanup"]);

/** Recognizes the session-cleanup lane. */
function isSessionCleanupKind(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const kind = (command as Record<string, unknown>)["kind"];
  return typeof kind === "string" && CLEANUP_KINDS.has(kind);
}

export function resolveDeclaredWorkspaces(
  option: DeclaredWorkspacesOption | undefined,
): DeclaredWorkspace[] | undefined {
  return option === undefined ? undefined : typeof option === "function" ? option() : option;
}

/**
 * The hello a runner sends after authentication (§6.2), built here so the
 * composition and its shape are testable without a socket.
 */
export function helloFrame(input: {
  runnerId: string;
  runnerVersion: string;
  sdkVersion: string;
  bootId: string;
  declaredWorkspaces?: DeclaredWorkspace[];
  /** What this boot's Claude Code offers (§5.2); absent means pre-discovery. */
  models?: RunnerModel[];
}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerId: input.runnerId,
    // Stable for the process lifetime: a reconnect from the same process is
    // the same boot, and the server uses the generation, not this, to fence.
    bootId: input.bootId,
    runnerVersion: input.runnerVersion,
    sdkVersion: input.sdkVersion,
    platform: `${process.platform}/${process.arch}`,
    maxConcurrentRuns: 1,
    activeRuns: [],
    eventOffsets: [],
    workspaces: input.declaredWorkspaces ?? [],
    // Ruling 13: the server gates an inspection on this, so a new server never
    // dispatches one to a runner that would misread the kind as a run start.
    capabilities: RUNNER_CAPABILITIES,
    // §5.2: the host's own model lineup, discovered at boot. Omitted rather
    // than empty when discovery never ran, so the server can tell "old runner"
    // from "asked and found none" the same way it does for workspaces.
    ...(input.models === undefined ? {} : { models: input.models }),
  };
}

export type DaemonOptions = {
  identityDir: string;
  runnerVersion: string;
  sdkVersion: string;
  /** Override for tests; defaults to `<identityDir>/runner.db`. */
  databasePath?: string;
  /** Runs this runner currently believes are in flight (§14.3). */
  inventory?: () => RunnerInventoryItem[];
  /**
   * The models this boot's Claude Code offers (§5.2). Discovered once at boot
   * — a config change needs a restart, exactly like the deployed binary.
   */
  models?: RunnerModel[];
  /**
   * Resolves a workspace id to its canonical path. A command naming a workspace
   * this runner does not know is refused rather than run in an arbitrary
   * directory.
   */
  workspacePathFor?: (workspaceId: string) => string | undefined;
  /**
   * The workspaces this boot serves (§15.1), advertised in the hello and every
   * reconcile. A thunk is re-evaluated per frame (M4 branch freshness).
   */
  declaredWorkspaces?: DeclaredWorkspacesOption;
  /**
   * The workspace-preparation gate (M4). Defaults to the real branch checkout
   * gate so no composition can forget it; tests override with fakes. A
   * dispatch without a branch never triggers a spawn, so default-wiring is
   * inert for every existing test.
   */
  prepareWorkspace?: ExecuteOptions["prepareWorkspace"];
  /**
   * The SDK seam. Defaults to the real adapter; tests inject a fake so the whole
   * daemon runs without a model call.
   */
  sdk?: SdkStream;
  /**
   * The pump's retry-timer seams, passed straight through. They exist so a test
   * can observe that `stop()` reaches `pump.stop()` and cancels an armed retry,
   * rather than only trusting that it does.
   */
  pumpSchedule?: (fn: () => void, ms: number) => unknown;
  pumpUnschedule?: (handle: unknown) => void;
  /**
   * How long `stop()` waits for in-flight runs, first to finish on their own
   * and then to observe the deliberate cancel, before abandoning them as
   * interrupted (§20.4). Default 5000ms each.
   */
  shutdownGraceMs?: number;
  /**
   * Answers a read-only inspection (§23). Defaults to the real handler built
   * from `workspacePathFor` and `createSnapshotStatus`, so the composition and
   * its tests use the same wiring; tests inject a fake to observe routing
   * without a filesystem.
   */
  inspect?: (command: unknown) => Promise<RpcResultFrame>;
  /**
   * Answers a write/revert command (§7.1). Defaults to the real handler built
   * from `workspacePathFor` and a snapshot status composed inside the inspect
   * handler; tests inject a fake to observe routing without a filesystem.
   */
  mutation?: (command: unknown) => Promise<RpcResultFrame>;
  /**
   * Answers a directory-browse command (§18.2). Defaults to the real
   * `createBrowseHandler`; tests inject a fake to observe routing without a
   * filesystem.
   */
  browse?: (command: unknown) => Promise<RpcResultFrame>;
  /**
   * Answers a session-inspection command (§18.2). Defaults to the real
   * `createSessionsHandler` built from `workspacePathFor`; tests inject a fake
   * to observe routing without an SDK or filesystem.
   */
  sessions?: (command: unknown) => Promise<RpcResultFrame>;
  /**
   * Answers a session-cleanup command (§attachments). Defaults to the real
   * `createCleanupHandler` built from the runner's identity directory; tests
   * inject a fake to observe routing without a filesystem.
   */
  cleanup?: (command: unknown) => Promise<RpcResultFrame>;
  /** The run-start baseline capture (P3-B). See `RunController` wiring. */
  captureBaseline?: ExecuteOptions["captureBaseline"];
  onEvent?: (event: unknown) => void;
};

export type Daemon = {
  loop: ReconnectLoop;
  identity: RunnerIdentity;
  /** The local database, exposed so callers can inspect stored receipts. */
  db: Database;
  /** In-flight runs; `stop()` waits for these. */
  runs: RunController;
  /**
   * The command pre-switch the loop calls, exposed so the routing itself is
   * testable without a reachable server: an inspect must reach `inspect` and
   * never `runs`, which is the structural half of Ruling 15.
   */
  dispatch(command: unknown): Promise<CommandOutcome>;
  stop(): Promise<void>;
};

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const loaded = await loadIdentity(options.identityDir);
  if (!loaded.ok) {
    // A missing or partial identity is an operator problem; retrying would only
    // obscure it.
    throw new Error(`cannot start runner: identity ${loaded.reason} in ${options.identityDir}`);
  }

  const identity = loaded.identity;

  const db = new Database(options.databasePath ?? `${options.identityDir}/runner.db`);
  // Idempotent, so a crash during an earlier migration is not a boot loop.
  migrateRunnerDb(db);

  // §12.2: the outbox pump. It is declared before the loop and the controller
  // because both trigger it — the loop on `ready` (a reconnect is the earliest
  // moment backlog rows can move) and on every ACK, the controller when a run
  // settles and its rows are complete. Its `send` closes over the loop binding
  // and only runs from those triggers, all of which fire after the loop exists.
  //
  // The spool callbacks close over `runs` for the same reason: the pump only
  // reads depth from a flush, and no flush happens before both are constructed.
  const pump = new EventPump({
    db,
    runnerId: identity.runnerId,
    bootId: bootId(),
    send: (frame) => loop.sendFrame(frame),
    ...(options.pumpSchedule === undefined ? {} : { schedule: options.pumpSchedule }),
    ...(options.pumpUnschedule === undefined ? {} : { unschedule: options.pumpUnschedule }),
    // §12.6 clause 5: the warning is journaled, not just logged, so the
    // operator's transcript says the spool was deep rather than only the
    // runner's stderr. It goes through the attempt's own append — the pump has
    // none (§12.2) — so an attempt with no live run here cannot be journaled;
    // that report is logged by counts alone, and deliberately without the
    // attempt's payload, which is never logged (§19.4).
    onSpoolWarning: (report) => {
      if (runs.warnSpool(report.attemptId, report)) return;
      console.warn(
        `spool warning with no live run: ${report.events} event(s), ${report.bytes} byte(s)`,
      );
    },
    // §12.6 clause 6: the critical threshold stops the run and records a
    // minimal failure record. The executor writes that record from its own
    // append when it sees the reason, so the stop is a cancel with a reason.
    onSpoolCritical: (report) => {
      const stopped = runs.cancel(report.attemptId, "spool_critical");
      if (!stopped) {
        console.warn(
          `spool critical with no live run: ${report.events} event(s), ${report.bytes} byte(s)`,
        );
      }
    },
  });

  // §10: accepted commands become runs here. The controller owns the inbox →
  // attempt → SDK sequence, including the crash recovery that has to happen
  // before the first command is accepted. The preparation gate (M4) runs the
  // branch checkout under the workspace lock each attempt already holds.
  const runs = new RunController({
    db,
    localRunnerId: identity.runnerId,
    workspacePathFor: options.workspacePathFor ?? (() => undefined),
    sdk: options.sdk ?? ((input) => createSdkStream(input)),
    prepareWorkspace:
      options.prepareWorkspace ?? ((path, branch) => prepareBranch(path, branch, gitSpawn)),
    captureBaseline:
      options.captureBaseline ??
      createBaselineCapture({ db, homeDir: options.identityDir, spawn: gitSpawn }),
    onSettled: () => pump.flush(),
    // §13: a suspended run never settles, so the gate triggers the flush
    // itself — the approval request must ship the moment it is appended.
    onApprovalEvent: () => pump.flush(),
    onEvent: () => pump.flush(),
  });

  // Ruling 11: the handler resolves the workspace path from the runner's own
  // registration — the same seam `run.start` uses — so the server's `path` is
  // display metadata and never authoritative. Defaulting from the daemon's
  // already-resolved `workspacePathFor` keeps the env→path wiring in `main.ts`
  // as its single source of truth. The inspect handler owns the readonly
  // snapshot.status seam, so it is composed here too.
  const inspect =
    options.inspect ??
    createInspectHandler({
      workspacePathFor: options.workspacePathFor ?? (() => undefined),
      snapshotStatus: createSnapshotStatus({ db, spawn: gitSpawn }),
    });

  const mutate =
    options.mutation ??
    createMutationHandler({
      db,
      homeDir: options.identityDir,
      spawn: gitSpawn,
      workspacePathFor: options.workspacePathFor ?? (() => undefined),
    });

  const browse =
    options.browse ??
    createBrowseHandler({
      homeDir: process.env["HOME"] ?? homedir(),
    });

  const sessions =
    options.sessions ??
    createSessionsHandler({
      workspacePathFor: options.workspacePathFor ?? (() => undefined),
    });

  const cleanup =
    options.cleanup ??
    createCleanupHandler({
      runnerHome: options.identityDir,
    });

  // Fire-and-forget: sweep and remove orphaned session temp directories at boot
  // so a crashed process can't fill the disk across restarts. Errors are logged
  // but never block boot — a failed sweep is a degraded boot, not a fatal one.
  cleanOrphanedTemp(options.identityDir).catch((err) => {
    console.warn(`boot cleanup sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Ruling 15's pre-switch. `runs.handle` persists the command before answering
  // and starts the run after, so the receipt keeps meaning "durable", not
  // "finished" (§9.4). Inspects, mutations, browses and sessions never reach it.
  const dispatch = (command: unknown): Promise<CommandOutcome> =>
    isInspectKind(command)
      ? inspect(command).then((frame) => ({ receipt: null, results: [frame] }))
      : isBrowseKind(command)
        ? browse(command).then((frame) => ({ receipt: null, results: [frame] }))
        : isSessionsKind(command)
          ? sessions(command).then((frame) => ({ receipt: null, results: [frame] }))
          : isSessionCleanupKind(command)
            ? cleanup(command).then((frame) => ({ receipt: null, results: [frame] }))
            : isMutationKind(command)
              ? mutate(command).then((frame) => ({ receipt: null, results: [frame] }))
              : runs.handle(command).then((receipt) => ({ receipt }));

  const loop = new ReconnectLoop({
    runnerId: identity.runnerId,
    dial: () =>
      dialWebSocket({
        url: identity.controlUrl,
        credential: identity.credential,
      }),
    hello: () => {
      // Resolved inside the thunk: a declaredWorkspaces function must
      // re-evaluate on every dial, or a branch list would freeze at boot.
      const declared = resolveDeclaredWorkspaces(options.declaredWorkspaces);
      return helloFrame({
        runnerId: identity.runnerId,
        runnerVersion: options.runnerVersion,
        sdkVersion: options.sdkVersion,
        bootId: bootId(),
        ...(declared === undefined ? {} : { declaredWorkspaces: declared }),
        ...(options.models === undefined ? {} : { models: options.models }),
      });
    },
    inventory: options.inventory ?? (() => runs.inventory()),
    ...(options.declaredWorkspaces === undefined ? {} : { workspaces: options.declaredWorkspaces }),
    sleep: (ms) => Bun.sleep(ms),
    onEvent: (event) => {
      // §12.2: on `ready` the backlog moves. Rows pending from before the
      // reconnect (or from a process that died mid-run) are exactly what the
      // resend exists for, and this is the first moment the link can carry them.
      if (event.type === "ready") pump.flush();
      options.onEvent?.(event);
    },
    // An ACK retires rows and self-drives the next bounded batch of its attempt.
    onEventsAcked: (ack) => pump.handleAck(ack),
    // Ruling 15: an inspection is dispatched outside the run/attempt machinery.
    // The pre-switch recognizes exactly the two inspect kinds; everything else
    // goes to the controller unchanged, including a malformed frame, which the
    // controller already refuses. Routing an inspect here rather than through
    // the controller is what makes "no lock, no attempt" structural.
    onCommand: (command) => dispatch(command),
  });

  await loop.start();

  return {
    loop,
    identity,
    db,
    runs,
    dispatch,
    stop: async () => {
      loop.stop();
      // §20.4: bounded draining. A grace period for runs to finish on their
      // own, then a deliberate cancel, then the interrupted verdict for
      // whatever ignores both — never an unbounded wait that hands shutdown's
      // fate to a wedged subprocess.
      const { abandoned } = await runs.drain({ graceMs: options.shutdownGraceMs ?? 5000 });
      if (abandoned.length > 0) {
        // Attempt ids are structural, safe to log (§19.4 bans credential and
        // payload logging, not ids — §20.6 asks for exactly these).
        console.warn(`shutdown abandoned ${abandoned.length} attempt(s): ${abandoned.join(", ")}`);
      }
      // After the drain, so the final rows still get their flush; before the
      // close, so no retry timer outlives the process it belongs to. Rows left
      // pending are durable and the next boot resends them.
      pump.stop();
      db.close();
    },
  };
}

/** One id per process start; a restart is a new boot. */
const BOOT_ID = crypto.randomUUID();
function bootId(): string {
  return BOOT_ID;
}
