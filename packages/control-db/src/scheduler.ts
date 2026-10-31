/**
 * Scheduling MVP (§11.3).
 *
 * The user picks a workspace already bound to a Runner; this decides whether
 * that Runner can take the run, and if so writes the command to the outbox.
 *
 * Deliberately small. §11.3 rules out smart placement and a worker pool, and
 * the interesting behaviour is all in the refusals:
 *
 *  - `connected` is not `ready`: a runner that has not reconciled may hold
 *    state the server does not know about (§6.2)
 *  - a runner at capacity is refused, not queued — the Runner has its own local
 *    queue, and a second one here would double-count
 *  - one active run per session (§2.3)
 *
 * Dispatch and enqueue happen together. A decision the outbox never hears about
 * is a run the operator believes was started.
 */

import type { Database } from "bun:sqlite";
import type { RunnerAttachmentItem, RunProfilePayload } from "@cc-web/protocol";
import { CommandOutbox } from "./command-outbox.ts";
import { ensureSessionPin } from "./sessions.ts";

export type RunnerState = "offline" | "connected" | "ready" | "draining" | "revoked";

export type RunnerCapacity = {
  runnerId: string;
  state: RunnerState;
  maxConcurrentRuns: number;
  activeRuns: number;
};

export type DispatchRequest = {
  sessionId: string;
  runId: string;
  attemptId: string;
  workspaceId: string;
  prompt: string;
  /**
   * The session's owner (§2.3). Recorded on the pin so the dispatch route can
   * answer another user's reuse of the session id with 404 — no existence
   * leak — instead of dispatching into someone else's session.
   */
  ownerId: string;
  /**
   * The SDK permission mode the operator picked (§13). Validated by the route;
   * absent means the runner's own default. It rides the run.start payload so
   * the runner's executor can pass it to the SDK stream.
   */
  permissionMode?: string;
  /**
   * The model the operator picked for this run (§5.2). Validated by the route;
   * absent means the SDK's own default — the option is omitted, never set to a
   * stand-in value.
   */
  model?: string;
  /**
   * The git branch the operator picked for this run (M4). Validated by the
   * route against the runner's declaration; absent means no checkout — the
   * workspace stays on whatever HEAD it is on. Rides the payload next to
   * `model`, never as an envelope field.
   */
  branch?: string;
  /**
   * The reasoning effort the operator picked (§5.2). Validated by the route;
   * absent leaves the SDK's own default. Rides the payload next to `model`.
   */
  effort?: string;
  /**
   * The standing ultracode mode (§5.2), off unless the operator turned it on.
   * Absent leaves the SDK's own default — the flag is never sent as `false`
   * for a run that did not ask for it.
   */
  ultracode?: boolean;
  /**
   * The canonical workspace path (§15.1). When present the runner uses it as a
   * fallback if its own `workspacePathFor` cannot resolve the workspace id.
   */
  workspacePath?: string;
  /**
   * The Claude session id to resume (§10.4). When present the runner's executor
   * passes it to the SDK stream as `resume` instead of the last-known session id.
   * Carries in the run.start payload, next to `prompt`.
   */
  resumeSessionId?: string;
  /**
   * File attachments bound to this dispatch (§4.4). The runner downloads each
   * from the runner attachment endpoint and makes it available to the SDK stream.
   * Absent means no attachments — the key is omitted, never sent as an empty list.
   */
  attachments?: RunnerAttachmentItem[];
  /**
   * The scheduled task this run fires (§11.5). Set by the scheduling tick only
   * — a user-started run never carries it. Rides the run.start payload so the
   * runner's `run.started` event can tag the turn the web renders as scheduled;
   * absent means an ordinary run and the key is omitted.
   */
  scheduleId?: string;
  /** The schedule's cron expression, for the chat label (§11.5). Rides the
   * payload next to `scheduleId`, same rule: omitted when absent. */
  scheduleCron?: string;
  /**
   * An upstream provider profile selected for this run (§17.1, §18.1). When
   * present, the run.start payload carries the resolved `RunProfilePayload`
   * with the cleartext `apiKey`. The on-disk outbox persists a redacted copy
   * (apiKey replaced with `[REDACTED]`) while the live WebSocket frame delivers
   * the key to the runner. Absent means no profile — the key is omitted,
   * never sent as `null`.
   */
  profile?: RunProfilePayload;
};

export type DispatchDecision =
  | { ok: true; runnerId: string; commandId: string }
  | {
      ok: false;
      reason:
        | "runner_offline"
        | "runner_not_ready"
        | "runner_at_capacity"
        | "session_busy"
        | "duplicate_run";
    };

