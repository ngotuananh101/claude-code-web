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

  test("formatNotificationMessage formats user_question with header, question and options cleanly", () => {
    const message = formatNotificationMessage(
      {
        eventId: "evt-q",
        type: "approval.requested",
        sessionId: "session-1",
        sessionTitle: "Deploy Flow",
        approvalKind: "user_question",
        questions: [
          {
            question: "Which deployment target should we use?",
            header: "Deploy target",
            options: [
              { label: "Staging", description: "Deploy to staging environment for testing" },
              {
                label: "Production",
                description: "Deploy directly to production (requires approval)",
              },
            ],
          },
        ],
      },
      "https://cc.example.test",
    );
    expect(message).not.toBeNull();
    expect(message!).toContain("Deploy target: Which deployment target should we use?");
    expect(message!).toContain("1. Staging — Deploy to staging environment for testing");
    expect(message!).toContain("2. Production — Deploy directly to production (requires approval)");
    expect(message!).not.toContain("[{");
    expect(message!).toContain("https://cc.example.test/sessions/session-1");
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
  test("tool_permission messages carry Duyệt/Từ chối buttons", async () => {
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
  });

  test("user_question messages carry buttons for each option", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db);
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
        questions: [
          {
            question: "Choose target?",
            options: [
              { label: "Option A", description: "First choice" },
              { label: "Option B", description: "Second choice" },
            ],
          },
        ],
      },
      undefined,
    );
    expect(question).toBe("sent");
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    // 2 options + 1 fallback Deny button = 3 rows
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0]![0]!.text).toBe("Option A");
    expect(markup.inline_keyboard[1]![0]!.text).toBe("Option B");
    expect(markup.inline_keyboard[2]![0]!.text).toBe("❌ Từ chối");
    expect(actionTokenCount(db)).toBe(3);
  });

  test("user_question that already has a deny/cancel option does not duplicate the Deny button", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db);
    const question = await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q-with-deny",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-3",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
        questions: [
          {
            question: "Proceed with git push?",
            options: [
              { label: "Duyệt (Phê duyệt) (Recommended)" },
              { label: "Tạo Pull Request" },
              { label: "Từ chối / Hủy" },
            ],
          },
        ],
      },
      undefined,
    );
    expect(question).toBe("sent");
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0]![0]!.text).toBe("Duyệt (Phê duyệt) (Recommended)");
    expect(markup.inline_keyboard[1]![0]!.text).toBe("Tạo Pull Request");
    expect(markup.inline_keyboard[2]![0]!.text).toBe("Từ chối / Hủy");
    expect(actionTokenCount(db)).toBe(3);
  });

  test("clicking a user_question option button submits answers to decide handler", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db, "12345");
    await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q-answer",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-question",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
        questions: [
          {
            question: "Confirm deployment?",
            options: [{ label: "Yes, deploy" }, { label: "Cancel" }],
          },
        ],
      },
      undefined,
    );
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const yesButton = markup.inline_keyboard[0]![0]!;
    expect(yesButton.text).toBe("Yes, deploy");

    const calls: Array<{ approvalId: string; decision: string; answers?: unknown }> = [];
    const decide = async (
      approvalId: string,
      decision: string,
      answers?: Record<string, unknown>,
    ) => {
      calls.push({ approvalId, decision, answers });
      return { ok: true as const };
    };

    const callback = {
      update_id: 1,
      callback_query: {
        id: "cb-q-1",
        data: yesButton.callback_data,
        message: { chat: { id: 12345 }, message_id: 10, text: "⏳ Cần phê duyệt" },
      },
    };
    await processTelegramUpdates(db, sender, [callback], Date.now(), decide);
    expect(calls).toEqual([
      {
        approvalId: "appr-question",
        decision: "allow",
        answers: { "Confirm deployment?": "Yes, deploy" },
      },
    ]);
    expect(sender.answers[0]!.text).toContain("Yes, deploy");
    expect(sender.edits[0]!.text).toContain("✅ Đã chọn: Yes, deploy");
  });

  test("clicking a deny-style option button marks edit message with ❌ icon", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db, "12345");
    await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q-deny-opt",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-deny-opt",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
        questions: [
          {
            question: "Push branch?",
            options: [{ label: "Duyệt" }, { label: "Từ chối / Hủy" }],
          },
        ],
      },
      undefined,
    );
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const cancelBtn = markup.inline_keyboard[1]![0]!;
    expect(cancelBtn.text).toBe("Từ chối / Hủy");

    const calls: Array<{ approvalId: string; decision: string; answers?: unknown }> = [];
    const decide = async (
      approvalId: string,
      decision: string,
      answers?: Record<string, unknown>,
    ) => {
      calls.push({ approvalId, decision, answers });
      return { ok: true as const };
    };

    const callback = {
      update_id: 1,
      callback_query: {
        id: "cb-q-cancel",
        data: cancelBtn.callback_data,
        message: { chat: { id: 12345 }, message_id: 11, text: "⏳ Cần phê duyệt" },
      },
    };
    await processTelegramUpdates(db, sender, [callback], Date.now(), decide);
    expect(calls).toEqual([
      {
        approvalId: "appr-deny-opt",
        decision: "allow",
        answers: { "Push branch?": "Từ chối / Hủy" },
      },
    ]);
    expect(sender.answers[0]!.text).toContain("Từ chối / Hủy");
    expect(sender.edits[0]!.text).toContain("❌ Đã chọn: Từ chối / Hủy");
  });

  test("user_question without options renders fallback deny button", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db, "12345");
    await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q-freeform",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-freeform",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
        questions: [{ question: "Please type your API key:" }],
      },
      undefined,
    );
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0]![0]!.text).toBe("❌ Từ chối");
  });

  test("user_question parsed from inputSummary string generates option buttons", async () => {
    const db = freshDb();
    const sender = new FakeSender();
    link(db, "12345");
    await dispatchTelegramNotification(
      db,
      sender,
      {
        eventId: "evt-q-serialized",
        type: "approval.requested",
        sessionId: "session-1",
        approvalId: "appr-serialized",
        approvalKind: "user_question",
        approvalExpiresAt: Date.now() + 60_000,
        inputSummary: JSON.stringify([
          {
            question: "Choose color:",
            options: [{ label: "Blue" }, { label: "Red" }],
          },
        ]),
      },
      undefined,
    );
    const markup = sender.sent[0]!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(3);
    expect(markup.inline_keyboard[0]![0]!.text).toBe("Blue");
    expect(markup.inline_keyboard[1]![0]!.text).toBe("Red");
    expect(markup.inline_keyboard[2]![0]!.text).toBe("❌ Từ chối");
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
