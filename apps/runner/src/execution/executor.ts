/**
 * Running one attempt (§10.1).
 *
 * Called exactly once per accepted command — the inbox dedupes before this is
 * ever reached — so this module does not repeat that job. Its own guarantees
 * are the ones the inbox cannot provide:
 *
 *  - the run is observed from `starting` to a terminal state, with every
 *    observation durably appended to the event outbox before being counted
 *  - a terminal outcome is written once (§22.2)
 *  - the workspace lock outlives nothing: it is released on every path
 *
 * The SDK is a parameter, not an import: a test drives this whole lifecycle
 * with a generator function, and the daemon passes the real adapter.
 */

import type { Database } from "bun:sqlite";
import type { AttachmentInfo, RunnerAttachmentItem } from "@cc-web/protocol";
import {
  appendEvent,
  finishAttempt,
  lockHolder,
  recordSdkSessionId,
  releaseAttempt,
  sdkSessionIdForSession,
} from "@cc-web/runner-db";
import type { ApprovalOutcome, ApprovalRouter } from "./approvals.ts";
import { downloadRunnerAttachments, injectAttachmentsContext } from "./attachments.ts";
import { boundEventPayload } from "./payload-bound.ts";
import { redactErrorText, redactSdkMessage } from "./redact.ts";
import { createScheduleObserver } from "./schedule-events.ts";
import { createStreamNormalizer } from "./stream-normalizer.ts";
import { isToolResultFrame, toolCompletionsOf } from "./tool-results.ts";

/** The SDK seam: given options, returns the message stream (§10.2). */
export type SdkStream = (options: SdkOptions) => AsyncIterable<Record<string, unknown>>;

export type SdkOptions = {
  prompt: string;
  cwd: string;
  resume?: string;
  abort?: AbortSignal;
  permissionMode: string;
  /** The model the run named (§5.2); absent means the SDK's own default. */
  model?: string;
  /** The reasoning effort the run named (§5.2); absent means the SDK's default. */
  effort?: string;
  /** The standing ultracode mode (§5.2); absent leaves the SDK's default. */
  ultracode?: boolean;
  canUseTool?: (
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal },
  ) => Promise<ApprovalOutcome>;
};

export type RunInput = {
  protocolVersion: number;
  commandId: string;
  runnerId: string;
  kind: string;
  issuedAt: string;
  payload: unknown;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  workspaceId?: string;
};

export type TerminalOutcome = {
  state: "finished" | "failed" | "interrupted";
  sdkSessionId?: string;
};

/**
 * Why the runner's checkout gate refused to move a workspace (M4). Each is
 * an operator-actionable fact, not an errno: `dirty_tree` means the operator
 * decides what happens to their edits — the runner never cleans or stashes.
 */
export type BranchRefusal =
  | "invalid_branch_name"
  | "dirty_tree"
  | "unknown_branch"
  | "checkout_failed";

/**
 * The workspace-preparation contract (M4): what the gate tells the executor
 * between `run.started` and the SDK stream. `checkedOut: false` with
 * `kind: "ready"` is the no-branch case — no git ran, the run proceeds on
 * whatever the workspace already has checked out.
 */
export type PrepareWorkspaceResult =
  | { kind: "ready"; checkedOut: boolean; branch?: string }
  | { kind: "refused"; reason: BranchRefusal; branch?: string };

