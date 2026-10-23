/**
 * A `Link` over Bun's WebSocket client (§6.2).
 *
 * The only file that knows a socket is involved. Everything above it — the
 * reconnect loop, reconciliation, the inventory — works against `Link`, which is
 * why the backoff and state machine can be tested without a network.
 *
 * The credential travels in the `Authorization` header, matching the server's
 * rule that it never appears in the URL (§6.2) and therefore never in access
 * logs.
 */

import type { Link } from "./reconnect-loop.ts";

export type DialOptions = {
  url: string;
  credential: string;
  /** How long to wait for the socket to open before treating it as a failure. */
  openTimeoutMs?: number;
};

export async function dialWebSocket(options: DialOptions): Promise<Link> {
  const socket = new WebSocket(options.url, {
    headers: { Authorization: `Bearer ${options.credential}` },
  } as never);

  const messageHandlers: Array<(raw: string) => void> = [];
  const closeHandlers: Array<(code: number) => void> = [];

  socket.addEventListener("message", (event) => {
    const raw = String((event as MessageEvent).data);
    for (const handler of messageHandlers) handler(raw);
  });

  socket.addEventListener("close", (event) => {
    const code = (event as CloseEvent).code;
    for (const handler of closeHandlers) handler(code);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket open timed out")),
      options.openTimeoutMs ?? 10_000,
    );

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      // The close event carries the code; this rejection only means "the dial
      // did not complete", which the loop treats as a retryable failure.
      reject(new Error("websocket failed to open"));
    });
  });

  return {
    send(payload) {
      socket.send(payload);
    },
    close() {
      socket.close();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}
