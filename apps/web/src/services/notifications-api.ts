import { authFetch } from "./auth-api.ts";

/**
 * Telegram notification settings client (N1).
 *
 * Thin wrappers over the server routes in
 * apps/control-server/src/routes/notifications-routes.ts. None of them
 * throws: a transport or parse failure becomes null/false, so a caller
 * never needs a try/catch around a settings read.
 */

export type TelegramStatus = {
  configured: boolean;
  linked: boolean;
  enabled: boolean;
};

export async function getTelegramStatus(): Promise<TelegramStatus | null> {
  try {
    const response = await authFetch("/api/notifications/telegram");
    if (!response.ok) return null;
    const body = (await response.json()) as TelegramStatus;
    if (
      typeof body.configured !== "boolean" ||
      typeof body.linked !== "boolean" ||
      typeof body.enabled !== "boolean"
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

export async function createTelegramLink(): Promise<{ code: string; expiresAt: number } | null> {
  try {
    const response = await authFetch("/api/notifications/telegram/link", { method: "POST" });
    if (!response.ok) return null;
    const body = (await response.json()) as { code: string; expiresAt: number };
    if (typeof body.code !== "string" || typeof body.expiresAt !== "number") return null;
    return body;
  } catch {
    return null;
  }
}

export async function unlinkTelegram(): Promise<boolean> {
  try {
    const response = await authFetch("/api/notifications/telegram/unlink", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function setTelegramEnabled(enabled: boolean): Promise<boolean> {
  try {
    const response = await authFetch("/api/notifications/telegram/enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTelegramTest(): Promise<boolean> {
  try {
    const response = await authFetch("/api/notifications/telegram/test", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}
