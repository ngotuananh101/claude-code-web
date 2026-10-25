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
import {
  appendEvent,
  finishAttempt,
  lockHolder,
  recordSdkSessionId,
  releaseAttempt,
  sdkSessionIdForSession,
} from "@cc-web/runner-db";
import type { ApprovalOutcome, ApprovalRouter } from "./approvals.ts";
import { redactErrorText, redactSdkMessage } from "./redact.ts";
import { createStreamNormalizer } from "./stream-normalizer.ts";

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

export type ExecuteOptions = {
  workspacePath: string;
  sdk: SdkStream;
  signal?: AbortSignal;
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
};

/** How long a parked callback stays answerable: 5 minutes unless overridden. */
function approvalTimeoutMs(): number {
  const raw = Number(Bun.env["CC_WEB_APPROVAL_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
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
  // as absent — defense in depth behind the route's strict set.
  const model =
    typeof record?.["model"] === "string" && record["model"] !== "" ? record["model"] : undefined;

  const now = () => new Date().toISOString();
  let sequence = 0;
  let sdkSessionId: string | undefined;

  const append = (type: string, payload: unknown): void => {
    // The counter advances only after the row is committed. Incrementing first
    // and then failing leaves a hole in `local_sequence`, and the ACK watermark
    // stops at the first hole (§12.2) — every later event for this attempt would
    // then be re-sent forever, or never acknowledged at all.
    const next = sequence + 1;
    const result = appendEvent(db, {
      eventId: `evt_${attemptId}_${next}`,
      attemptId,
      localSequence: next,
      sessionId,
      runId,
      type,
      payload,
      occurredAt: now(),
    });
    if (!result.ok) {
      // The unique (attempt, sequence) index caught a second writer. Failing
      // loudly is the correct behavior: silently dropping it would corrupt the
      // transcript the replay is built from (§18.3).
      throw new Error(`duplicate event sequence ${next} for attempt ${attemptId}`);
    }
    sequence = next;
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
  // happened to be newest.
  const resume = sdkSessionIdForSession(db, sessionId);

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

  // The outcome for a run stopped before any terminal SDK frame. `interrupted`,
  // not `failed`: §14.2 keeps a deliberate cancel apart from a broken run, and
  // the payload is a constant — the abort error's text says nothing an operator
  // can act on, and this row is replayed to the browser and the journal (§12.3).
  const recordInterrupted = (): void => {
    state = "interrupted";
    append("run.interrupted", { reason: "aborted" });
  };

  try {
    // Everything after the lock check is inside the guard, `run.started`
    // included: an append can fail (a database error, or a sequence already
    // taken by a second writer), and a throw there would escape past the
    // `finally` — leaving the attempt `starting` and the workspace locked with
    // no owner.
    append("run.started", { commandId: command.commandId });

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
      prompt,
      cwd: options.workspacePath,
      ...(resume === undefined ? {} : { resume }),
      ...(options.signal ? { abort: options.signal } : {}),
      permissionMode,
      ...(model === undefined ? {} : { model }),
      ...(canUseTool === undefined ? {} : { canUseTool }),
    });

    for await (const message of stream) {
      if (typeof message !== "object" || message === null) continue;
      const sdkMessage = message as Record<string, unknown>;
      const type = String(sdkMessage["type"]);

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
    if (!terminalWritten && aborted()) recordInterrupted();
  } catch (error) {
    // Only a run that has not reported a terminal outcome is a failure. A throw
    // after `run.finished` is a transport problem that happened after the run
    // was already over, and writing `failed` here would make the attempt row
    // disagree with the event that recorded the outcome.
    if (!terminalWritten) {
      if (aborted()) {
        recordInterrupted();
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