type ActiveRow = {
  run_id: string;
  session_id: string;
  runner_id: string;
  attempt_id: string;
};

/** Told after a successful dispatch, so delivery happens as part of the call. */
export type DispatchListener = (runnerId: string, commandId: string) => void;

/**
 * Options for the `Scheduler` constructor.
 */
export type SchedulerOptions = {
  /** Called after a command is persisted to the outbox, so delivery is part of
   * the dispatch call (§14.3 step 4). Absent means no auto-drain. */
  onDispatched?: DispatchListener;
  /**
   * Seals a cleartext secure payload before it is persisted to
   * `command_outbox.payload_secure` (§18.1, P3-C Task 5b). When a profile is
   * present the cleartext `apiKey` lives in `payloadSecure`; without this seam
   * the object is stored as-is for backward compatibility.
   */
  sealSecurePayload?: (value: unknown) => unknown;
};

export class Scheduler {
  readonly #db: Database;
  readonly #outbox: CommandOutbox;
  readonly #onDispatched: DispatchListener | undefined;
  readonly #sealSecurePayload: ((value: unknown) => unknown) | undefined;

  constructor(db: Database, options: SchedulerOptions = {}) {
    this.#db = db;
    this.#outbox = new CommandOutbox(db);
    this.#onDispatched = options.onDispatched;
    this.#sealSecurePayload = options.sealSecurePayload;
  }

  async dispatch(request: DispatchRequest, capacity: RunnerCapacity): Promise<DispatchDecision> {
    if (capacity.state === "offline" || capacity.state === "revoked") {
      return { ok: false, reason: "runner_offline" };
    }
    if (capacity.state !== "ready") {
      return { ok: false, reason: "runner_not_ready" };
    }
    if (capacity.maxConcurrentRuns <= 0 || capacity.activeRuns >= capacity.maxConcurrentRuns) {
      return { ok: false, reason: "runner_at_capacity" };
    }

    const existingRun = this.#db
      .query("SELECT run_id FROM active_runs WHERE run_id = ?")
      .get(request.runId) as { run_id: string } | null;
    if (existingRun) {
      // A retry of the same dispatch. Creating a second command under the same
      // run id would deliver the work twice.
      return { ok: false, reason: "duplicate_run" };
    }

    if (this.activeRunFor(request.sessionId)) {
      return { ok: false, reason: "session_busy" };
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const issuedAt = new Date().toISOString();

    // Enqueue carries the envelope fields, not just the payload: the dispatcher
    // rebuilds the frame from the stored row alone, and a missing `sessionId`
    // would leave the runner unable to attribute the work.
    // §17.1, §18.1: when a profile is selected, the cleartext `apiKey` rides the
    // live WebSocket frame so the runner receives it, while the on-disk outbox
    // persists a redacted copy so `SELECT payload FROM command_outbox` never
    // holds the secret. The dispatcher's `toEnvelope` rebuilds the frame from
    // the stored row using `payloadSecure` when present, falling back to the
    // redacted `payload` after a restart (the runner rejects the missing key).
    const cleartextPayload = {
      sessionId: request.sessionId,
      runId: request.runId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      prompt: request.prompt,
      ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
      ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.ultracode === undefined ? {} : { ultracode: request.ultracode }),
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      ...(request.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: request.resumeSessionId }),
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      ...(request.scheduleId === undefined ? {} : { scheduleId: request.scheduleId }),
      ...(request.scheduleCron === undefined ? {} : { scheduleCron: request.scheduleCron }),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    };

    const hasProfile = request.profile !== undefined;
    const persistedPayload = hasProfile
      ? { ...cleartextPayload, profile: redactProfileSecrets(request.profile!) }
      : cleartextPayload;

