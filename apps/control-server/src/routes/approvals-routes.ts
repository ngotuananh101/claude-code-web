import type { Database } from "bun:sqlite";
import {
  approvalForSession,
  CommandOutbox,
  fingerprintOf,
  recordApprovalDecision,
} from "@cc-web/control-db";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The browser's approval surface over HTTP (§13.1, §17.1).
 *
 * The owner answers a card in the journal; the route records that decision and
 * the `approval.respond` command in one transaction, then drains the holding
 * runner. Auth mirrors `runs-routes.ts`: Origin allowlist, then the session
 * cookie. Ownership beyond the JWT is out of scope for the single-owner MVP
 * (§19.2) — there are no sessions to co-own yet.
 */

type DecisionBody = {
  decision: "allow" | "deny";
  answers?: Record<string, unknown>;
};

function parseBody(body: unknown): DecisionBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const decision = record["decision"];
  if (decision !== "allow" && decision !== "deny") return undefined;

  const answers = record["answers"];
  if (answers === undefined) return { decision };
  // The answers map travels to the runner verbatim, so only a plain object is
  // acceptable — an array or scalar would be a different shape than the card
  // submitted, and quietly coercing it would answer the wrong question.
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return undefined;
  return { decision, answers: answers as Record<string, unknown> };
}

export type ApprovalDecisionOutcome =
  | { ok: true; runnerId: string }
  | { ok: false; reason: "unknown" | "not_pending" | "expired" };

/**
 * The decision core shared by the web UI and Telegram callbacks.
 * Both callers get the same checks: unknown approval, already-closed
 * or expired approval, the 15s expiry grace, and the CAS inside
 * recordApprovalDecision that makes only the first decision win.
 * The command is durable before drain, exactly as the HTTP route did.
 */
export async function decideApproval(
  db: Database,
  dispatcher: Dispatcher | undefined,
  approvalId: string,
  decision: "allow" | "deny",
  answers?: Record<string, unknown>,
): Promise<ApprovalDecisionOutcome> {
  const row = approvalForSession(db, approvalId);
  if (row === undefined) {
    return { ok: false, reason: "unknown" };
  }
  if (row.state === "expired") {
    return { ok: false, reason: "expired" };
  }
  const EXPIRY_GRACE_MS = 15_000;
  if (
    row.state === "pending" &&
    typeof row.expiresAt === "number" &&
    row.expiresAt + EXPIRY_GRACE_MS < Date.now()
  ) {
    return { ok: false, reason: "expired" };
  }
  const commandId = crypto.randomUUID();
  const answersJson = answers === undefined ? undefined : JSON.stringify(answers);
  const fingerprint = await fingerprintOf({
    commandId,
    runnerId: row.runnerId,
    kind: "approval.respond",
    payload: {
      approvalId,
      decision,
      answers: answers ?? null,
      inputHash: row.inputHash,
    },
    issuedAt: new Date().toISOString(),
  });
  const result = recordApprovalDecision(db, {
    approvalId,
    decision,
    ...(answersJson === undefined ? {} : { answersJson }),
    outbox: new CommandOutbox(db),
    commandId,
    fingerprint,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  dispatcher?.drain(result.runnerId);
  return { ok: true, runnerId: result.runnerId };
}

export async function handleApprovalDecision(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  dispatcher: Dispatcher | undefined,
  approvalId: string,
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
  const decision = parseBody(body);
  if (decision === undefined) {
    return new Response("bad request", { status: 400 });
  }

  const outcome = await decideApproval(
    options.db,
    dispatcher,
    approvalId,
    decision.decision,
    decision.answers,
  );
  if (!outcome.ok) {
    const status = outcome.reason === "unknown" ? 404 : 409;
    return new Response(outcome.reason, { status });
  }
  return new Response(JSON.stringify({ approvalId, state: "decided" }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
