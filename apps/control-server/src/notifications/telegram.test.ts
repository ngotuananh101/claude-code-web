import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import {
  claimActionToken,
  createActionTokens,
  createLinkCode,
  dispatchTelegramNotification,
  formatNotificationMessage,
  getTelegramSettings,
  pollTelegramOnce,
  processTelegramUpdates,
  redeemLinkCode,
  setTelegramEnabled,
  type TelegramSender,
  type TelegramUpdate,
  unlinkTelegram,
} from "./telegram.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

class FakeSender implements TelegramSender {
  sent: Array<{
    chatId: string;
    text: string;
    replyMarkup?: unknown;
  }> = [];
  answers: Array<{ id: string; text: string }> = [];
  edits: Array<{ chatId: string; messageId: number; text: string }> = [];
  updates: TelegramUpdate[] = [];
  failSend = false;
  async sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<boolean> {
    if (this.failSend) return false;
    this.sent.push({ chatId, text, replyMarkup });
    return true;
  }
  async answerCallbackQuery(id: string, text: string): Promise<boolean> {
    this.answers.push({ id, text });
    return true;
  }
  async editMessageText(chatId: string, messageId: number, text: string): Promise<boolean> {
    this.edits.push({ chatId, messageId, text });
    return true;
  }
  async getUpdates(_offset: number): Promise<TelegramUpdate[]> {
    return this.updates;
  }
}

function actionTokenCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM telegram_action_tokens").get() as { n: number };
  return row.n;
}

function link(db: Database, chatId = "12345"): void {
  const { code } = createLinkCode(db);
  expect(redeemLinkCode(db, code, chatId)).toBe(true);
}

describe("formatNotificationMessage", () => {
  test("approval.requested carries tool and a capped summary, never the full payload", () => {
    const message = formatNotificationMessage(
      {
        eventId: "evt-1",
        type: "approval.requested",
        sessionId: "session-1",
        sessionTitle: "My session",
        toolName: "Bash",
        inputSummary: "x".repeat(2000),
      },
      "https://cc.example.test",
    );
    expect(message).not.toBeNull();
    expect(message!).toContain("Cần phê duyệt");
    expect(message!).toContain("Bash");
    expect(message!).toContain("https://cc.example.test/sessions/session-1");
    expect(message!.length).toBeLessThan(1000);
  });

  test("non-notifiable events format to null", () => {
    expect(
      formatNotificationMessage(
        { eventId: "evt-2", type: "message.completed", sessionId: "session-1" },
        undefined,
      ),
    ).toBeNull();
  });

  test("run terminal events each get their own wording", () => {
    for (const [type, word] of [
      ["run.finished", "hoàn thành"],
      ["run.failed", "thất bại"],
      ["run.interrupted", "gián đoạn"],
    ] as const) {
      const message = formatNotificationMessage(
        { eventId: `evt-${type}`, type, sessionId: "session-1" },
        undefined,
      );
      expect(message).toContain(word);
    }
  });
});

describe("dispatchTelegramNotification", () => {
  test("sends once per event id, then skips the redelivery", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db);
    const input = {
      eventId: "evt-1",
      type: "approval.requested",
      sessionId: "session-1",
      toolName: "Bash",
    };
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("sent");
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("skipped");
    expect(sender.sent.length).toBe(1);
  });

  test("skips when not linked or when disabled", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const input = { eventId: "evt-1", type: "approval.requested", sessionId: "session-1" };
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("skipped");
    link(db);
    setTelegramEnabled(db, false);
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("skipped");
    expect(sender.sent.length).toBe(0);
  });

  test("a failed send is not marked delivered, so a redelivery can retry", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    sender.failSend = true;
    link(db);
    const input = { eventId: "evt-1", type: "approval.requested", sessionId: "session-1" };
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("failed");
    sender.failSend = false;
    expect(await dispatchTelegramNotification(db, sender, input, undefined)).toBe("sent");
    expect(sender.sent.length).toBe(1);
  });

  test("disabling keeps the link, unlinking drops it", () => {
    const db = freshDb();
    link(db, "999");
    setTelegramEnabled(db, false);
    expect(getTelegramSettings(db)).toEqual({ linked: true, enabled: false, chatId: "999" });
    setTelegramEnabled(db, true);
    expect(getTelegramSettings(db).linked).toBe(true);
    unlinkTelegram(db);
    expect(getTelegramSettings(db).linked).toBe(false);
  });
});

describe("link codes", () => {
  test("a code works once, then fails", () => {
    const db = freshDb();
    const { code } = createLinkCode(db);
    expect(redeemLinkCode(db, code, "111")).toBe(true);
    expect(redeemLinkCode(db, code, "222")).toBe(false);
    expect(getTelegramSettings(db).chatId).toBe("111");
  });

  test("an expired code fails and an unknown code fails", () => {
    const db = freshDb();
    const { code } = createLinkCode(db, 1000);
    expect(redeemLinkCode(db, code, "111", 1000 + 15 * 60 * 1000 + 1)).toBe(false);
    expect(redeemLinkCode(db, "nope", "111")).toBe(false);
  });
});

