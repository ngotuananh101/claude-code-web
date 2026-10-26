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
import { createSdkStream } from "@cc-web/agent-adapter";
import { type DeclaredWorkspace, PROTOCOL_VERSION } from "@cc-web/protocol";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { EventPump } from "./connection/event-pump.ts";
import { ReconnectLoop, type RunnerInventoryItem } from "./connection/reconnect-loop.ts";
import { dialWebSocket } from "./connection/websocket-link.ts";
import type { ExecuteOptions, SdkStream } from "./execution/executor.ts";
import { RunController } from "./execution/run-controller.ts";
import { prepareBranch } from "./git/checkout.ts";
import { gitSpawn } from "./git/spawn.ts";
import { loadIdentity, type RunnerIdentity } from "./identity/identity-store.ts";

/**
 * A declaration is an array, or a thunk producing one. The thunk is how M4
 * keeps branches fresh: it is re-evaluated every time a hello or reconcile
 * frame is built, so a reconnect re-lists the workspace's heads instead of
 * replaying whatever the boot happened to see.
 */
export type DeclaredWorkspacesOption = DeclaredWorkspace[] | (() => DeclaredWorkspace[]);

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
   * How long `stop()` waits for in-flight runs, first to finish on their own
   * and then to observe the deliberate cancel, before abandoning them as
   * interrupted (§20.4). Default 5000ms each.
   */
  shutdownGraceMs?: number;
  onEvent?: (event: unknown) => void;
};

export type Daemon = {
  loop: ReconnectLoop;
  identity: RunnerIdentity;
  /** The local database, exposed so callers can inspect stored receipts. */
  db: Database;
  /** In-flight runs; `stop()` waits for these. */
  runs: RunController;
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
    onSettled: () => pump.flush(),
    // §13: a suspended run never settles, so the gate triggers the flush
    // itself — the approval request must ship the moment it is appended.
    onApprovalEvent: () => pump.flush(),
  });

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
    // The controller persists the command, decides whether this is a first
    // delivery, and starts the run. The receipt is returned before the run is
    // awaited, so `accepted` keeps meaning "durable", not "finished" (§9.4).
    onCommand: (command) => runs.handle(command),
  });

  await loop.start();

  return {
    loop,
    identity,
    db,
    runs,
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
