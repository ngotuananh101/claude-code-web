import type { Dispatcher } from "../dispatch/dispatcher.ts";
import {
  BotApiTelegramSender,
  createLinkCode,
  getTelegramSettings,
  pollTelegramOnce,
  setTelegramEnabled,
  type TelegramSender,
  unlinkTelegram,
} from "../notifications/telegram.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import { decideApproval } from "./approvals-routes.ts";

/**
 * Telegram notification settings (N1).
 *
 * Same authentication shape as every browser route: Origin allowlist
 * first, then the session cookie. Responses are `no-store` and never
 * contain the bot token, a link code's chat, or any other secret —
 * the link code itself is the only sensitive value returned, and it
 * is single-use with a 15-minute expiry.
 *
 * The Telegram client is injected through ServerOptions.telegram so
 * tests can pass a fake; production builds a real Bot API client
 * from CC_WEB_TELEGRAM_BOT_TOKEN in index.ts, and omits the option
 * entirely when no token is configured (then `configured` is false
 * and link/test answer 503 instead of pretending to work).
 */

export type TelegramConfig = {
  /** Real Bot API client, or a fake in tests. Undefined = not configured. */
  sender?: TelegramSender;
  /** Public origin for deep links, e.g. allowedOrigins[0]. */
  origin?: string;
};

async function authorize(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return { ok: false, status: 403 };
  }
  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) return { ok: false, status: 401 };
  return { ok: true };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleTelegramStatus(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const auth = await authorize(request, allowedOrigins, browserGateway);
  if (!auth.ok)
    return new Response(auth.status === 403 ? "forbidden" : "unauthorized", {
      status: auth.status,
    });
  const settings = getTelegramSettings(options.db);
  return json({
    configured: options.telegram?.sender !== undefined,
    linked: settings.linked,
    enabled: settings.enabled,
  });
}

export async function handleTelegramLink(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const auth = await authorize(request, allowedOrigins, browserGateway);
  if (!auth.ok)
    return new Response(auth.status === 403 ? "forbidden" : "unauthorized", {
      status: auth.status,
    });
  if (options.telegram?.sender === undefined) {
    return new Response("telegram not configured", { status: 503 });
  }
  const { code, expiresAt } = createLinkCode(options.db);
  return json({ code, expiresAt });
}

export async function handleTelegramUnlink(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const auth = await authorize(request, allowedOrigins, browserGateway);
  if (!auth.ok)
    return new Response(auth.status === 403 ? "forbidden" : "unauthorized", {
      status: auth.status,
    });
  unlinkTelegram(options.db);
  return json({ ok: true });
}

export async function handleTelegramEnabled(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const auth = await authorize(request, allowedOrigins, browserGateway);
  if (!auth.ok)
    return new Response(auth.status === 403 ? "forbidden" : "unauthorized", {
      status: auth.status,
    });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const enabled = (body as Record<string, unknown>)["enabled"];
  if (typeof enabled !== "boolean") return new Response("bad request", { status: 400 });
  setTelegramEnabled(options.db, enabled);
  return json({ ok: true, enabled });
}

export async function handleTelegramTest(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const auth = await authorize(request, allowedOrigins, browserGateway);
  if (!auth.ok)
    return new Response(auth.status === 403 ? "forbidden" : "unauthorized", {
      status: auth.status,
    });
  const sender = options.telegram?.sender;
  if (sender === undefined) return new Response("telegram not configured", { status: 503 });
  const settings = getTelegramSettings(options.db);
  if (!settings.linked || settings.chatId === null) {
    return new Response("telegram not linked", { status: 400 });
  }
  const ok = await sender.sendMessage(
    settings.chatId,
    "✅ Đây là tin nhắn thử từ cc-web. Thông báo Telegram đã hoạt động.",
  );
  if (!ok) return new Response("telegram send failed", { status: 502 });
  return json({ ok: true });
}

/** Build a real Bot API sender from a token, or undefined when unset. */
export function telegramSenderFromToken(token: string | undefined): TelegramSender | undefined {
  if (token === undefined || token === "") return undefined;
  return new BotApiTelegramSender(token);
}

/** One polling tick, used by the server's interval loop. */
export async function handleTelegramPoll(
  options: ServerOptions,
  dispatcher?: Dispatcher,
): Promise<void> {
  const sender = options.telegram?.sender;
  if (sender === undefined) return;
  await pollTelegramOnce(options.db, sender, async (approvalId, decision, answers) => {
    const outcome = await decideApproval(options.db, dispatcher, approvalId, decision, answers);
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  });
}