describe("polling", () => {
  test("/start with a valid code links the chat and confirms; other messages are ignored", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { code } = createLinkCode(db);
    const last = await processTelegramUpdates(db, sender, [
      { update_id: 10, message: { chat: { id: 777 }, text: "hello" } },
      { update_id: 11, message: { chat: { id: 777 }, text: `/start ${code}` } },
      { update_id: 12, message: { chat: { id: 888 }, text: "/start wrongcode" } },
    ]);
    expect(last).toBe(12);
    expect(getTelegramSettings(db)).toEqual({ linked: true, enabled: true, chatId: "777" });
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0]!.text).toContain("Đã liên kết");
  });

  test("pollTelegramOnce advances the stored offset past processed updates", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { code } = createLinkCode(db);
    sender.updates = [{ update_id: 5, message: { chat: { id: 42 }, text: `/start ${code}` } }];
    await pollTelegramOnce(db, sender);
    expect(getTelegramSettings(db).chatId).toBe("42");
    sender.updates = [];
    await pollTelegramOnce(db, sender);
    // Second tick with no updates must not re-link or re-confirm.
    expect(sender.sent.length).toBe(1);
  });
});

describe("telegram approval actions", () => {
  test("tool_permission messages carry Duyệt/Từ chối buttons; user_question does not", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db);
    const tool = await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-tool",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-1",
        approvalKind: "tool_permission",
        approvalExpiresAt: Date.now() + 60_000,
      },
      undefined,
    );
    expect(tool).toBe("sent");
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard[0]!.map((b) => b.text)).toEqual(["✅ Duyệt", "❌ Từ chối"]);
    expect(markup.inline_keyboard[0]!.every((b) => b.callback_data.startsWith("act:"))).toBe(true);
    expect(actionTokenCount(db)).toBe(2);

    const question = await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-2",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
      },
      undefined,
    );
    expect(question).toBe("sent");
    expect(sender.sent[1]!.replyMarkup).toBeUndefined();
    expect(actionTokenCount(db)).toBe(2);
  });

  test("a valid callback decides once; a second press is refused without deciding again", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db, "12345");
    const { approveToken } = createActionTokens(db, "appr-1", "12345", Date.now() + 60_000);
    const calls: Array<[string, string]> = [];
    const decide = async (approvalId: string, decision: string) => {
      calls.push([approvalId, decision]);
      return { ok: true as const };
    };
    const callback = {
      update_id: 1,
      callback_query: {
        id: "cb-1",
        data: `act:${approveToken}`,
        message: { chat: { id: 12345 }, message_id: 9, text: "⏳ Cần phê duyệt" },
      },
    };
    await processTelegramUpdates(db, sender, [callback], Date.now(), decide);
    expect(calls).toEqual([["appr-1", "allow"]]);
    expect(sender.answers[0]!.text).toContain("Đã duyệt");
    expect(sender.edits[0]!.text).toContain("Đã duyệt");
    await processTelegramUpdates(db, sender, [callback], Date.now(), decide);
    expect(calls.length).toBe(1);
    expect(sender.answers[1]!.text).toContain("đã được quyết định");
  });

  test("a callback from another chat does not decide and does not consume the token", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { approveToken } = createActionTokens(db, "appr-1", "12345", Date.now() + 60_000);
    let calls = 0;
    const decide = async () => {
      calls += 1;
      return { ok: true as const };
    };
    const wrong = {
      update_id: 1,
      callback_query: {
        id: "cb-wrong",
        data: `act:${approveToken}`,
        message: { chat: { id: 999 }, message_id: 9, text: "⏳ Cần phê duyệt" },
      },
    };
    await processTelegramUpdates(db, sender, [wrong], Date.now(), decide);
    expect(calls).toBe(0);
    expect(sender.answers[0]!.text).toContain("không thuộc về chat");
    expect(claimActionToken(db, approveToken, "12345").ok).toBe(true);
  });

  test("an expired token does not decide", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { approveToken } = createActionTokens(db, "appr-1", "12345", Date.now() - 1000);
    let calls = 0;
    const decide = async () => {
      calls += 1;
      return { ok: true as const };
    };
    await processTelegramUpdates(
      db,
      sender,
      [
        {
          update_id: 1,
          callback_query: {
            id: "cb-exp",
            data: `act:${approveToken}`,
            message: { chat: { id: 12345 }, message_id: 9, text: "⏳ Cần phê duyệt" },
          },
        },
      ],
      Date.now(),
      decide,
    );
    expect(calls).toBe(0);
    expect(sender.answers[0]!.text).toContain("hết hạn");
  });

  test("a decision already made elsewhere answers so and removes the keyboard", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { rejectToken } = createActionTokens(db, "appr-1", "12345", Date.now() + 60_000);
    const decide = async () => ({ ok: false as const, reason: "not_pending" as const });
    await processTelegramUpdates(
      db,
      sender,
      [
        {
          update_id: 1,
          callback_query: {
            id: "cb-dup",
            data: `act:${rejectToken}`,
            message: { chat: { id: 12345 }, message_id: 9, text: "⏳ Cần phê duyệt" },
          },
        },
      ],
      Date.now(),
      decide,
    );
    expect(sender.answers[0]!.text).toContain("đã được quyết định");
    expect(sender.edits[0]!.text).toContain("không còn quyết định được nữa");
  });

  test("pollTelegramOnce passes callbacks to the decide handler", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    const { approveToken } = createActionTokens(db, "appr-1", "12345", Date.now() + 60_000);
    const calls: Array<[string, string]> = [];
    sender.updates = [
      {
        update_id: 3,
        callback_query: {
          id: "cb-poll",
          data: `act:${approveToken}`,
          message: { chat: { id: 12345 }, message_id: 9, text: "⏳ Cần phê duyệt" },
        },
      },
    ];
    await pollTelegramOnce(db, sender, async (approvalId, decision) => {
      calls.push([approvalId, decision]);
      return { ok: true as const };
    });
    expect(calls).toEqual([["appr-1", "allow"]]);
  });
});
