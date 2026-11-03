import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate, verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import {
  createLinkCode,
  getTelegramSettings,
  type TelegramSender,
} from "../notifications/telegram.ts";
import { createServer, type ServerHandle } from "../server.ts";

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

class FakeSender implements TelegramSender {
  sent: Array<{ chatId: string; text: string }> = [];
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    this.sent.push({ chatId, text });
    return true;
  }
  async answerCallbackQuery(_id: string, _text: string): Promise<boolean> {
    return true;
  }
  async editMessageText(_chatId: string, _messageId: number, _text: string): Promise<boolean> {
    return true;
  }
  async getUpdates(_offset: number) {
    return [];
  }
}

async function start(sender: TelegramSender | undefined) {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());
  db.query("INSERT INTO runners (id, owner_id, created_at) VALUES ('runner-1', 'user-1', ?)").run(
    Date.now(),
  );
  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) => verifyRunnerCredential(db, credential),
    ...(sender === undefined ? {} : { telegram: { sender, origin } }),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function call(url: string, cookie: string, path: string, method = "GET", body?: unknown) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("telegram notification routes", () => {
  test("unconfigured server reports configured=false and link answers 503", async () => {
    const { url, cookie } = await start(undefined);
    const status = await call(url, cookie, "/api/notifications/telegram");
    expect(status.status).toBe(200);
    const body = (await status.json()) as { configured: boolean; linked: boolean };
    expect(body.configured).toBe(false);
    expect(body.linked).toBe(false);
    const link = await call(url, cookie, "/api/notifications/telegram/link", "POST");
    expect(link.status).toBe(503);
  });

  test("link, redeem via polling helper, test, disable, unlink flow", async () => {
    const sender = new FakeSender();
    const { db, url, cookie } = await start(sender);
    const linkRes = await call(url, cookie, "/api/notifications/telegram/link", "POST");
    expect(linkRes.status).toBe(200);
    const { code } = (await linkRes.json()) as { code: string; expiresAt: number };
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(0);

    // Simulate the operator sending /start <code> to the bot: redeeming
    // directly is the same state transition the polling loop performs.
    const { redeemLinkCode } = await import("../notifications/telegram.ts");
    expect(redeemLinkCode(db, code, "777")).toBe(true);
    expect(getTelegramSettings(db).linked).toBe(true);

    const status = await call(url, cookie, "/api/notifications/telegram");
    const statusBody = (await status.json()) as {
      configured: boolean;
      linked: boolean;
      enabled: boolean;
    };
    expect(statusBody).toEqual({ configured: true, linked: true, enabled: true });

    const testRes = await call(url, cookie, "/api/notifications/telegram/test", "POST");
    expect(testRes.status).toBe(200);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0]!.chatId).toBe("777");

    const disable = await call(url, cookie, "/api/notifications/telegram/enabled", "POST", {
      enabled: false,
    });
    expect(disable.status).toBe(200);
    expect(getTelegramSettings(db).enabled).toBe(false);

    const unlink = await call(url, cookie, "/api/notifications/telegram/unlink", "POST");
    expect(unlink.status).toBe(200);
    expect(getTelegramSettings(db).linked).toBe(false);
    const testAfter = await call(url, cookie, "/api/notifications/telegram/test", "POST");
    expect(testAfter.status).toBe(400);
  });

  test("a foreign Origin is refused before the cookie is read", async () => {
    const { url, cookie } = await start(new FakeSender());
    const response = await fetch(`${url}/api/notifications/telegram`, {
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("createLinkCode is available to the polling loop", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { code } = createLinkCode(db);
    expect(code.length).toBeGreaterThan(0);
  });
});
