import {
  type BrowserReplayEvent,
  EVENT_TYPES,
  type SessionHistoryFrame,
  type SessionMessage,
} from "@cc-web/protocol";

export type SdkChatPage = {
  messages: SessionMessage[];
  chatBefore: number | null;
  hasMore: boolean;
  chatSnapshot: string;
};

/** SDK payload fields remain extensible; only envelopes and paging invariants are fixed. */
export function validSdkChatPage(
  value: unknown,
  requestedBefore: number,
  snapshot?: string,
): value is SdkChatPage {
  if (!object(value)) return false;
  const { messages, chatBefore, hasMore, chatSnapshot } = value;
  if (
    !Array.isArray(messages) ||
    typeof hasMore !== "boolean" ||
    typeof chatSnapshot !== "string" ||
    chatSnapshot === "" ||
    chatSnapshot.length > 128 ||
    (snapshot !== undefined && chatSnapshot !== snapshot) ||
    (chatBefore !== null &&
      (typeof chatBefore !== "number" ||
        !Number.isSafeInteger(chatBefore) ||
        chatBefore < 0 ||
        chatBefore >= requestedBefore)) ||
    (messages.length === 0 ? chatBefore !== null || hasMore : chatBefore === null) ||
    (hasMore && chatBefore === 0)
  )
    return false;
  const ids = new Set<string>();
  for (const row of messages) {
    if (
      !object(row) ||
      (row["type"] !== "user" && row["type"] !== "assistant" && row["type"] !== "system") ||
      typeof row["uuid"] !== "string" ||
      row["uuid"] === "" ||
      ids.has(row["uuid"]) ||
      !json(row["message"])
    )
      return false;
    for (const key of [
      "parentToolUseId",
      "agentId",
      "agentType",
      "agentLabel",
      "workflowPhase",
      "workflowToolUseId",
    ]) {
      if (row[key] !== undefined && typeof row[key] !== "string") return false;
    }
    if (row["parentToolUseId"] || row["agentId"]) return false;
    ids.add(row["uuid"]);
  }
  return true;
}

const eventTypes = new Set<string>(EVENT_TYPES);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Payloads are extensible JSON, not an invented second schema for SDK events. */
function json(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    for (const child of Object.values(item)) pending.push(child);
  }
  return true;
}

function event(value: unknown, reset: number, watermark: number): value is BrowserReplayEvent {
  if (!object(value)) return false;
  const sequence = value["sessionSequence"];
  return (
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    sequence >= reset &&
    sequence <= watermark &&
    typeof value["eventId"] === "string" &&
    value["eventId"] !== "" &&
    typeof value["runId"] === "string" &&
    typeof value["attemptId"] === "string" &&
    typeof value["occurredAt"] === "string" &&
    Number.isFinite(Date.parse(value["occurredAt"])) &&
    typeof value["type"] === "string" &&
    eventTypes.has(value["type"]) &&
    json(value["payload"])
  );
}

/** Validate every compact input before accepting any page or coverage watermark. */
export function validSessionHistory(value: unknown): value is SessionHistoryFrame {
  if (!object(value)) return false;
  const { watermark, resetSequence, turns, context, before, hasMore, bootstrap, requestId } = value;
  if (
    typeof watermark !== "number" ||
    !Number.isSafeInteger(watermark) ||
    watermark < 0 ||
    typeof resetSequence !== "number" ||
    !Number.isSafeInteger(resetSequence) ||
    resetSequence < 0 ||
    resetSequence > watermark ||
    typeof bootstrap !== "boolean" ||
    typeof hasMore !== "boolean" ||
    (requestId !== undefined &&
      (typeof requestId !== "string" || requestId === "" || requestId.length > 128)) ||
    !Array.isArray(turns) ||
    turns.length > 12 ||
    !Array.isArray(context)
  )
    return false;
  let previous = 0;
  for (const turn of turns) {
    if (!object(turn)) return false;
    const { cursor, kind, events } = turn;
    if (
      typeof cursor !== "number" ||
      !Number.isSafeInteger(cursor) ||
      cursor <= previous ||
      (kind !== "user" && kind !== "agent") ||
      cursor % 2 !== (kind === "user" ? 0 : 1) ||
      Math.floor(cursor / 2) <= resetSequence ||
      Math.floor(cursor / 2) > watermark ||
      !Array.isArray(events) ||
      events.length === 0
    )
      return false;
    let sequence = Math.floor(cursor / 2) - 1;
    for (const input of events) {
      if (!event(input, resetSequence, watermark) || input.sessionSequence <= sequence)
        return false;
      sequence = input.sessionSequence;
    }
    previous = cursor;
  }
  if (before !== (turns[0]?.cursor ?? null) || (hasMore && turns.length === 0)) return false;
  const ids = new Set<string>();
  for (const input of context) {
    if (!event(input, resetSequence, watermark) || ids.has(input.eventId)) return false;
    ids.add(input.eventId);
  }
  return true;
}
