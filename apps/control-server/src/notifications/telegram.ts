import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/**
 * Telegram notifications (N1, complete notifications scope).
 *
 * The control server is the only place that can notify when the operator
 * is away: the browser tab may be closed, hidden, or on another session,
 * and the browser gateway only publishes to sockets subscribed to that
 * session. Telegram delivery therefore lives server-side, keyed off the
 * same stored events the journal already commits.
 *
 * Security shape (§19.4):
 * - The bot token is environment-only (CC_WEB_TELEGRAM_BOT_TOKEN),
 *   never stored in the database, never logged, never returned by an API.
 * - Only a bounded summary leaves the server: session title, tool name,
 *   a capped input summary. No credentials, no full payloads, no file
 *   contents. The runner already redacts/truncates inputSummary in
 *   approvals/ingest.ts; this module caps it a second time.
 * - One linked chat per single owner. Messages from any other chat are
 *   ignored, and a link code is single-use with a 15-minute expiry.
 * - Delivery is best-effort: a send failure never fails event ingestion
 *   or the approval projection. Dedupe is by event id, so a redelivered
 *   event cannot re-notify, but a failed send is not marked delivered,
 *   so a later redelivery can retry it.
 * - Telegram approval actions: inline Duyệt/Từ chối buttons are
 *   attached only to tool_permission approval messages. Each button
 *   carries a single-use random action token stored server-side (no
 *   approval id in callback data); the callback is verified against
 *   the linked chat, expires with the approval, and is executed
 *   through the same decision core as the web UI, so its CAS/state
 *   checks apply identically. user_question approvals keep the deep
 *   link only, because they need free-form answers a button cannot
 *   supply.
 */

export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.expired",
  "run.finished",
  "run.failed",
  "run.interrupted",
]);

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const SUMMARY_LIMIT = 500;
const TITLE_LIMIT = 100;
const TOOL_LIMIT = 100;

export type NotificationInput = {
  eventId: string;
  type: string;
  sessionId: string;
  sessionTitle?: string;
  toolName?: string;
  inputSummary?: string;
  questions?: unknown[];
  /** Present only for approval.requested, from the event payload. */
  approvalId?: string;
  approvalKind?: string;
  approvalExpiresAt?: number;
};

export type TelegramSettings = {
  linked: boolean;
  enabled: boolean;
  chatId: string | null;
};

export type TelegramQuestionOption = {
  label: string;
  description?: string | undefined;
};

export type TelegramQuestion = {
  question: string;
  header?: string | undefined;
  options?: TelegramQuestionOption[] | undefined;
};

export function parseTelegramQuestions(input: NotificationInput): TelegramQuestion[] {
  let source: unknown = input.questions;
  if (
    !Array.isArray(source) &&
    typeof input.inputSummary === "string" &&
    input.inputSummary.trim().startsWith("[")
  ) {
    try {
      source = JSON.parse(input.inputSummary);
    } catch {
      source = undefined;
    }
  }
  if (!Array.isArray(source)) return [];
  return source
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q) => ({
      question: typeof q["question"] === "string" ? q["question"] : "",
      header: typeof q["header"] === "string" ? q["header"] : undefined,
      options: Array.isArray(q["options"])
        ? q["options"]
            .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
            .map((o) => ({
              label: typeof o["label"] === "string" ? o["label"] : "",
              description: typeof o["description"] === "string" ? o["description"] : undefined,
            }))
            .filter((o) => o.label !== "")
        : undefined,
    }))
    .filter((q) => q.question !== "");
}

function cap(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, limit).trim();
}

function sessionLabel(input: NotificationInput): string {
  const title = cap(input.sessionTitle, TITLE_LIMIT);
  if (title !== "") return title;
  return input.sessionId.length > 12 ? `${input.sessionId.slice(0, 12)}…` : input.sessionId;
}

function linkLine(input: NotificationInput, origin: string | undefined): string {
  if (origin === undefined || origin === "") return "";
  return `\nMở: ${origin}/sessions/${input.sessionId}`;
}