    await this.#outbox.enqueue({
      commandId,
      runnerId: capacity.runnerId,
      kind: "run.start",
      issuedAt,
      sessionId: request.sessionId,
      runId: request.runId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      payload: persistedPayload,
      ...(hasProfile
        ? {
            payloadSecure: this.#sealSecurePayload
              ? this.#sealSecurePayload(cleartextPayload)
              : cleartextPayload,
          }
        : {}),
    });

    // The pin is written only for an accepted dispatch — a refusal must never
    // relocate a session — and here, after the awaited enqueue and in the same
    // synchronous continuation as the active_runs insert, on purpose: the
    // enqueue hashes asynchronously, so a pin written earlier could survive on
    // a concurrent dispatch that then lost the session-busy insert race. From
    // this point the pin writer and the insert winner are the same dispatch by
    // construction. A crash between pin and insert leaves a pinned session
    // with an enqueued command and no active row — a retry passes every gate
    // (duplicate_run reads active_runs) and lands in its own pin.
    ensureSessionPin(this.#db, {
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      runnerId: capacity.runnerId,
    });

    try {
      this.#db
        .query(
          `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(request.runId, request.sessionId, capacity.runnerId, request.attemptId, Date.now());
    } catch (error) {
      // The unique index caught a race between two dispatchers. Retire the
      // command we just wrote rather than leaving an orphan that would run.
      this.#outbox.markRejected(commandId, "session_busy");
      if (String(error).includes("UNIQUE")) {
        return { ok: false, reason: "session_busy" };
      }
      throw error;
    }

    // Delivery is part of dispatch. A caller that has to remember a second call
    // is a caller that will eventually forget it, and the run then sits in the
    // outbox until the runner happens to reconnect.
    this.#onDispatched?.(capacity.runnerId, commandId);

    return { ok: true, runnerId: capacity.runnerId, commandId };
  }

  /** Frees the session and the runner slot once a run reaches a terminal state. */
  release(runId: string): void {
    this.#db.query("DELETE FROM active_runs WHERE run_id = ?").run(runId);
  }

  /**
   * A durable cancel for an active run (§14.2).
   *
   * Enqueued like a start, so it inherits the same delivery guarantees: if the
   * runner is away, the cancel waits in the outbox and goes out on reconnect.
   * The active run is deliberately untouched — a cancel is a request, not an
   * outcome, and the slot frees only when the terminal event arrives. Releasing
   * here instead would let a lost cancel wedge a second run onto a workspace
   * the first run is still holding.
   */
  async cancel(
    runId: string,
  ): Promise<{ ok: true; commandId: string } | { ok: false; reason: "unknown_run" }> {
    const row = this.#db
      .query("SELECT session_id, runner_id, attempt_id FROM active_runs WHERE run_id = ?")
      .get(runId) as { session_id: string; runner_id: string; attempt_id: string } | null;
    if (row === null) return { ok: false, reason: "unknown_run" };

    const commandId = `cmd_${crypto.randomUUID()}`;
    await this.#outbox.enqueue({
      commandId,
      runnerId: row.runner_id,
      kind: "run.cancel",
      issuedAt: new Date().toISOString(),
      sessionId: row.session_id,
      runId,
      attemptId: row.attempt_id,
      payload: {},
    });

    this.#onDispatched?.(row.runner_id, commandId);
    return { ok: true, commandId };
  }

  activeRunFor(
    sessionId: string,
  ): { runId: string; runnerId: string; attemptId: string } | undefined {
    const row = this.#db
      .query("SELECT run_id, runner_id, attempt_id FROM active_runs WHERE session_id = ?")
      .get(sessionId) as ActiveRow | null;
    return row
      ? { runId: row.run_id, runnerId: row.runner_id, attemptId: row.attempt_id }
      : undefined;
  }

  capacityFor(runnerId: string, base: RunnerCapacity): RunnerCapacity {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM active_runs WHERE runner_id = ?")
      .get(runnerId) as { n: number };
    return { ...base, activeRuns: row.n };
  }
}

/**
 * Build a redacted copy of a profile payload for on-disk persistence: the
 * cleartext `apiKey` and every `settings.env` value become `[REDACTED]`, so
 * `command_outbox.payload` never holds a credential — including one a user put
 * in the settings JSON instead of the apiKey field. The live WebSocket frame
 * carries the original via `payload_secure` (§18.1).
 */
function redactProfileSecrets(profile: RunProfilePayload): RunProfilePayload {
  const redacted: RunProfilePayload = {
    ...profile,
    ...(profile.apiKey === undefined ? {} : { apiKey: "[REDACTED]" }),
    ...(typeof profile.settings === "object" && profile.settings !== null
      ? { settings: redactSettingsEnv(profile.settings) }
      : {}),
  };
  return redacted;
}

/** Replace every string value in `settings.env`; other settings stay readable. */
function redactSettingsEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings["env"];
  if (typeof env !== "object" || env === null || Array.isArray(env)) return settings;
  const redactedEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    redactedEnv[key] = typeof value === "string" ? "[REDACTED]" : value;
  }
  return { ...settings, env: redactedEnv };
}
