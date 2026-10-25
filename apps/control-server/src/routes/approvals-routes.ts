import { approvalForSession, fingerprintOf, recordApprovalDecision } from "@cc-web/control-db";
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

  // Read before the transaction so the fingerprint is computed from the same
  // values the command will carry. The authoritative once-guard is still the
  // CAS inside `recordApprovalDecision` — this read only feeds the hash, and a
  // row that changed underneath simply answers `not_pending` after it.
  const row = approvalForSession(options.db, approvalId);
  if (row === undefined) {
    return new Response("not found", { status: 404 });
  }

  // A crash-orphaned row can outlive its window without a terminal event (the
  // runner sweeps silently), so the projection can still say "pending" long
  // after the gate is gone. Recording a decision then would write an audit
  // trail the runner never honored — refuse, and let the sweep close the row.
  // The grace covers clock skew and a decision already in flight at expiry;
  // the runner's own expiry check stays the boundary authority.
  const EXPIRY_GRACE_MS = 15_000;
  if (typeof row.expiresAt === "number" && row.expiresAt + EXPIRY_GRACE_MS < Date.now()) {
    return new Response("expired", { status: 409 });
  }

  const commandId = crypto.randomUUID();
  const answersJson = decision.answers === undefined ? undefined : JSON.stringify(decision.answers);
  const fingerprint = await fingerprintOf({
    commandId,
    runnerId: row.runnerId,
    kind: "approval.respond",
    payload: {
      approvalId,
      decision: decision.decision,
      answers: decision.answers ?? null,
      inputHash: row.inputHash,
    },
    issuedAt: new Date().toISOString(),
  });

  const result = recordApprovalDecision(options.db, {
    approvalId,
    decision: decision.decision,
    ...(answersJson === undefined ? {} : { answersJson }),
    outbox: { commandId, fingerprint },
  });

  if (!result.ok) {
    const status = result.reason === "unknown" ? 404 : 409;
    return new Response(result.reason, { status });
  }

  // The command is durable; delivery is best-effort here. A runner that is
  // between sockets picks the command up on its next drain (§12.2).
  dispatcher?.drain(result.runnerId);

  return new Response(JSON.stringify({ approvalId, state: "decided" }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