/** Bounded, human-readable message for a notifiable event, or null. */
export function formatNotificationMessage(
  input: NotificationInput,
  origin: string | undefined,
): string | null {
  if (!NOTIFIABLE_EVENT_TYPES.has(input.type)) return null;
  const session = sessionLabel(input);
  const summary = cap(input.inputSummary, SUMMARY_LIMIT);
  const tool = cap(input.toolName, TOOL_LIMIT);
  switch (input.type) {
    case "approval.requested": {
      const questions = parseTelegramQuestions(input);
      let details = "";
      if (questions.length > 0) {
        for (const q of questions) {
          const header = q.header ? `${q.header}: ` : "";
          details += `\n\n${header}${q.question}`;
          if (q.options && q.options.length > 0) {
            for (let i = 0; i < q.options.length; i++) {
              const opt = q.options[i]!;
              const desc = opt.description ? ` — ${opt.description}` : "";
              details += `\n${i + 1}. ${opt.label}${desc}`;
            }
          }
        }
        details = details.slice(0, 1500).trimEnd();
      } else if (summary !== "") {
        details = `\n${summary}`;
      }
      return (
        `⏳ Cần phê duyệt\nPhiên: ${session}` +
        (tool !== "" ? `\nCông cụ: ${tool}` : "") +
        details +
        linkLine(input, origin)
      );
    }
    case "approval.expired":
      return `⌛ Phê duyệt đã hết hạn\nPhiên: ${session}${linkLine(input, origin)}`;
    case "run.finished":
      return `✅ Run đã hoàn thành\nPhiên: ${session}${linkLine(input, origin)}`;
    case "run.failed":
      return `❌ Run thất bại\nPhiên: ${session}${linkLine(input, origin)}`;
    case "run.interrupted":
      return `⏹ Run đã bị gián đoạn\nPhiên: ${session}${linkLine(input, origin)}`;
    default:
      return null;
  }
}

export function getTelegramSettings(db: Database): TelegramSettings {
  const row = db
    .query("SELECT chat_id, enabled FROM telegram_settings WHERE id = 'owner'")
    .get() as { chat_id: string | null; enabled: number } | null;
  if (row === null || row.chat_id === null) {
    return { linked: false, enabled: row?.enabled === 1, chatId: null };
  }
  return { linked: true, enabled: row.enabled === 1, chatId: row.chat_id };
}

export function setTelegramEnabled(db: Database, enabled: boolean): void {
  // The ON CONFLICT branch updates only enabled/updated_at, so an
  // existing linked chat_id is preserved; a new row starts unlinked.
  db.query(
    "INSERT INTO telegram_settings (id, chat_id, enabled, updated_at) VALUES ('owner', NULL, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
  ).run(enabled ? 1 : 0, Date.now());
}

export function unlinkTelegram(db: Database): void {
  db.query("UPDATE telegram_settings SET chat_id = NULL, updated_at = ? WHERE id = 'owner'").run(
    Date.now(),
  );
}

export function createLinkCode(
  db: Database,
  now: number = Date.now(),
): { code: string; expiresAt: number } {
  const code = randomBytes(9).toString("hex");
  const expiresAt = now + LINK_CODE_TTL_MS;
  db.query(
    "INSERT INTO telegram_link_codes (code, expires_at, used_at, created_at) VALUES (?, ?, NULL, ?)",
  ).run(code, expiresAt, now);
  return { code, expiresAt };
}

/** Returns true only when the code was valid, unexpired and unused. */
export function redeemLinkCode(
  db: Database,
  code: string,
  chatId: string,
  now: number = Date.now(),
): boolean {
  const row = db
    .query("SELECT code, expires_at, used_at FROM telegram_link_codes WHERE code = ?")
    .get(code) as { code: string; expires_at: number; used_at: number | null } | null;
  if (row === null || row.used_at !== null || row.expires_at <= now) return false;
  db.query("UPDATE telegram_link_codes SET used_at = ? WHERE code = ?").run(now, code);
  db.query(
    "INSERT INTO telegram_settings (id, chat_id, enabled, updated_at) VALUES ('owner', ?, 1, ?) " +
      "ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, enabled = 1, updated_at = excluded.updated_at",
  ).run(chatId, now);
  return true;
}

