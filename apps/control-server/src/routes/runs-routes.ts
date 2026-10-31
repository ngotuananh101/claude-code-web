import {
  getProfileWithSecret,
  getSessionAttachment,
  type Scheduler,
  sessionPin,
  workspacesForOwner,
} from "@cc-web/control-db";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_IDS,
  type RunnerAttachmentItem,
  type RunProfilePayload,
} from "@cc-web/protocol";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";

/**
 * The browser's run surface over HTTP (§17.1): submit a prompt, cancel a run.
 */

/**
 * Submit a prompt as a run: decide, persist, deliver — all inside
 * scheduler.dispatch — and answer 202 with the ids the journal will use.
 *
 * Placement (§15.1, §11.3): the runners declare their workspaces, and a body
 * that names one is pinned to that set — the candidate runners are the owner's
 * who declare the workspace, the earliest-ready wins. A `runnerId` in the body
 * must be the owner's own runner and must declare the workspace it is being
 * asked to run in. A body that names neither keeps the §11.3 MVP: the owner's
 * runners in creation order, first one the gateway reports `ready`. The
 * capacity base is one concurrent run, which is what §11.3 sizes the MVP at.
 */
export async function handleDispatchRun(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  scheduler: Scheduler,
  sessionId: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const record = body as {
    prompt?: unknown;
    workspaceId?: unknown;
    permissionMode?: unknown;
    model?: unknown;
    effort?: unknown;
    ultracode?: unknown;
    runnerId?: unknown;
    branch?: unknown;
    resumeSessionId?: unknown;
    attachmentIds?: unknown;
    profileId?: unknown;
  };
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (prompt === "") {
    return new Response("bad request", { status: 400 });
  }
  const workspaceId =
    typeof record.workspaceId === "string" && record.workspaceId.trim() !== ""
      ? record.workspaceId
      : "default";

  // §13: the permission mode is the operator's standing choice for this run.
  // An unknown value is refused, not silently defaulted — a typo asking for
  // "bypassPermissions" must never run at "default" and vice versa.
  const PERMISSION_MODES: ReadonlySet<string> = new Set([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
  ]);
  let permissionMode: string | undefined;
  if (record.permissionMode !== undefined) {
    if (typeof record.permissionMode !== "string" || !PERMISSION_MODES.has(record.permissionMode)) {
      return new Response("bad request", { status: 400 });
    }
    permissionMode = record.permissionMode;
  }

  // §5.2: the model is a per-run choice. The runner advertises what its Claude
  // Code offers — including the custom names an operator configured — so the
  // shape is checked here and the membership is checked once the runner is
  // chosen (below). Same rule as the permission mode: a typo must be refused,
  // never silently run on a model the operator did not ask for. Printable
  // ASCII only: the value reaches the SDK as a model name, not a shell word.
  const MODEL_VALUE = /^[\x21-\x7e]{1,200}$/;
  let model: string | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== "string" || !MODEL_VALUE.test(record.model)) {
      return new Response("bad request", { status: 400 });
    }
    model = record.model;
  }

  // §5.2: effort is the reasoning depth Claude Code applies to the run.
  // `max` is session-only there, so it has to be a wire value. A level this
  // protocol does not speak is refused rather than downgraded silently — the
  // operator asked for a depth and must learn it was not available.
  let effort: EffortLevel | undefined;
  if (record.effort !== undefined) {
    const level = EFFORT_LEVELS.find((candidate) => candidate === record.effort);
    if (level === undefined) {
      return new Response("bad request", { status: 400 });
    }
    effort = level;
  }

  // §5.2: ultracode is a standing orchestration mode, not an effort level; the
  // two travel separately because setting effort must not silently turn it off
  // (the SDK's own flag semantics).
  let ultracode: boolean | undefined;
  if (record.ultracode !== undefined) {
    if (typeof record.ultracode !== "boolean") {
      return new Response("bad request", { status: 400 });
    }
    ultracode = record.ultracode;
  }

  // M4: the branch is a per-run choice over the workspace's local heads. The
  // shape is defense in depth — the runner's checkout gate enforces the same
  // rules before any argv reaches git — but a typo is refused here, not run.
  // A branch is a property of a workspace: it only travels alongside a
  // workspaceId in the same body.
  const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  let branch: string | undefined;
  if (record.branch !== undefined) {
    if (
      typeof record.branch !== "string" ||
      record.branch.length > 256 ||
      !BRANCH_NAME.test(record.branch) ||
      record.branch.includes("..")
    ) {
      return new Response("bad request", { status: 400 });
    }
    if (typeof record.workspaceId !== "string" || record.workspaceId.trim() === "") {
      return new Response("bad request", { status: 400 });
    }
    branch = record.branch;
  }

  // §10.4: resumeSessionId is the id of a Claude session to resume. It must be a
  // non-empty string — the runner's executor ignores empty or non-string values,
  // but an explicit bad value here is a client error, not a silent default that
  // would start a fresh conversation when the operator asked to continue one.
  let resumeSessionId: string | undefined;
  if (record.resumeSessionId !== undefined) {
    if (typeof record.resumeSessionId !== "string" || record.resumeSessionId.trim() === "") {
      return new Response("bad request", { status: 400 });
    }
    resumeSessionId = record.resumeSessionId.trim();
  }

  // §4.4: attachmentIds binds already-uploaded files to this run. Each id must be
  // a string the owner can read — a missing or foreign one is a bad request, not
  // a silent drop. The lookup happens before runner selection so a bad id is a
  // 400 even when no runner is ready.
  let attachments: RunnerAttachmentItem[] | undefined;
  if (record.attachmentIds !== undefined) {
    if (!Array.isArray(record.attachmentIds)) {
      return new Response("bad request", { status: 400 });
    }
    for (const id of record.attachmentIds) {
      if (typeof id !== "string" || id.trim() === "") {
        return new Response("bad request", { status: 400 });
      }
    }
    attachments = [];
    for (const id of record.attachmentIds as string[]) {
      const attachment = getSessionAttachment(options.db, id, authorized.userId);
      if (attachment === undefined || attachment.sessionId !== sessionId) {
        return new Response("bad request", { status: 400 });
      }
      attachments.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      });
    }
  }

  // §17.1, §18.1: when the body names a profile, resolve it to the full
  // RunProfilePayload (with the cleartext API key) before dispatch. An unknown
  // or foreign-owned id is refused with `unknown_profile` — never 404, to avoid
  // leaking whether a profile id exists under another owner.
  let profile: RunProfilePayload | undefined;
  if (record.profileId !== undefined) {
    if (typeof record.profileId !== "string" || record.profileId.trim() === "") {
      return new Response("bad request", { status: 400 });
    }
    const profileRow = getProfileWithSecret(options.db, record.profileId, authorized.userId);
    if (profileRow === null) {
      return new Response("unknown_profile", { status: 400 });
    }
    profile = buildProfilePayload(profileRow);
  }

  // §2.3/ADR-006: a session's first accepted dispatch pinned it to a
  // (workspace, runner) pair, and every later run rides that pin. The pin is
  // the placement decision — made once, made durably.
  const pin = sessionPin(options.db, sessionId);
  if (pin !== undefined && pin.ownerId !== authorized.userId) {
    // Existence is not another user's to learn: 404 before any other signal,
    // including session_busy.
    return new Response("not found", { status: 404 });
  }
  if (pin !== undefined) {
    // A contradiction between the body and the pin is its own refusal — the
    // operator is asking to move a session, which §21.6 migration will own.
    // Absent or blank choices are not contradictions: they ride the pin. A
    // non-string runnerId is not a contradiction but malformed input, and the
    // 400 below reads it as such.
    if (typeof record.runnerId === "string" && record.runnerId !== pin.runnerId) {
      return new Response("session_pinned", { status: 409 });
    }
    if (
      typeof record.workspaceId === "string" &&
      record.workspaceId.trim() !== "" &&
      record.workspaceId !== pin.workspaceId
    ) {
      return new Response("session_pinned", { status: 409 });
    }
    // M4: the pin decides where the session lives; the branch stays a per-run
    // choice, validated against the pinned runner's current declaration — the
    // same authority the fresh path narrows by. A stale declaration is the
    // honest refusal: the branch no longer exists where the session runs.
    if (branch !== undefined) {
      const pinned = workspacesForOwner(options.db, authorized.userId).find(
        (w) => w.runnerId === pin.runnerId && w.workspaceId === pin.workspaceId,
      );
      if (pinned === undefined || !pinned.branches.includes(branch)) {
        return new Response("unknown_branch", { status: 400 });
      }
    }
  }

  // §15.1: an explicit runner pin for a NEW session. A non-string is malformed
  // input; a string that is not the owner's own live runner is refused with
  // its own code — a run must never silently land somewhere the operator did
  // not pin. (A pinned session skips this entirely: its pin was validated
  // when it was written.)
  let runnerId: string | undefined;
  if (typeof record.runnerId !== "string" && record.runnerId !== undefined) {
    return new Response("bad request", { status: 400 });
  }
  if (pin !== undefined) {
    // Trust the pin, not the declarations: workspace drift must never brick a
    // resume (ADR-006), so there are no candidate or declaration checks here.
    // The pinned runner must still be the owner's live one — revoked is as
    // good as gone, and the session waits rather than failing over.
    const pinned = options.db
      .query("SELECT revoked_at FROM runners WHERE id = ? AND owner_id = ?")
      .get(pin.runnerId, authorized.userId) as { revoked_at: number | null } | null;
    if (pinned === null || pinned.revoked_at !== null) {
      return new Response("runner_offline", { status: 503 });
    }
    runnerId = pin.runnerId;
  } else if (record.runnerId !== undefined) {
    const owned = options.db
      .query("SELECT id FROM runners WHERE id = ? AND owner_id = ? AND revoked_at IS NULL")
      .get(record.runnerId, authorized.userId) as { id: string } | null;
    if (owned === null) {
      return new Response("unknown_runner", { status: 400 });
    }
    runnerId = record.runnerId;
  }

  // Checked before runner selection so a double-submit answers with its own
  // cause: the session is busy, not "no runner could take it" (§2.3).
  if (scheduler.activeRunFor(sessionId)) {
    return new Response("session_busy", { status: 409 });
  }

  // Candidates, in creation order — NEW sessions only. A workspace in the
  // body narrows them to the runners that declare it (§15.1: the runner is
  // the registration authority) — a workspaceId nobody declared must never
  // widen into "any ready runner". The 4xx refusals come before readiness on
  // purpose: a placement that cannot work is a client error even when a
  // runner happens to be down. A pinned session never sees this code: its
  // placement was decided once, at pin time.
  let candidates: Array<{ id: string }> = [];
  if (pin === undefined) {
    if (typeof record.workspaceId === "string" && record.workspaceId.trim() !== "") {
      // The named-workspace path reads the declaration rows through
      // workspacesForOwner: the branch filter needs `branches`, which lives on
      // those rows, and the function preserves runner creation order, so
      // first-wins placement survives the move off the raw JOIN.
      const declared = workspacesForOwner(options.db, authorized.userId).filter(
        (w) => w.workspaceId === workspaceId,
      );
      if (declared.length === 0) {
        return new Response("unknown_workspace", { status: 400 });
      }
      if (runnerId !== undefined && !declared.some((w) => w.runnerId === runnerId)) {
        return new Response("unknown_workspace", { status: 400 });
      }
      const selected: string | undefined = branch;
      const narrowed =
        selected === undefined ? declared : declared.filter((w) => w.branches.includes(selected));
      if (selected !== undefined && narrowed.length === 0) {
        return new Response("unknown_branch", { status: 400 });
      }
      if (runnerId !== undefined && !narrowed.some((w) => w.runnerId === runnerId)) {
        return new Response("unknown_branch", { status: 400 });
      }
      candidates = narrowed.map((w) => ({ id: w.runnerId }));
    } else {
      candidates = options.db
        .query(
          "SELECT id FROM runners WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at",
        )
        .all(authorized.userId) as Array<{ id: string }>;
    }
  }

  let ready: string | undefined;
  let connected = false;
  if (runnerId !== undefined) {
    const state = runnerGateway.stateOf(runnerId);
    if (state === "ready") ready = runnerId;
    else if (state === "connected") connected = true;
  } else {
    for (const row of candidates) {
      const state = runnerGateway.stateOf(row.id);
      if (state === "ready") {
        ready = row.id;
        break;
      }
      if (state === "connected") connected = true;
    }
  }
  if (ready === undefined) {
    // §17.3: never hold the request on an offline runner. The reason tells the
    // operator which half is missing — nothing connected, or a connection that
    // has not reconciled yet (§6.2).
    return new Response(connected ? "runner_not_ready" : "runner_offline", { status: 503 });
  }

  // §5.2: the chosen runner is the authority on what it can run. A runner that
  // advertised its models accepts only those; one that predates discovery
  // advertises nothing, and the protocol's own list is all the server can
  // honestly promise.
  if (model !== undefined) {
    const advertised = runnerGateway.modelsOf(ready);
    const known =
      advertised.length > 0
        ? advertised.some((candidate) => candidate.value === model)
        : MODEL_IDS.some((candidate) => candidate === model);
    if (!known) {
      return new Response("unknown_model", { status: 400 });
    }
  }

  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  // The payload carries the pin's workspace for a pinned session: a
  // prompt-only rerun must run where the session lives, not where a fresh
  // session would have landed.
  // Resolve the workspace path to forward as a fallback for runners that may not
  // have the workspace registered on this boot (§4.1).
  const workspace = workspacesForOwner(options.db, authorized.userId).find(
    (w) =>
      (pin !== undefined ? w.workspaceId === pin.workspaceId : w.workspaceId === workspaceId) &&
      (pin !== undefined ? w.runnerId === pin.runnerId : true),
  );
  const workspacePath = workspace?.path;

  const decision = await scheduler.dispatch(
    {
      sessionId,
      runId,
      attemptId,
      workspaceId: pin !== undefined ? pin.workspaceId : workspaceId,
      prompt,
      ownerId: authorized.userId,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(ultracode === undefined ? {} : { ultracode }),
      ...(branch === undefined ? {} : { branch }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(profile === undefined ? {} : { profile }),
    },
    scheduler.capacityFor(ready, {
      runnerId: ready,
      state: "ready",
      maxConcurrentRuns: 1,
      activeRuns: 0,
    }),
  );

  if (!decision.ok) {
    const status =
      decision.reason === "session_busy" || decision.reason === "duplicate_run" ? 409 : 503;
    return new Response(decision.reason, { status });
  }

  return new Response(JSON.stringify({ runId, attemptId, sessionId, runnerId: ready }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Cancel an active run (§14.2): a durable request enqueued to the holding
 * runner, not an in-memory abort. 404 for a run nobody is holding — an
 * already-finished run needs no cancel, and inventing one would promise
 * delivery the outbox cannot keep.
 */
export async function handleCancelRun(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  scheduler: Scheduler,
  runId: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const decision = await scheduler.cancel(runId);
  if (!decision.ok) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ runId, commandId: decision.commandId }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Map a `ProfileWithSecret` (DB row shape) to the wire `RunProfilePayload` the
 * runner consumes. Fields are included only when non-empty so a profile with no
 * model mapping or settings does not render those keys on the wire.
 */
function buildProfilePayload(row: {
  id: string;
  name: string;
  endpoint: string;
  authField: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  apiKey: string | undefined;
  modelMapping: Record<string, unknown>;
  settings: Record<string, unknown>;
}): RunProfilePayload {
  return {
    profileId: row.id,
    name: row.name,
    endpoint: row.endpoint,
    authField: row.authField,
    ...(row.apiKey === undefined ? {} : { apiKey: row.apiKey }),
    ...(Object.keys(row.modelMapping).length === 0 ? {} : { modelMapping: row.modelMapping }),
    ...(Object.keys(row.settings).length === 0 ? {} : { settings: row.settings }),
  };
}
