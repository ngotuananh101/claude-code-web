/**
 * `/ws/runner` route (§6.2, §17).
 *
 * Thin adapter between `Bun.serve` and `RunnerGateway`. Kept separate so the
 * gateway's rules are testable without a server, and so this file holds only the
 * things that are genuinely about Bun: the upgrade, the socket data and the
 * close codes.
 *
 * Authentication happens **before** the upgrade. A rejected credential returns
 * HTTP 401 and no socket is established — a client cannot connect, learn it is
 * unauthorized, and keep the connection half-open in a retry loop.
 */

import type { Server, ServerWebSocket } from "bun";
import type { RunnerGateway, RunnerSocketData } from "./runner-gateway.ts";

export const RUNNER_WS_PATH = "/ws/runner";

/** Fails closed: a message arriving before `attach()` has never been authorized. */
export function runnerSocketData(): RunnerSocketData {
  return {
    connectionId: "",
    generation: 0,
    runnerId: "",
    authenticated: false,
  };
}

function headersOf(request: Request): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

export type UpgradeResult = { ok: true } | { ok: false; status: 400 | 401 };

/**
 * Authorize and upgrade. On failure the caller answers with the returned status;
 * the reason is not echoed to the client beyond the status code, so a caller
 * cannot probe which part of a credential was wrong.
 */
export function upgradeRunner(
  request: Request,
  server: Server<RunnerSocketData>,
  gateway: RunnerGateway,
): UpgradeResult {
  const authorized = gateway.authorize(headersOf(request));

  if (!authorized.ok) {
    return { ok: false, status: 401 };
  }

  const upgraded = server.upgrade(request, { data: authorized.grant });
  if (!upgraded) {
    // Typically means the request was not a websocket handshake.
    return { ok: false, status: 400 };
  }

  // `attach()` happens in `open`, not here: `server.upgrade` only reserves the
  // data object, and the socket is not usable until it opens.
  return { ok: true };
}

export function runnerWebSocket(gateway: RunnerGateway) {
  return {
    open(socket: ServerWebSocket<RunnerSocketData>) {
      // The grant was produced by `upgradeRunner`, which already opened the
      // generation. Re-authorizing here would bump it a second time.
      if (socket.data.authenticated) {
        gateway.attach(socket, socket.data);
      }
    },

    message(socket: ServerWebSocket<RunnerSocketData>, message: string | Uint8Array) {
      gateway.handleMessage(socket, message);
    },

    close(socket: ServerWebSocket<RunnerSocketData>) {
      gateway.handleClose(socket);
    },
  };
}