export type TelegramActionDecision = "allow" | "deny";

/** Decision core injected by the server, where the dispatcher lives. */
export type TelegramDecisionHandler = (
  approvalId: string,
  decision: TelegramActionDecision,
  answers?: Record<string, unknown>,
) => Promise<{ ok: true } | { ok: false; reason: "unknown" | "not_pending" | "expired" }>;

/** Create a custom action token with arbitrary decision, answers and label. */
export function createCustomActionToken(
  db: Database,
  approvalId: string,
  chatId: string,
  expiresAt: number,
  options: {
    decision: TelegramActionDecision;
    answers?: Record<string, unknown>;
    label?: string;
    now?: number;
  },
): string {
  const token = randomBytes(16).toString("hex");
  const answersJson = options.answers !== undefined ? JSON.stringify(options.answers) : null;
  const now = options.now ?? Date.now();
  db.query(
    "INSERT INTO telegram_action_tokens (token, approval_id, decision, chat_id, expires_at, answers, label, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
  ).run(
    token,
    approvalId,
    options.decision,
    chatId,
    expiresAt,
    answersJson,
    options.label ?? null,
    now,
  );
  return token;
}

/** Create the two action tokens for one tool_permission approval. */
export function createActionTokens(
  db: Database,
  approvalId: string,
  chatId: string,
  expiresAt: number,
  now: number = Date.now(),
): { approveToken: string; rejectToken: string } {
  const approveToken = createCustomActionToken(db, approvalId, chatId, expiresAt, {
    decision: "allow",
    label: "Duyệt",
    now,
  });
  const rejectToken = createCustomActionToken(db, approvalId, chatId, expiresAt, {
    decision: "deny",
    label: "Từ chối",
    now,
  });
  return { approveToken, rejectToken };
}

export type ActionTokenClaim =
  | {
      ok: true;
      approvalId: string;
      decision: TelegramActionDecision;
      expiresAt: number;
      answers?: Record<string, unknown> | undefined;
      label?: string | undefined;
    }
  | { ok: false; reason: "unknown" | "wrong_chat" | "expired" | "used" };

/**
 * Claim an action token exactly once. A wrong chat or an expired token
 * is refused without consuming it; a used token stays used. The claim
 * itself is atomic (UPDATE ... WHERE used_at IS NULL), so two presses
 * racing each other can only claim one of them.
 */
