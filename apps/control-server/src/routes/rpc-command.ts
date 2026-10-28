/**
 * The shared RPC spine that both the inspection surface and the mutation
 * surface ride (§23, §7.10).
 *
 * `submitRpc` is the verbatim block that lived at the tail of `handleInspect`:
 * everything from the readiness check through the 200 response. Pulling it out
 * lets the four mutation handlers reuse it without duplicating the
 * enqueue/drain/waiter/refusal/success sequence — which is exactly where a
 * second copy would drift from the read path and break Ruling 2.
 */

import type { CommandKind, RpcResultFrame } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import { jsonError, statusForCode } from "./api-error.ts";

export interface SubmitRpcOptions {
  runnerId: string;
  workspaceId: string;
  kind: CommandKind;
  payload: unknown;
  capability: string;
}

/**
 * Forward a single command to a ready runner and answer the HTTP caller from its
 * `rpc.result`.
 *
 * The caller has already done the out-of-band work: origin allowlist, cookie
 * auth, `parseCompositeId`, ownership. What remains is the readiness check, the
 * capability gate, the outbox enqueue with a 15 s expiry, the drain, the 10 s
 * waiter, and the three terminal responses (refusal, timeout, success).
 *
 * `capability` is checked against what the runner advertised; the failure
 * message is literal so it reads in logs: "runner does not support <capability>".
 * This is the only place that distinction lives — handlers pass
 * `INSPECT_CAPABILITY` or `WRITE_CAPABILITY` and nothing else decides.
 */
export async function submitRpc(
  options: ServerOptions,
  runnerGateway: {
    stateOf(runnerId: string): string;
    capabilitiesOf(runnerId: string): readonly string[];
  },
  pending: PendingRpcRequests,
  dispatcher: Dispatcher | undefined,
  input: SubmitRpcOptions,
): Promise<Response> {
  const { runnerId, workspaceId, kind, payload, capability } = input;

  if (runnerGateway.stateOf(runnerId) !== "ready") {
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
  }
  if (!runnerGateway.capabilitiesOf(runnerId).includes(capability)) {
    return jsonError("RUNNER_UNAVAILABLE", `runner does not support ${capability}`, 503);
  }

  const outbox = options.outbox;
  if (outbox === undefined || dispatcher === undefined) {
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
  }

  const commandId = crypto.randomUUID();
  const now = new Date();
  const waiter = pending.register(commandId);

  try {
    await outbox.enqueue({
      commandId,
      runnerId,
      kind,
      payload,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15_000).toISOString(),
      workspaceId,
    });
  } catch {
    pending.reject(commandId, "RUNNER_UNAVAILABLE");
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
  }

  dispatcher.drain(runnerId);

  let frame: RpcResultFrame;
  try {
    frame = await waiter;
  } catch {
    // Ruling 16: the waiter and the row retire on the same 10 s clock, with no
    // dependency on a future drain.
    try {
      outbox.markRejected(commandId, "expired");
    } catch {
      // The row is already terminal; the 503 below is still the answer.
    }
    return jsonError("RUNNER_UNAVAILABLE", "runner did not answer in time", 503);
  }

  if (!frame.ok) {
    const code = frame.error?.code ?? "UNKNOWN";
    const message = frame.error?.message ?? "inspection failed";
    // The runner's answer is also its proof the command was delivered, so the
    // row retires here either way (Ruling 2). A refusal records its code.
    try {
      outbox.markRejected(commandId, code);
    } catch {
      // Already terminal (the timeout path won the race); nothing to record.
    }
    const status = statusForCode(code);
    return jsonError(code, message, status);
  }

  try {
    outbox.markAnswered(commandId);
  } catch {
    // Already terminal; the caller still gets its answer.
  }

  return new Response(JSON.stringify(frame.result), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