export type ExecuteOptions = {
  workspacePath: string;
  sdk: SdkStream;
  signal?: AbortSignal;
  /**
   * The SDK session id to resume (§10.4). When present it is forwarded in the
   * `run.started` event payload so the web UI can fetch historical messages.
   */
  resumeSessionId?: string;
  /**
   * The workspace-preparation gate (M4): runs after `run.started` and before
   * anything touches the SDK, under the workspace lock the caller already
   * holds. The daemon wires the branch checkout gate here; tests inject
   * fakes. Absent means nothing to prepare — the pre-M4 behavior.
   */
  prepareWorkspace?: (
    workspacePath: string,
    branch: string | undefined,
  ) => Promise<PrepareWorkspaceResult>;
  /**
   * The run-start baseline capture (P3-B): runs after the branch gate and
   * before the SDK starts, under the workspace lock the caller already holds.
   * A refusal fails the run with `snapshot_failed` and releases the lock.
   * Absent means no baseline is captured.
   */
  captureBaseline?: (
    workspacePath: string,
    attemptId: string,
    sessionId: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The runner's home directory, used as the base for downloading session
   * attachments into `${runnerHome}/tmp/sessions/<sessionId>/attachments/`.
   * Absent means attachment downloading is skipped (pre-attachment behavior).
   */
  runnerHome?: string;
  /**
   * The control server's URL, used to download attachments from
   * `${serverUrl}/api/runner/attachments/<id>`. Paired with `token`.
   */
  serverUrl?: string;
  /**
   * The runner's credential token, sent as `Authorization: Bearer <token>`
   * when downloading attachments. Paired with `serverUrl`.
   */
  token?: string;
  /**
   * Builds the attempt's approval gate from the executor's own append closure
   * (§13) — the gate's events must share the attempt's sequence. Optional:
   * tests of non-approval paths omit it, and the production controller always
   * provides one.
   */
  router?: (append: (type: string, payload: unknown) => void, attemptId: string) => ApprovalRouter;
  /** Called after every `approval.*` append: a suspended run never settles,
   * so the pump must be flushed by the gate itself, not by onSettled. */
  onApprovalEvent?: () => void;
  /** Called after any event is appended to the local outbox (§12.2). */
  onEvent?: () => void;
  /**
   * Offers the attempt's own sequenced append to the caller, once, as soon as
   * the run is observable (§12.6).
   *
   * The executor owns this attempt's `local_sequence` space in a closure, and
   * nothing else can write into it: a second writer at a borrowed sequence
   * collides locally, at a fresh sequence collides with the executor's next
   * write, and either leaves a hole the ACK watermark stops at (§12.2). So a
   * component that must journal something *about* this attempt — the spool
   * warning is the first — borrows this closure instead of writing its own row.
   */
  onAppend?: (append: (type: string, payload: unknown) => void) => void;
  /**
   * Why the abort happened, read at the moment the run is stopped rather than
   * captured when the run starts: a cancel arrives after the run is under way,
   * so a value read at construction time could only ever be `undefined`.
   *
   * A reason present means the stop was a policy decision with something to
   * say about it — the spool critical threshold is the first — and it is
   * recorded as `run.failed` so the operator learns why. Absent keeps the
   * deliberate-cancel reading: `run.interrupted`, no reason (§14.2).
   */
  abortReason?: () => string | undefined;
};

/**
 * How long a parked callback stays answerable. By default a gate never expires:
 * a permission request waits for a human, however long that takes. Setting
 * `CC_WEB_APPROVAL_TIMEOUT_MS` to a positive number restores a finite window.
 */
function approvalTimeoutMs(): number {
  const raw = Number(Bun.env["CC_WEB_APPROVAL_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export async function executeRun(
  db: Database,
  command: RunInput,
  options: ExecuteOptions,
): Promise<TerminalOutcome> {
  const attemptId = command.attemptId ?? command.commandId;
  const sessionId = command.sessionId ?? "";
  const runId = command.runId ?? "";
  const record = command.payload as Record<string, unknown> | undefined;
  const prompt = typeof record?.["prompt"] === "string" ? record["prompt"] : "";
  const permissionMode =
    typeof record?.["permissionMode"] === "string" ? record["permissionMode"] : "default";
  // Unlike permissionMode there is no runner-side default: an unnamed model
  // means the SDK's own choice, so the option is omitted downstream. Empty is
  // as absent — defense in depth behind the route's strict set. The branch
  // follows the same rule: it only exists as a non-empty string.
  const model =
    typeof record?.["model"] === "string" && record["model"] !== "" ? record["model"] : undefined;
  // Effort and ultracode follow the same rule: a non-empty string / a real
  // boolean, else absent — an unnamed choice must not become an option.
  const effort =
    typeof record?.["effort"] === "string" && record["effort"] !== ""
      ? record["effort"]
      : undefined;
  const ultracode = typeof record?.["ultracode"] === "boolean" ? record["ultracode"] : undefined;
  const branch =
    typeof record?.["branch"] === "string" && record["branch"] !== ""
      ? record["branch"]
      : undefined;

  // Attachment items from the run.start payload (§attachments). Parsed defensively:
  // the payload is unknown until the protocol parser validates each item.
  const rawAttachments = record?.["attachments"];
  const attachments: RunnerAttachmentItem[] =
    Array.isArray(rawAttachments) && rawAttachments.every(isRunnerAttachmentItem)
      ? (rawAttachments as RunnerAttachmentItem[])
      : [];

  const now = () => new Date().toISOString();
  let sequence = 0;
  let sdkSessionId: string | undefined;

  const append = (type: string, payload: unknown): void => {
    // The counter advances only after the row is committed. Incrementing first
    // and then failing leaves a hole in `local_sequence`, and the ACK watermark
    // stops at the first hole (§12.2) — every later event for this attempt would
    // then be re-sent forever, or never acknowledged at all.
    const next = sequence + 1;
    // §12.6: the row must fit the frame it will be sent in. A durable event
    // above the transport ceiling could never be delivered — every replay is
    // refused the same way — so it is bounded here, before it is persisted.
    const result = appendEvent(db, {
      eventId: `evt_${attemptId}_${next}`,
      attemptId,
      localSequence: next,
      sessionId,
      runId,
      type,
      payload: boundEventPayload(payload),
      occurredAt: now(),
    });
    if (!result.ok) {
      // The unique (attempt, sequence) index caught a second writer. Failing
      // loudly is the correct behavior: silently dropping it would corrupt the
      // transcript the replay is built from (§18.3).
      throw new Error(`duplicate event sequence ${next} for attempt ${attemptId}`);
    }
    sequence = next;
    options.onEvent?.();
  };

  // §11.4: one managed writer per workspace. Another attempt holding the
  // workspace means this run must not touch it — and must not reach the SDK,
  // because the model would start editing files the other attempt owns.
  const holder = lockHolder(db, options.workspacePath);
  if (holder !== undefined && holder !== attemptId) {
    // The holder's id is deliberately not persisted. This payload is replayed
    // to the browser and copied into the server journal (§12.3), so it is a
    // public document: another attempt's id is runner-internal bookkeeping that
    // no viewer can act on, and publishing it gives a spectator a stable handle
    // on a run they were never shown. `workspace_locked` is the whole fact.
    append("run.failed", { error: "workspace_locked" });
    // The attempt's own lock, not the holder's: `releaseAttempt` deletes by
    // attempt id, so the workspace this run was refused is untouched. Skipping
    // this left a terminal attempt owning a lock that nothing would release —
    // and it must happen even if recording the outcome throws, for the same
    // reason as the main path's finally.
    try {
      finishAttempt(db, { attemptId, state: "failed" });
    } finally {
      releaseAttempt(db, attemptId);
    }
    return { state: "failed" };
  }

  // §10.4: resume the session this runner last used for it, by explicit id.
  // `continue: true` is never used — it would pick whichever conversation
  // happened to be newest. An explicit `resumeSessionId` in the run.start
  // payload takes precedence over the stored session id, so a caller can point
  // at a specific conversation regardless of what this runner last recorded.
  const explicitResume =
    typeof record?.["resumeSessionId"] === "string" && record["resumeSessionId"].trim() !== ""
      ? record["resumeSessionId"].trim()
      : undefined;
  const resume = explicitResume ?? sdkSessionIdForSession(db, sessionId);

  // A terminal *state* is decided once. The terminal *event* is written only by
  // the path that observed it: a `result` frame carries its own event type, and
  // a thrown stream carries `run.failed`. A stream that yields a result and
  // then dies has already produced its terminal event, so the catch must not
  // add a second one — and must not overwrite the state that event recorded.
  let state: "finished" | "failed" | "interrupted" = "finished";
  let terminalWritten = false;
  // The attempt's gate, created inside the guard once the append closure
  // exists. The `finally` tears down whatever approvals it still holds parked.
  let router: ApprovalRouter | undefined;
  let canUseTool: NonNullable<SdkOptions["canUseTool"]> | undefined;

  // Why the abort is recognized by the signal and not by the thrown error: the
  // SDK's abort error is an `Error` subclass that sets no `name` (verified in
  // 0.3.309: `new AbortError("Operation aborted")` reports `name === "Error"`),
  // so no property of the object identifies it — and §4.2 forbids importing the
  // SDK here to `instanceof` it. The signal is this runner's own causal action
  // and only this process fires it, so `signal.aborted` at the moment the stream
  // died is the whole fact.
  const aborted = () => options.signal?.aborted === true;

  // The outcome for a run stopped before any terminal SDK frame. A reason from
  // `abortReason` means the stop was a policy decision with something to say —
  // the spool critical threshold is the first — and that reason is the whole
  // value the operator gets, so it is written as `run.failed` rather than as an
  // interrupted run with no explanation. Without one, §14.2 keeps a deliberate
  // cancel apart from a broken run: `interrupted`, with a constant payload,
  // because the abort error's text says nothing an operator can act on and the
  // row is replayed to the browser and copied into the journal (§12.3).
  const recordAborted = (): void => {
    const reason = options.abortReason?.();
    if (reason !== undefined && reason !== "") {
      state = "failed";
      append("run.failed", { error: reason });
      return;
    }
    state = "interrupted";
    append("run.interrupted", { reason: "aborted" });
  };

  let effectivePrompt = prompt;
  let attachmentInfos: AttachmentInfo[] | undefined;

  try {
    // Attachment download and context injection. Done inside the guard so any
    // download failure produces a terminal event and releases the workspace lock
    // via `finally`.
    if (
      attachments.length > 0 &&
      options.runnerHome !== undefined &&
      options.serverUrl !== undefined &&
      options.token !== undefined
    ) {
      try {
        const downloaded = await downloadRunnerAttachments({
          serverUrl: options.serverUrl,
          token: options.token,
          sessionId,
          runnerHome: options.runnerHome,
          attachments,
        });
        attachmentInfos = downloaded.map((f) => {
          const match = attachments.find((a) => a.name === f.name);
          return {
            id: match?.id ?? f.name,
            name: f.name,
            mimeType: f.mimeType,
            size: match?.size ?? 0,
          };
        });
        effectivePrompt = injectAttachmentsContext(prompt, downloaded);
      } catch (error) {
        state = "failed";
        terminalWritten = true;
        append("run.failed", {
          error: "attachment_download_failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        return { state: "failed" };
      }
    }

    // Everything after the lock check is inside the guard, `run.started`
    // included: an append can fail (a database error, or a sequence already
    // taken by a second writer), and a throw there would escape past the
    // `finally` — leaving the attempt `starting` and the workspace locked with
    // no owner.
    //
    // Notice: `run.started` records the clean user `prompt`, NOT `effectivePrompt`.
    // Injected attachment paths must not leak into the journal or user bubble.
    append("run.started", {
      commandId: command.commandId,
      ...(prompt !== "" ? { prompt } : {}),
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
      ...(attachmentInfos !== undefined && attachmentInfos.length > 0
        ? { attachments: attachmentInfos }
        : {}),
    });

    // §12.6: the attempt's own append, offered once the run is observable and
    // before anything that could warn about the spool. The caller may journal
    // through it — the sequence space stays single-writer — or ignore it.
    options.onAppend?.(append);

    // M4: prepare the workspace (the branch gate) after the run is observable
    // and before the SDK exists — a refusal is the operator's answer, so it is
    // a journal event, not a transport error. The `finally` below owns the
    // attempt and the lock on every path out of here.
    if (options.prepareWorkspace !== undefined) {
      const prepared = await options.prepareWorkspace(options.workspacePath, branch);
      if (prepared.kind === "refused") {
        state = "failed";
        terminalWritten = true;
        append("run.failed", {
          error: "branch_refused",
          reason: prepared.reason,
          ...(prepared.branch === undefined ? {} : { branch: prepared.branch }),
        });
        return { state: "failed" };
      }
      if (prepared.checkedOut) {
        append("run.status", {
          action: "checkout",
          ...(prepared.branch === undefined ? {} : { branch: prepared.branch }),
        });
      }
    }

    // P3-B: capture the run-start baseline after the branch gate and before the
    // SDK starts. A refusal fails the run with `snapshot_failed` and releases the
    // workspace lock — the `finally` below owns both the attempt and the lock.
    if (options.captureBaseline !== undefined) {
      const captured = await options.captureBaseline(options.workspacePath, attemptId, sessionId);
      if (!captured.ok) {
        state = "failed";
        terminalWritten = true;
        append("run.failed", { error: "snapshot_failed", reason: captured.reason });
        return { state: "failed" };
      }
    }

    // §13: the gate's events ride this attempt's sequenced append, and every
    // one of them triggers the pump flush — a suspended run never settles, so
    // onSettled alone would leave the request unseen until its timeout.
    if (options.router !== undefined) {
      const gatedAppend = (type: string, payload: unknown): void => {
        append(type, payload);
        if (type.startsWith("approval.")) options.onApprovalEvent?.();
      };
      const gate = options.router(gatedAppend, attemptId);
      router = gate;
      canUseTool = (toolName: string, input: unknown, _toolOptions: { signal: AbortSignal }) =>
        gate.open({
          attemptId,
          runId,
          kind: toolName === "AskUserQuestion" ? "user_question" : "tool_permission",
          toolName,
          input,
          timeoutMs: approvalTimeoutMs(),
        });
    }

    // One normalizer per run: its closure is the stream's correlation state.
    const normalize = createStreamNormalizer();

    // Building the stream is inside the guard for the same reason: loading the
    // SDK or resolving an option can fail before there is anything to iterate.
    const stream = options.sdk({
      prompt: effectivePrompt,
      cwd: options.workspacePath,
      ...(resume === undefined ? {} : { resume }),
      ...(options.signal ? { abort: options.signal } : {}),
      permissionMode,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(ultracode === undefined ? {} : { ultracode }),
      ...(canUseTool === undefined ? {} : { canUseTool }),
    });

    // §11.5: the schedule mirror correlates tool_use and tool_result frames, so
    // it sees every raw frame before the branches below consume or skip it.
    const schedules = createScheduleObserver();

    for await (const message of stream) {
      if (typeof message !== "object" || message === null) continue;
      const sdkMessage = message as Record<string, unknown>;
      const type = String(sdkMessage["type"]);

      for (const event of schedules(sdkMessage)) append(event.type, event.payload);

      // §10.4: the SDK session id comes from the init frame and belongs to the
      // attempt, not to the command envelope.
      if (type === "system" && sdkMessage["subtype"] === "init") {
        const id = sdkMessage["session_id"];
        if (typeof id === "string" && id !== "") {
          sdkSessionId = id;
          recordSdkSessionId(db, attemptId, id);
        }
      }

      // §12.3: partial `stream_event` frames are the raw deltas behind a message
      // the SDK also sends complete. The normalizer boils them down to
      // message.started / message.delta keyed by the SDK message id — the
      // durable transcript stays complete-message based, the browser gets the
      // text as it arrives.
      if (type === "stream_event") {
        for (const normalized of normalize(sdkMessage)) append(normalized.type, normalized.payload);
        continue;
      }

      // §12.3: a pure tool_result user frame is the SDK's evidence the tool
      // ran and returned — one tool.completed per block replaces the generic
      // run.status blob the whole frame used to land as. Mixed or echo frames
      // keep that path so an unexpected shape stays visible.
      if (type === "user" && isToolResultFrame(sdkMessage)) {
        for (const completion of toolCompletionsOf(sdkMessage))
          append("tool.completed", completion);
        continue;
      }

      const eventType = eventTypeOf(sdkMessage);
      append(eventType, redactSdkMessage(sdkMessage));
      if (eventType === "run.finished") {
        state = "finished";
        terminalWritten = true;
      } else if (eventType === "run.failed") {
        state = "failed";
        terminalWritten = true;
      }
    }

    // The loop can also end normally on an abort: the pending read unblocks and
    // the iterator returns instead of throwing. Without this check the run
    // would be recorded `finished` with no terminal event at all — the state a
    // crashed process leaves, arrived at on a path that knew better.
    if (!terminalWritten && aborted()) recordAborted();
  } catch (error) {
    // Only a run that has not reported a terminal outcome is a failure. A throw
    // after `run.finished` is a transport problem that happened after the run
    // was already over, and writing `failed` here would make the attempt row
    // disagree with the event that recorded the outcome.
    if (!terminalWritten) {
      if (aborted()) {
        recordAborted();
      } else {
        state = "failed";
        append("run.failed", { error: sanitizeError(error) });
      }
    }
  } finally {
    // §13: whatever the gate still holds parked dies with the attempt — a
    // cancel or an abort never approves anything implicitly. Aborted covers
    // the deliberate cancel too: both arrive as the run's own signal firing.
    // Released even if recording the outcome fails. The two are separate
    // statements because the terminal write can throw — a busy timeout, a full
    // disk — and it is the last thing between here and the end of the run. A
    // throw that skipped the release would leave the workspace locked for the
    // life of the process, since boot recovery is the only other thing that
    // frees a lock and it only runs at startup.
    try {
      router?.abandonAttempt(attemptId, aborted() ? "aborted" : "abandoned");
      finishAttempt(db, { attemptId, state });
    } finally {
      releaseAttempt(db, attemptId);
    }
  }

  return { ...(sdkSessionId === undefined ? {} : { sdkSessionId }), state };
}

function eventTypeOf(message: Record<string, unknown>): string {
  const type = String(message["type"]);
  if (type === "system" && message["subtype"] === "init") return "session.updated";
  if (type === "assistant") return "message.completed";
  if (type === "result") {
    // The subtype alone does not mean success. The SDK documents
    // `subtype: "success"` with `is_error: true` as "the error text when the turn
    // ended on an API error" — an overloaded or refused request arrives as a
    // successful-shaped frame. Reading only `subtype` records that run as
    // finished, and the attempt row, journal and browser all inherit it.
    if (message["is_error"] === true) return "run.failed";
    return message["subtype"] === "success" ? "run.finished" : "run.failed";
  }
  return "run.status";
}

/** Narrow `unknown` to a `RunnerAttachmentItem` without importing the protocol's
 * parser — the shape is stable enough for a runtime type guard here. */
function isRunnerAttachmentItem(value: unknown): value is RunnerAttachmentItem {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["mimeType"] === "string" &&
    typeof r["size"] === "number"
  );
}

function sanitizeError(error: unknown): string {
  // Error messages can quote paths, commands or prompt fragments; none of that
  // is a credential, but neither is it worth keeping unbounded. Truncate and
  // never include a stack — stacks name internals an operator cannot act on.
  //
  // Redaction comes first, and on the whole message: a CLI error that echoes its
  // environment is the one realistic way a provider key reaches this row, and
  // this row is replayed to the browser and copied into the server journal
  // (§12.3, §19.4). Truncating a secret still leaves a secret.
  const text = redactErrorText(String((error as Error)?.message ?? error));
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
