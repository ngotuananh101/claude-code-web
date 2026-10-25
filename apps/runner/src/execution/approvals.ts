import type { Database } from "bun:sqlite";
import { finishApproval, insertPendingApproval, pendingApproval } from "@cc-web/runner-db";
import { redactErrorText, summarizeToolInput } from "./redact.ts";

/**
 * The runner's approval gate (§13).
 *
 * When the SDK asks for a tool permission or a user answer, the callback is
 * parked on a promise and the run suspends: nothing else resolves that promise
 * except a validated `approval.respond` command, an expiry sweep, or the
 * attempt being torn down. The rules that make this safe, each enforced below:
 *
 *  - the decision must match the row's `input_hash` — a decision projected
 *    from a different request never resolves this callback
 *  - only `decision === "allow"` is an allow; a corrupted payload lands on
 *    the deny path, never on the allow path
 *  - the row's CAS (`pending → resolved`) is the once-guard, so a replayed
 *    command resolves nothing
 *  - every non-user terminal — timeout, cancel, abort, crash — DENIES the
 *    callback and emits `approval.expired`; nothing implicit ever approves
 */

export type ApprovalOutcome =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type ApprovalRouterOptions = {
  db: Database;
  /** The executor's append closure — every `approval.*` event rides the same outbox. */
  append: (type: string, payload: unknown) => void;
  now?: () => number;
  /** Timer injection for tests; defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

type OpenInput = {
  attemptId: string;
  runId: string;
  kind: "tool_permission" | "user_question";
  toolName: string;
  input: unknown;
  timeoutMs: number;
};

type RespondPayload = {
  approvalId: string;
  decision?: unknown;
  answers?: unknown;
  inputHash?: unknown;
};

type LiveCallback = {
  resolve: (outcome: ApprovalOutcome) => void;
  attemptId: string;
  expiresAt: number;
  kind: OpenInput["kind"];
  toolName: string;
  originalInput: unknown;
  cancelTimer: () => void;
};

export function canonicalInputHash(toolName: string, input: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ toolName, input: sortKeysDeep(input) }))
    .digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export class ApprovalRouter {
  readonly #db: Database;
  readonly #append: (type: string, payload: unknown) => void;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #live = new Map<string, LiveCallback>();

  constructor(options: ApprovalRouterOptions) {
    this.#db = options.db;
    this.#append = options.append;
    this.#now = options.now ?? Date.now;
    this.#schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
  }

  /**
   * Park the SDK callback: persist the pending row, announce the request, and
   * schedule the expiry. The returned promise is what `canUseTool` awaits.
   */
  open(input: OpenInput): Promise<ApprovalOutcome> {
    const now = this.#now();
    const approvalId = `apr_${crypto.randomUUID()}`;
    const toolCallId = `tc_${crypto.randomUUID()}`;
    const inputHash = canonicalInputHash(input.toolName, input.input);
    const expiresAt = now + input.timeoutMs;

    const inserted = insertPendingApproval(this.#db, {
      approvalId,
      attemptId: input.attemptId,
      toolCallId,
      inputHash,
      callbackGeneration: 0,
      kind: input.kind,
      expiresAt,
      now,
    });
    if (!inserted.ok) {
      // Freshly minted ids cannot collide; reaching this is a programmer error.
      throw new Error(`approval id ${approvalId} already exists`);
    }

    const payload: Record<string, unknown> = {
      approvalId,
      runId: input.runId,
      attemptId: input.attemptId,
      toolCallId,
      inputHash,
      callbackGeneration: 0,
      kind: input.kind,
      toolName: input.toolName,
      expiresAt,
    };
    if (input.kind === "user_question") {
      payload.questions = sanitizeQuestions(input.input);
    } else {
      payload.inputSummary = summarizeToolInput(input.input);
    }
    this.#append("approval.requested", payload);

    return new Promise<ApprovalOutcome>((resolve) => {
      const cancelTimer = this.#schedule(() => this.sweepExpired(), input.timeoutMs);
      this.#live.set(approvalId, {
        resolve,
        attemptId: input.attemptId,
        expiresAt,
        kind: input.kind,
        toolName: input.toolName,
        originalInput: input.input,
        cancelTimer,
      });
    });
  }

  /**
   * Apply a user decision to exactly one parked callback. Validation runs
   * before anything mutates: identity, attempt, expiry, hash — and the row's
   * CAS is the final once-guard shared with the sweep and abandon paths.
   */
  respond(
    payload: RespondPayload,
    context: { attemptId: string; runId: string },
    now?: number,
  ):
    | { ok: true }
    | {
        ok: false;
        reason: "unknown" | "attempt_mismatch" | "hash_mismatch" | "expired" | "already_finished";
      } {
    void context.runId;
    const nowMs = now ?? this.#now();
    const row = pendingApproval(this.#db, payload.approvalId);
    if (row === undefined) return { ok: false, reason: "unknown" };
    if (row.attemptId !== context.attemptId) return { ok: false, reason: "attempt_mismatch" };
    if (row.state === "expired") return { ok: false, reason: "expired" };
    if (row.state !== "pending") return { ok: false, reason: "already_finished" };
    if (nowMs > row.expiresAt) return { ok: false, reason: "expired" };
    if (payload.inputHash !== row.inputHash) return { ok: false, reason: "hash_mismatch" };

    // Strict parse: only the exact string "allow" is an allow. Anything else —
    // "true", a missing field, an object — takes the deny path.
    const allow = payload.decision === "allow";
    if (
      !finishApproval(this.#db, { approvalId: payload.approvalId, state: "resolved", now: nowMs })
    ) {
      return { ok: false, reason: "already_finished" };
    }

    const entry = this.#live.get(payload.approvalId);
    if (entry !== undefined) {
      this.#live.delete(payload.approvalId);
      entry.cancelTimer();
      entry.resolve(this.#outcomeFor(entry, allow, payload.answers));
    }
    this.#append("approval.resolved", {
      approvalId: payload.approvalId,
      decision: allow ? "allow" : "deny",
      source: "user",
    });
    return { ok: true };
  }

  /** Deny every callback past its window and emit the timeout terminal. */
  sweepExpired(now?: number): void {
    const nowMs = now ?? this.#now();

    const stale = this.#db
      .prepare(
        "SELECT approval_id FROM pending_approvals WHERE state = 'pending' AND expires_at <= ?",
      )
      .all(nowMs) as Array<{ approval_id: string }>;
    for (const row of stale) {
      const entry = this.#live.get(row.approval_id);
      if (entry !== undefined) {
        this.#live.delete(row.approval_id);
        entry.cancelTimer();
        entry.resolve({ behavior: "deny", message: "approval timed out" });
      }
      finishApproval(this.#db, { approvalId: row.approval_id, state: "expired", now: nowMs });
      this.#append("approval.expired", { approvalId: row.approval_id, reason: "timeout" });
    }

    // Rows someone else already finished (a racing CAS) still hold parked
    // callbacks; deny them so nothing hangs. Their terminal event belongs to
    // whoever finished the row.
    for (const [approvalId, entry] of this.#live) {
      if (entry.expiresAt > nowMs) continue;
      this.#live.delete(approvalId);
      entry.cancelTimer();
      entry.resolve({ behavior: "deny", message: "approval timed out" });
    }
  }

  /**
   * Tear every pending approval of an attempt down with it — a cancel, an
   * abort, or a drain never approves anything implicitly.
   */
  abandonAttempt(
    attemptId: string,
    reason: "cancelled" | "aborted" | "abandoned" | "crashed",
  ): void {
    const message = reason === "cancelled" ? "run cancelled" : "run interrupted";
    const rows = this.#db
      .prepare(
        "SELECT approval_id FROM pending_approvals WHERE attempt_id = ? AND state = 'pending'",
      )
      .all(attemptId) as Array<{ approval_id: string }>;

    for (const row of rows) {
      const entry = this.#live.get(row.approval_id);
      if (entry !== undefined) {
        this.#live.delete(row.approval_id);
        entry.cancelTimer();
        entry.resolve({ behavior: "deny", message });
      }
      finishApproval(this.#db, { approvalId: row.approval_id, state: "expired" });
      this.#append("approval.expired", { approvalId: row.approval_id, reason });
    }
  }

  #outcomeFor(entry: LiveCallback, allow: boolean, answers: unknown): ApprovalOutcome {
    if (!allow) {
      return {
        behavior: "deny",
        message:
          entry.kind === "user_question"
            ? "User did not answer the question"
            : `User denied permission for ${entry.toolName}`,
      };
    }
    if (entry.kind === "user_question") {
      return {
        behavior: "allow",
        updatedInput: {
          questions: (entry.originalInput as { questions?: unknown } | null)?.questions,
          answers: answers ?? null,
        },
      };
    }
    return { behavior: "allow", updatedInput: entry.originalInput };
  }
}

/**
 * The journal's view of an `AskUserQuestion` input: every string inside is
 * masked and capped at 500 chars, so one long option description cannot bloat
 * the event payload while the question stays readable.
 */
function sanitizeQuestions(input: unknown): unknown[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map(sanitizeValue);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactErrorText(value).slice(0, 500);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeValue(entry);
  }
  return out;
}
