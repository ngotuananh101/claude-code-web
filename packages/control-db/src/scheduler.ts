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
import { CommandOutbox, fingerprintOf } from "./command-outbox.ts";
import { ensureSessionPin, sessionPin } from "./sessions.ts";

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
   * (apiKey and settings env values replaced with `[REDACTED]`) while the
   * cleartext object is sealed into `payload_secure` and opened by the
   * dispatcher on each drain. A dispatch with a profile but no sealer is
   * refused (`profile_secrets_unavailable`). Absent means no profile — the key
   * is omitted, never sent as `null`.
   */
  profile?: RunProfilePayload;
};

export type DispatchOptions = { queue?: boolean };

export type DispatchDecision =
  | { ok: true; runnerId: string; commandId: string; queued: boolean }
  | {
      ok: false;
      reason:
        | "runner_offline"
        | "runner_not_ready"
        | "runner_at_capacity"
        | "session_busy"
        | "duplicate_run"
        | "profile_secrets_unavailable"
        | "workspace_busy"
        | "session_pinned";
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
   * present the cleartext `apiKey` lives in `payloadSecure`. A profile dispatch
   * without this seam is refused (`profile_secrets_unavailable`) — storing the
   * cleartext object as a fallback would put the credential on disk in plain
   * sight. Production wires the server's SecretBox here.
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

  async dispatch(
    request: DispatchRequest,
    capacity: RunnerCapacity,
    options: DispatchOptions = {},
  ): Promise<DispatchDecision> {
    const queue = options.queue !== false;
    const sealer = this.#sealSecurePayload;
    // §18.1: a profile carries a cleartext credential, and the only durable copy
    // this scheduler may write is the sealed one. Without a sealer there is no
    // safe place for the key — persisting it cleartext would defeat the whole
    // point — so refuse before anything is written. Production always wires the
    // server's SecretBox; this guards other embedders and tests.
    if (request.profile !== undefined && sealer === undefined) {
      return { ok: false, reason: "profile_secrets_unavailable" };
    }

    // Absence is not contention: a runner that cannot take work now is a refusal,
    // never a queued run waiting for something that may never come back.
    if (capacity.state === "offline" || capacity.state === "revoked") {
      return { ok: false, reason: "runner_offline" };
    }
    if (capacity.state !== "ready") {
      return { ok: false, reason: "runner_not_ready" };
    }

    // A retry of the same dispatch. Creating a second command under the same run
    // id would deliver the work twice, so a queued (not-yet-admitted) row counts
    // the same as an active one.
    if (this.#isDuplicateRun(request.runId)) {
      return { ok: false, reason: "duplicate_run" };
    }

    // Resolve the pin before the awaited enqueue: a dispatch that contradicts the
    // session's placement is refused and writes nothing. Queueing never relocates
    // a session (invariant 11 / ADR-006).
    const existingPin = sessionPin(this.#db, request.sessionId);
    if (
      existingPin !== undefined &&
      (existingPin.runnerId !== capacity.runnerId ||
        existingPin.workspaceId !== request.workspaceId)
    ) {
      return { ok: false, reason: "session_pinned" };
    }

    // Contention is queueable: session_busy, workspace_busy, runner_at_capacity.
    // Computed synchronously before enqueueing so the status is known when the
    // payload is built (a queued run must not carry a frozen resumeSessionId).
    const blocker = this.#blocker(request, capacity);
    if (blocker !== undefined && !queue) {
      return { ok: false, reason: blocker };
    }
    const queued = blocker !== undefined;

    const commandId = `cmd_${crypto.randomUUID()}`;
    const issuedAt = new Date().toISOString();
    const queueSnapshot = { runnerId: capacity.runnerId, workspaceId: request.workspaceId };

    // Enqueue carries the envelope fields, not just the payload: the dispatcher
    // rebuilds the frame from the stored row alone, and a missing `sessionId`
    // would leave the runner unable to attribute the work.
    // §17.1, §18.1: when a profile is selected, the redacted copy is all that
    // `SELECT payload` may hold, while the cleartext object rides
    // `payload_secure` sealed by the server's SecretBox. The dispatcher opens
    // the seal on every drain; only a legacy row without a secure payload falls
    // back to the redacted copy, and that fails authentication rather than
    // substituting a key.
    const cleartextPayload = this.#buildPayload(request, queued);
    const hasProfile = request.profile !== undefined;
    const persistedPayload = hasProfile
      ? { ...cleartextPayload, profile: redactProfileSecrets(request.profile!) }
      : cleartextPayload;

    // An admitted dispatch can lose the active_runs race and be queued instead.
    // If it carried a resumeSessionId, the queued row must not keep that frozen
    // id, so precompute the queued (no-resume) payload and its fingerprint before
    // the enqueue await. The race-loss rewrite then stays synchronous — no yield
    // that could let a concurrent promote admit the run while it still names the
    // stale resume session.
    let raceRequeueRewrite:
      | { payload: unknown; payloadSecure: unknown; fingerprint: string }
      | undefined;
    if (!queued && request.resumeSessionId !== undefined) {
      const queuedClear = this.#buildPayload(request, true);
      const queuedPersisted = hasProfile
        ? { ...queuedClear, profile: redactProfileSecrets(request.profile!) }
        : queuedClear;
      raceRequeueRewrite = {
        payload: queuedPersisted,
        payloadSecure: hasProfile && sealer !== undefined ? sealer(queuedClear) : undefined,
        fingerprint: await fingerprintOf({
          commandId,
          runnerId: capacity.runnerId,
          kind: "run.start",
          payload: queuedPersisted,
          issuedAt,
        }),
      };
    }

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
      ...(hasProfile && sealer !== undefined ? { payloadSecure: sealer(cleartextPayload) } : {}),
      deliveryState: queued ? "queued" : "pending",
      queueSnapshot,
    });

    // The pin is resolved before the await and written here, in the same
    // synchronous continuation as the active_runs insert. Writing it as
    // INSERT OR IGNORE means two racing dispatches for the same session converge
    // on the first pin, so it is re-read below and a contradiction rejects the
    // command rather than relocating the session. A queued first run still pins
    // the session (invariant 11) but never claims an active_runs slot and is
    // never delivered.
    ensureSessionPin(this.#db, {
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      runnerId: capacity.runnerId,
    });
    // Enqueue-then-reject tradeoff: the row was already written, so a pin
    // contradiction (another dispatch won the INSERT OR IGNORE race with a
    // different placement) retires it as rejected rather than deleting it. The
    // refusal writes nothing durable about placement, only a rejected command.
    const pinned = sessionPin(this.#db, request.sessionId);
    if (
      pinned === undefined ||
      pinned.runnerId !== capacity.runnerId ||
      pinned.workspaceId !== request.workspaceId
    ) {
      this.#outbox.markRejected(commandId, "session_pinned");
      return { ok: false, reason: "session_pinned" };
    }

    if (!queued) {
      try {
        this.#db
          .query(
            `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(request.runId, request.sessionId, capacity.runnerId, request.attemptId, Date.now());
      } catch (error) {
        // The unique index caught a race between two dispatchers. Session busy
        // is contention, so queue the command instead of rejecting it — the run
        // keeps its place and will be promoted when the slot frees. The rewrite
        // stays synchronous (no await) so a concurrent promote cannot admit the
        // run while it still carries a stale resumeSessionId.
        if (String(error).includes("UNIQUE")) {
          if (raceRequeueRewrite === undefined) {
            this.#outbox.markQueued(commandId);
          } else {
            this.#outbox.replaceQueuedPayload(commandId, raceRequeueRewrite);
          }
          return { ok: true, runnerId: capacity.runnerId, commandId, queued: true };
        }
        throw error;
      }

      // Delivery is part of dispatch. A caller that has to remember a second
      // call is a caller that will eventually forget it, and the run then sits
      // in the outbox until the runner happens to reconnect. A queued row has
      // nothing to deliver until it is promoted.
      this.#onDispatched?.(capacity.runnerId, commandId);
      return { ok: true, runnerId: capacity.runnerId, commandId, queued: false };
    }

    return { ok: true, runnerId: capacity.runnerId, commandId, queued: true };
  }

  #isDuplicateRun(runId: string): boolean {
    const active = this.#db
      .query("SELECT 1 AS one FROM active_runs WHERE run_id = ?")
      .get(runId) as { one: number } | null;
    if (active !== null) return true;
    const pending = this.#db
      .query(
        "SELECT 1 AS one FROM command_outbox WHERE run_id = ? AND delivery_state NOT IN ('accepted','rejected')",
      )
      .get(runId) as { one: number } | null;
    return pending !== null;
  }

  #blocker(
    request: DispatchRequest,
    capacity: RunnerCapacity,
  ): "session_busy" | "workspace_busy" | "runner_at_capacity" | undefined {
    if (this.activeRunFor(request.sessionId)) return "session_busy";
    if (this.#workspaceBusy(capacity.runnerId, request.workspaceId)) return "workspace_busy";
    if (capacity.maxConcurrentRuns <= 0 || capacity.activeRuns >= capacity.maxConcurrentRuns) {
      return "runner_at_capacity";
    }
    return undefined;
  }

  #workspaceBusy(runnerId: string, workspaceId: string): boolean {
    const row = this.#db
      .query(
        `SELECT 1 AS one FROM active_runs a JOIN sessions s ON s.id = a.session_id
         WHERE a.runner_id = ? AND s.workspace_id = ?`,
      )
      .get(runnerId, workspaceId) as { one: number } | null;
    return row !== null;
  }

  #buildPayload(request: DispatchRequest, queued: boolean): Record<string, unknown> {
    return {
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
      ...(queued || request.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: request.resumeSessionId }),
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      ...(request.scheduleId === undefined ? {} : { scheduleId: request.scheduleId }),
      ...(request.scheduleCron === undefined ? {} : { scheduleCron: request.scheduleCron }),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    };
  }

  /** Frees the session and the runner slot once a run reaches a terminal state. */
  release(runId: string): string | undefined {
    const row = this.#db.query("SELECT runner_id FROM active_runs WHERE run_id = ?").get(runId) as {
      runner_id: string;
    } | null;
    if (row === null) return undefined;
    this.#db.query("DELETE FROM active_runs WHERE run_id = ?").run(runId);
    return row.runner_id;
  }

  /**
   * A durable cancel for an active run (§14.2), and a direct retirement for a
   * queued run.
   *
   * An active run is cancelled by enqueuing `run.cancel` like a start, so it
   * inherits the same delivery guarantees: if the runner is away, the cancel
   * waits in the outbox and goes out on reconnect. The active run is
   * deliberately untouched — a cancel is a request, not an outcome, and the
   * slot frees only when the terminal event arrives.
   *
   * A queued run never entered the journal and never reached a runner, so
   * cancelling it retires the outbox row only: `markRejected(commandId,
   * "cancelled")`, no `run.cancel` command, no `onDispatched`, and nothing is
   * journaled.
   */
  async cancel(
    runId: string,
    options?: { ownerId?: string },
  ): Promise<
    | { ok: true; queued: false; commandId: string }
    | { ok: true; queued: true }
    | { ok: false; reason: "unknown_run" }
  > {
    const active = this.#db
      .query("SELECT session_id, runner_id, attempt_id FROM active_runs WHERE run_id = ?")
      .get(runId) as { session_id: string; runner_id: string; attempt_id: string } | null;
    if (active !== null) {
      if (options?.ownerId !== undefined) {
        const pin = sessionPin(this.#db, active.session_id);
        if (pin === undefined || pin.ownerId !== options.ownerId) {
          return { ok: false, reason: "unknown_run" };
        }
      }

      const commandId = `cmd_${crypto.randomUUID()}`;
      await this.#outbox.enqueue({
        commandId,
        runnerId: active.runner_id,
        kind: "run.cancel",
        issuedAt: new Date().toISOString(),
        sessionId: active.session_id,
        runId,
        attemptId: active.attempt_id,
        payload: {},
      });

      this.#onDispatched?.(active.runner_id, commandId);
      return { ok: true, queued: false, commandId };
    }

    const queued = this.#db
      .query(
        "SELECT command_id, session_id FROM command_outbox WHERE run_id = ? AND delivery_state = 'queued' AND kind = 'run.start'",
      )
      .get(runId) as { command_id: string; session_id: string | null } | null;
    if (queued === null) return { ok: false, reason: "unknown_run" };

    if (options?.ownerId !== undefined) {
      const sessionId = queued.session_id;
      const pin = sessionId === null ? undefined : sessionPin(this.#db, sessionId);
      if (pin === undefined || pin.ownerId !== options.ownerId) {
        return { ok: false, reason: "unknown_run" };
      }
    }

    this.#outbox.markRejected(queued.command_id, "cancelled");
    return { ok: true, queued: true };
  }

  /**
   * Admits queued `run.start` rows for `runnerId` into `active_runs` in FIFO
   * order, skipping rows whose session or `(runner, workspace)` is already
   * occupied, until the runner reaches its negotiated `maxConcurrentRuns` or no
   * eligible row remains.
   *
   * Fully synchronous: every read and write is `bun:sqlite`, so no `await` can
   * interleave a second pass inside this one and a subsequent sequential call
   * finds nothing to admit because the rows it admitted are no longer `queued`.
   */
  promote(runnerId: string, capacity: RunnerCapacity): string[] {
    if (capacity.state !== "ready") return [];

    const activeCount = (
      this.#db.query("SELECT COUNT(*) AS n FROM active_runs WHERE runner_id = ?").get(runnerId) as {
        n: number;
      }
    ).n;
    let slots = capacity.maxConcurrentRuns - activeCount;
    if (slots <= 0) return [];

    const admitted: Array<{ runId: string; commandId: string }> = [];
    for (const row of this.#outbox.queuedFor(runnerId)) {
      if (slots <= 0) break;

      const sessionId = row.sessionId;
      const runId = row.runId;
      const attemptId = row.attemptId;
      if (sessionId === undefined || runId === undefined || attemptId === undefined) {
        continue;
      }

      const queueWorkspaceId = row.queueSnapshot?.workspaceId ?? row.workspaceId;
      const sessionBusy =
        this.#db.query("SELECT 1 AS one FROM active_runs WHERE session_id = ?").get(sessionId) !==
        null;
      if (sessionBusy) continue;

      const workspaceBusy =
        queueWorkspaceId !== undefined && this.#workspaceBusy(runnerId, queueWorkspaceId);
      if (workspaceBusy) continue;

      try {
        this.#db.transaction(() => {
          this.#db
            .query(
              `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(runId, sessionId, runnerId, attemptId, Date.now());
          this.#outbox.markPromoted(row.commandId);
        })();
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          continue;
        }
        throw error;
      }

      admitted.push({ runId, commandId: row.commandId });
      slots -= 1;
    }

    if (admitted.length > 0) {
      this.#onDispatched?.(runnerId, admitted[0]!.commandId);
    }
    return admitted.map((entry) => entry.runId);
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