export function claimActionToken(
  db: Database,
  token: string,
  chatId: string,
  now: number = Date.now(),
): ActionTokenClaim {
  const row = db
    .query(
      "SELECT approval_id, decision, chat_id, expires_at, answers, label, used_at FROM telegram_action_tokens WHERE token = ?",
    )
    .get(token) as {
    approval_id: string;
    decision: string;
    chat_id: string;
    expires_at: number;
    answers: string | null;
    label: string | null;
    used_at: number | null;
  } | null;
  if (row === null) return { ok: false, reason: "unknown" };
  if (row.chat_id !== chatId) return { ok: false, reason: "wrong_chat" };
  if (row.used_at !== null) return { ok: false, reason: "used" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const claimed = db
    .query("UPDATE telegram_action_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL")
    .run(now, token);
  if (claimed.changes === 0) return { ok: false, reason: "used" };
  let parsedAnswers: Record<string, unknown> | undefined;
  if (row.answers !== null && row.answers !== "") {
    try {
      const parsed = JSON.parse(row.answers);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        parsedAnswers = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return {
    ok: true,
    approvalId: row.approval_id,
    decision: row.decision === "deny" ? "deny" : "allow",
    expiresAt: row.expires_at,
    ...(parsedAnswers === undefined ? {} : { answers: parsedAnswers }),
    ...(row.label !== null && row.label !== undefined ? { label: row.label } : {}),
  };
}

/** Remove tokens minted for an approval whose message never sent. */
export function deleteActionTokensForApproval(db: Database, approvalId: string): void {
  db.query("DELETE FROM telegram_action_tokens WHERE approval_id = ?").run(approvalId);
}

export function getPollOffset(db: Database): number {
  const row = db.query("SELECT value FROM telegram_poll_state WHERE key = 'offset'").get() as {
    value: string;
  } | null;
  const parsed = row === null ? Number.NaN : Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setPollOffset(db: Database, offset: number): void {
  db.query(
    "INSERT INTO telegram_poll_state (key, value) VALUES ('offset', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(offset));
}

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

/**
 * Build inline keyboard markup for a question step in single or multi-question approvals.
 */
export function createQuestionStepMarkup(
  db: Database,
  approvalId: string,
  chatId: string,
  expiresAt: number,
  questions: TelegramQuestion[],
  stepIndex: number,
  accumulatedAnswers: Record<string, string>,
): InlineKeyboardMarkup {
  const currentQuestion = questions[stepIndex]!;
  const options = currentQuestion.options ?? [];
  const rows: InlineKeyboardButton[][] = [];
  const isMultiQuestion = questions.length > 1;

  const hasDenyOption = options.some((opt) =>
    /^(từ chối|hủy|deny|cancel|reject)/i.test(opt.label.trim()),
  );

  for (const opt of options.slice(0, 8)) {
    const nextAnswers: Record<string, unknown> = isMultiQuestion
      ? {
          __multiStep: true,
          __step: stepIndex,
          __total: questions.length,
          __answers: { ...accumulatedAnswers, [currentQuestion.question]: opt.label },
          __questions: questions,
        }
      : { [currentQuestion.question]: opt.label };

    const token = createCustomActionToken(db, approvalId, chatId, expiresAt, {
      decision: "allow",
      answers: nextAnswers,
      label: opt.label,
    });

    const prefix = isMultiQuestion ? `[${stepIndex + 1}/${questions.length}] ` : "";
    const rawLabel = `${prefix}${opt.label}`;
    const text = rawLabel.length > 50 ? `${rawLabel.slice(0, 47)}…` : rawLabel;
    rows.push([{ text, callback_data: `act:${token}` }]);
  }

  if (isMultiQuestion && stepIndex > 0) {
    const prevStepIndex = stepIndex - 1;
    const prevQuestion = questions[prevStepIndex]!;
    const prevAccumulated = { ...accumulatedAnswers };
    delete prevAccumulated[prevQuestion.question];

    const backToken = createCustomActionToken(db, approvalId, chatId, expiresAt, {
      decision: "allow",
      answers: {
        __multiStep: true,
        __isBack: true,
        __step: prevStepIndex,
        __total: questions.length,
        __answers: prevAccumulated,
        __questions: questions,
      },
      label: "Quay lại",
    });
    rows.push([{ text: "⬅️ Chọn lại câu trước", callback_data: `act:${backToken}` }]);
  }

  if (!hasDenyOption) {
    const denyToken = createCustomActionToken(db, approvalId, chatId, expiresAt, {
      decision: "deny",
      label: "Từ chối",
    });
    rows.push([{ text: "❌ Từ chối", callback_data: `act:${denyToken}` }]);
  }

  return { inline_keyboard: rows };
}

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: {
    chat?: { id?: number | string };
    message_id?: number;
    text?: string;
  };
};

export type TelegramUpdate = {
  update_id: number;
  message?: { chat?: { id?: number | string }; text?: string };
  callback_query?: TelegramCallbackQuery;
};

export interface TelegramSender {
  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<boolean>;
  answerCallbackQuery(id: string, text: string): Promise<boolean>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<boolean>;
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
}

/** Minimal Bot API client. The token is held in memory only. */
export class BotApiTelegramSender implements TelegramSender {
  readonly #token: string;
  readonly #fetchFn: typeof fetch;

  constructor(token: string, fetchFn: typeof fetch = fetch) {
    this.#token = token;
    this.#fetchFn = fetchFn;
  }

  #url(method: string): string {
    return `https://api.telegram.org/bot${this.#token}/${method}`;
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<boolean> {
    try {
      const response = await this.#fetchFn(this.#url("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async answerCallbackQuery(id: string, text: string): Promise<boolean> {
    try {
      const response = await this.#fetchFn(this.#url("answerCallbackQuery"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: id, text }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Rewrite the message text and optionally update its keyboard (drops buttons when replyMarkup is omitted). */
  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<boolean> {
    try {
      const response = await this.#fetchFn(this.#url("editMessageText"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: replyMarkup ?? { inline_keyboard: [] },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    try {
      const url = new URL(this.#url("getUpdates"));
      url.searchParams.set("timeout", "0");
      if (offset > 0) url.searchParams.set("offset", String(offset));
      const response = await this.#fetchFn(url.toString());
      if (!response.ok) return [];
      const body = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      return body.ok === true && Array.isArray(body.result) ? body.result : [];
    } catch {
      return [];
    }
  }
}

/**
 * Send one Telegram notification for a stored event, at most once.
 * Returns "sent", "skipped" (not notifiable, not linked, disabled, or
 * already delivered) or "failed" (send error; not marked delivered).
 */
export async function dispatchTelegramNotification(
  db: Database,
  sender: TelegramSender | undefined,
  input: NotificationInput,
  origin: string | undefined,
): Promise<"sent" | "skipped" | "failed"> {
  const message = formatNotificationMessage(input, origin);
  if (message === null || sender === undefined) return "skipped";
  const settings = getTelegramSettings(db);
  if (!settings.linked || !settings.enabled || settings.chatId === null) return "skipped";
  // Claim delivery first (INSERT OR IGNORE): a concurrent redelivery for
  // the same event cannot double-send. On failure the claim is removed.
  const claimed = db
    .query(
      "INSERT OR IGNORE INTO notification_deliveries (event_id, channel, delivered_at) VALUES (?, 'telegram', ?)",
    )
    .run(input.eventId, Date.now());
  if (claimed.changes === 0) return "skipped";
  // Buttons for tool_permission approvals AND user_question approvals
  const withButtons =
    input.type === "approval.requested" &&
    input.approvalId !== undefined &&
    typeof input.approvalExpiresAt === "number" &&
    (input.approvalKind === "tool_permission" || input.approvalKind === "user_question");
  let replyMarkup: InlineKeyboardMarkup | undefined;
  if (withButtons) {
    if (input.approvalKind === "tool_permission") {
      const tokens = createActionTokens(
        db,
        input.approvalId as string,
        settings.chatId,
        input.approvalExpiresAt as number,
      );
      replyMarkup = {
        inline_keyboard: [
          [
            { text: "✅ Duyệt", callback_data: `act:${tokens.approveToken}` },
            { text: "❌ Từ chối", callback_data: `act:${tokens.rejectToken}` },
          ],
        ],
      };
    } else if (input.approvalKind === "user_question") {
      const questions = parseTelegramQuestions(input);
      const allHaveOptions =
        questions.length > 0 &&
        questions.every((q) => q.options !== undefined && q.options.length > 0);
      if (allHaveOptions) {
        replyMarkup = createQuestionStepMarkup(
          db,
          input.approvalId as string,
          settings.chatId,
          input.approvalExpiresAt as number,
          questions,
          0,
          {},
        );
      } else {
        const denyToken = createCustomActionToken(
          db,
          input.approvalId as string,
          settings.chatId,
          input.approvalExpiresAt as number,
          {
            decision: "deny",
            label: "Từ chối",
          },
        );
        replyMarkup = {
          inline_keyboard: [[{ text: "❌ Từ chối", callback_data: `act:${denyToken}` }]],
        };
      }
    }
  }
  const fail = () => {
    if (withButtons && input.approvalId !== undefined) {
      deleteActionTokensForApproval(db, input.approvalId);
    }
    db.query("DELETE FROM notification_deliveries WHERE event_id = ? AND channel = 'telegram'").run(
      input.eventId,
    );
    return "failed" as const;
  };
  try {
    const ok = await sender.sendMessage(settings.chatId, message, replyMarkup);
    if (!ok) return fail();
    return "sent";
  } catch {
    return fail();
  }
}

/**
 * Handle one inline-button press. The token is claimed before deciding,
 * so a second press of the same button (or a replayed callback) answers
 * "already decided" instead of deciding twice; the shared decision core
 * adds its own CAS on top. A wrong-chat press never consumes the token,
 * so the linked chat can still press it afterwards.
 */
async function handleCallbackQuery(
  db: Database,
  sender: TelegramSender,
  callback: TelegramCallbackQuery,
  decide: TelegramDecisionHandler | undefined,
  now: number,
): Promise<void> {
  const chatIdRaw = callback.message?.chat?.id;
  const data = callback.data;
  if (chatIdRaw === undefined || typeof data !== "string") return;
  const chatId = String(chatIdRaw);
  const match = data.match(/^act:([A-Za-z0-9]+)$/);
  if (match === null) {
    await sender.answerCallbackQuery(callback.id, "Không nhận dạng được nút này.");
    return;
  }
  if (decide === undefined) {
    await sender.answerCallbackQuery(callback.id, "Chức năng duyệt từ Telegram chưa sẵn sàng.");
    return;
  }
  const claim = claimActionToken(db, match[1] as string, chatId, now);
  if (!claim.ok) {
    const answer =
      claim.reason === "wrong_chat"
        ? "Tin nhắn này không thuộc về chat đã liên kết."
        : claim.reason === "expired"
          ? "Phê duyệt đã hết hạn."
          : claim.reason === "used"
            ? "Phê duyệt này đã được quyết định rồi."
            : "Không tìm thấy phê duyệt.";
    await sender.answerCallbackQuery(callback.id, answer);
    return;
  }
  const message = callback.message;
  const rawOriginal = message !== undefined && typeof message.text === "string" ? message.text : "";
  const original = rawOriginal.split("\n\n📍 Đang chọn ")[0]!;

  if (
    claim.decision === "allow" &&
    typeof claim.answers === "object" &&
    claim.answers !== null &&
    (claim.answers as Record<string, unknown>)["__multiStep"] === true
  ) {
    const payload = claim.answers as {
      __multiStep: true;
      __isBack?: boolean;
      __step: number;
      __total: number;
      __answers: Record<string, string>;
      __questions: TelegramQuestion[];
    };
    if (payload.__isBack === true) {
      const replyMarkup = createQuestionStepMarkup(
        db,
        claim.approvalId,
        chatId,
        claim.expiresAt,
        payload.__questions,
        payload.__step,
        payload.__answers,
      );
      await sender.answerCallbackQuery(callback.id, "Đang quay lại câu trước…");
      if (message !== undefined && typeof message.message_id === "number") {
        const nextQ = payload.__questions[payload.__step]!;
        const qHeader = nextQ.header ? `${nextQ.header}: ${nextQ.question}` : nextQ.question;
        let stepText = `${original}\n\n📍 Đang chọn (${payload.__step + 1}/${payload.__total}): ${qHeader}`;
        for (const [, val] of Object.entries(payload.__answers)) {
          stepText += `\n• ${val}`;
        }
        await sender.editMessageText(chatId, message.message_id, stepText, replyMarkup);
      }
      return;
    }

    const isLastQuestion = payload.__step === payload.__total - 1;
    if (!isLastQuestion) {
      const nextStep = payload.__step + 1;
      const nextQ = payload.__questions[nextStep]!;
      const replyMarkup = createQuestionStepMarkup(
        db,
        claim.approvalId,
        chatId,
        claim.expiresAt,
        payload.__questions,
        nextStep,
        payload.__answers,
      );
      await sender.answerCallbackQuery(
        callback.id,
        claim.label ? `Đã chọn: ${claim.label}` : "Đang chuyển câu tiếp theo…",
      );
      if (message !== undefined && typeof message.message_id === "number") {
        const qHeader = nextQ.header ? `${nextQ.header}: ${nextQ.question}` : nextQ.question;
        let stepText = `${original}\n\n📍 Đang chọn (${nextStep + 1}/${payload.__total}): ${qHeader}`;
        for (const [, val] of Object.entries(payload.__answers)) {
          stepText += `\n• ${val}`;
        }
        await sender.editMessageText(chatId, message.message_id, stepText, replyMarkup);
      }
      return;
    }

    // Last question: submit all answers to decide handler!
    const outcome = await decide(claim.approvalId, "allow", payload.__answers);
    const answer = outcome.ok
      ? "Đã chọn tất cả câu trả lời."
      : outcome.reason === "expired"
        ? "Phê duyệt đã hết hạn."
        : "Phê duyệt này đã được quyết định rồi.";
    await sender.answerCallbackQuery(callback.id, answer);

    if (message !== undefined && typeof message.message_id === "number") {
      let decisionText: string;
      if (outcome.ok) {
        decisionText = "✅ Đã chọn tất cả câu trả lời:";
        for (const [, val] of Object.entries(payload.__answers)) {
          decisionText += `\n• ${val}`;
        }
      } else {
        decisionText = "⌛ Phê duyệt này không còn quyết định được nữa";
      }
      await sender.editMessageText(chatId, message.message_id, `${original}\n\n${decisionText}`);
    }
    return;
  }

  const outcome = await decide(claim.approvalId, claim.decision, claim.answers);
  const label = claim.label ?? (claim.decision === "allow" ? "Duyệt" : "Từ chối");
  const isDeny =
    claim.decision === "deny" || /^(từ chối|hủy|deny|cancel|reject)/i.test(label.trim());
  const icon = isDeny ? "❌" : "✅";
  const answer = outcome.ok
    ? claim.label !== undefined && claim.label !== "Duyệt" && claim.label !== "Từ chối"
      ? `Đã chọn: ${claim.label}`
      : claim.decision === "allow"
        ? "Đã duyệt."
        : "Đã từ chối."
    : outcome.reason === "expired"
      ? "Phê duyệt đã hết hạn."
      : "Phê duyệt này đã được quyết định rồi.";
  await sender.answerCallbackQuery(callback.id, answer);
  if (message !== undefined && typeof message.message_id === "number") {
    const decisionText =
      claim.label !== undefined && claim.label !== "Duyệt" && claim.label !== "Từ chối"
        ? `${icon} Đã chọn: ${claim.label}`
        : claim.decision === "allow"
          ? "✅ Đã duyệt"
          : "❌ Đã từ chối";
    const suffix = outcome.ok
      ? `\n\n${decisionText}`
      : "\n\n⌛ Phê duyệt này không còn quyết định được nữa";
    await sender.editMessageText(chatId, message.message_id, original + suffix);
  }
}

/**
 * Process one batch of getUpdates results. Only `/start <code>` from any
 * chat can link that chat; every other message is ignored. Callback
 * queries are routed to the approval-action handler above. Returns the
 * highest update_id seen, or null when the batch was empty.
 */
export async function processTelegramUpdates(
  db: Database,
  sender: TelegramSender,
  updates: TelegramUpdate[],
  now: number = Date.now(),
  decide?: TelegramDecisionHandler,
): Promise<number | null> {
  let last: number | null = null;
  for (const update of updates) {
    last = update.update_id;
    if (update.callback_query !== undefined) {
      await handleCallbackQuery(db, sender, update.callback_query, decide, now);
      continue;
    }
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    if (chatId === undefined || typeof text !== "string") continue;
    const match = text.trim().match(/^\/start\s+([A-Za-z0-9]+)$/);
    if (match === null) continue;
    const code = match[1]!;
    if (redeemLinkCode(db, code, String(chatId), now)) {
      await sender.sendMessage(
        String(chatId),
        "✅ Đã liên kết Telegram với cc-web. Bạn sẽ nhận thông báo phê duyệt và run kết thúc tại đây.",
      );
    }
  }
  return last;
}

/** One polling tick: fetch updates past the stored offset and process them. */
export async function pollTelegramOnce(
  db: Database,
  sender: TelegramSender,
  decide?: TelegramDecisionHandler,
): Promise<void> {
  const offset = getPollOffset(db);
  const updates = await sender.getUpdates(offset);
  if (updates.length === 0) return;
  const last = await processTelegramUpdates(db, sender, updates, Date.now(), decide);
  if (last !== null) setPollOffset(db, last + 1);
}
