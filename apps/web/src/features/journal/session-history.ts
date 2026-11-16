import {
  type BrowserReplayEvent,
  conversationResetId,
  isConversationReset,
  type SessionMessage,
} from "@cc-web/protocol";
import { ref } from "vue";
import { validSdkChatPage } from "../../services/history-validation.ts";
import type { SessionMessagesOutcome, SessionsOptions } from "../../services/sessions-api.ts";
import { deriveChatTurns } from "./chat-turns.ts";

/** Keep only SDK rows before the first bubble already covered by the journal. */
function sdkOnlyPrefix(
  rows: SessionMessage[],
  journal: readonly BrowserReplayEvent[],
): SessionMessage[] {
  if (journal.length === 0) return rows;
  const fused = deriveChatTurns(rows, journal);
  const boundary = fused.findIndex((turn) => turn.key.startsWith("live-"));
  if (boundary < 0) return rows;
  const overlapped = deriveChatTurns(rows, [])[boundary];
  if (overlapped === undefined) return rows;
  const index = rows.findIndex((row) => `history-${row.uuid}` === overlapped.key);
  return index < 0 ? rows : rows.slice(0, index);
}

/**
 * Whether the SDK chain is the only place an older message could live.
 *
 * `createSdkChatHistory` starts with `hasMore = true` because a resumed
 * conversation may predate the control journal, and it never reads the chain
 * on its own. Advertising the affordance from that flag alone offered "load
 * older" on a brand-new session, where the journal is the whole conversation
 * and the SDK has nothing older to give. The evidence that pre-journal history
 * can exist is a run that *resumed* a conversation: only an explicit resume
 * can point this session at a transcript that began before its journal, and the
 * runner records that resume in the `run.started` payload.
 *
 * Do not widen this to "the session has an SDK id". Every session that has run
 * once has one — `sessionHistoryTarget` reads it from `session.updated` or the
 * listing pin, both derived from the session's own first run — and that SDK
 * conversation begins with that run, so nothing older can exist behind it.
 * Widening the check is exactly the bug this function replaced: a brand-new
 * session offering a page it cannot fill.
 */
export function sdkChainHasOlderHistory(events: readonly BrowserReplayEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== "run.started") return false;
    const payload = event.payload as Record<string, unknown> | null;
    if (typeof payload !== "object" || payload === null) return false;
    const resume = payload["resumeSessionId"];
    return typeof resume === "string" && resume.trim() !== "";
  });
}

/**
 * Whether the journal offers an earlier page — the single decision behind the
 * "load older messages" button.
 *
 * Two independent sources can hold older messages, and the button must appear
 * exactly when at least one of them exists:
 *
 * - The paged journal still has a previous page (`historyHasMore`).
 * - The paged journal is exhausted, but the session resumed an SDK
 *   conversation, so the SDK chain may hold messages older than the journal
 *   (see `sdkChainHasOlderHistory`).
 *
 * The second branch additionally requires a bootstrapped stream and
 * `sdkHasMore`: the journal's own page count is unknown before the bootstrap
 * frame, and a chain already read to its end has nothing left to offer.
 */
export function hasEarlierHistory(input: {
  historyHasMore: boolean;
  bootstrapped: boolean;
  target: SessionHistoryTarget | null;
  sdkHasMore: boolean;
  events: readonly BrowserReplayEvent[];
}): boolean {
  if (input.historyHasMore) return true;
  return (
    input.target !== null &&
    input.bootstrapped &&
    input.sdkHasMore &&
    sdkChainHasOlderHistory(input.events)
  );
}

export type SessionHistoryTarget = {
  sessionId: string;
  sdkSessionId: string;
  runnerId: string;
  workspaceId: string;
  resetEventId: string | null;
};

type SessionPin = {
  sessionId: string;
  sdkSessionId: string | null;
  runnerId: string | null;
  workspaceId: string | null;
};

/** Journal metadata wins over a listing fetched before /clear. Retain the reset
 * identity even if a subsequent init names the same SDK conversation. */
export function sessionHistoryTarget(
  pin: SessionPin | undefined,
  events: readonly BrowserReplayEvent[],
): SessionHistoryTarget | null {
  if (!pin?.runnerId || !pin.workspaceId) return null;
  let sdkSessionId: string | undefined;
  let resetEventId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (isConversationReset(event)) {
      resetEventId = event.eventId;
      sdkSessionId ??= conversationResetId(event.payload);
      break;
    }
    if (sdkSessionId !== undefined || event.type !== "session.updated") continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (typeof payload !== "object" || payload === null) continue;
    const id = payload["session_id"] ?? payload["sdkSessionId"];
    if (typeof id === "string" && id.trim() !== "") sdkSessionId = id.trim();
  }
  if (sdkSessionId === undefined) {
    sdkSessionId = pin.sdkSessionId ?? undefined;
    if (!sdkSessionId) {
      const started = events.find((event) => event.type === "run.started");
      const payload = started?.payload as Record<string, unknown> | null;
      const resume = payload?.["resumeSessionId"];
      if (typeof resume === "string" && resume.trim() !== "") sdkSessionId = resume.trim();
    }
  }
  if (!sdkSessionId) return null;
  return {
    sessionId: pin.sessionId,
    sdkSessionId,
    runnerId: pin.runnerId,
    workspaceId: pin.workspaceId,
    resetEventId,
  };
}

/** Clears synchronously on conversation/route changes. A generation token also
 * invalidates reads when the route returns to the same conversation (A→B→A). */
export function createSessionHistory(options: {
  fetch: (
    workspaceId: string,
    sdkSessionId: string,
    runnerId: string,
  ) => Promise<{ ok: true; messages: SessionMessage[] } | { ok: false; message: string }>;
  lazy?: boolean;
  onError: (message: string) => void;
}) {
  const messages = ref<SessionMessage[]>([]);
  let key: string | null = null;
  let generation = 0;
  let current: SessionHistoryTarget | null = null;
  let requested = false;
  function load(): void {
    if (current === null || requested) return;
    const target = current;
    requested = true;
    const expected = generation;
    void (async () => {
      const result = await options.fetch(target.workspaceId, target.sdkSessionId, target.runnerId);
      if (expected !== generation) return;
      if (result.ok) messages.value = result.messages;
      else {
        requested = false;
        options.onError(result.message);
      }
    })();
  }
  function update(target: SessionHistoryTarget | null): void {
    const nextKey = target === null ? null : JSON.stringify(target);
    if (nextKey === key) return;
    key = nextKey;
    ++generation;
    messages.value = [];
    current = target;
    requested = false;
    if (!options.lazy) load();
  }
  return { messages, update, load };
}

/** SDK-only main history is never requested while journal pages remain. */
export function createSdkChatHistory(options: {
  fetch: (
    workspaceId: string,
    sdkSessionId: string,
    runnerId: string,
    options: SessionsOptions,
  ) => Promise<SessionMessagesOutcome>;
  onError: (message: string) => void;
}) {
  const messages = ref<SessionMessage[]>([]);
  const hasMore = ref(true);
  let target: SessionHistoryTarget | null = null;
  let key: string | null = null;
  let generation = 0;
  let before = Number.MAX_SAFE_INTEGER;
  let snapshot: string | undefined;
  let pending: Promise<void> | null = null;
  function update(next: SessionHistoryTarget | null): void {
    const nextKey = next === null ? null : JSON.stringify(next);
    if (nextKey === key) return;
    key = nextKey;
    target = next;
    generation++;
    messages.value = [];
    hasMore.value = true;
    before = Number.MAX_SAFE_INTEGER;
    snapshot = undefined;
    pending = null;
  }
  function load(journal: readonly BrowserReplayEvent[] = []): Promise<void> {
    if (pending !== null) return pending;
    if (target === null || !hasMore.value) return Promise.resolve();
    const current = target;
    const expected = generation;
    pending = (async () => {
      // Empty overlap pages advance only the cursor. Demand stops as soon as
      // one older SDK prefix is found; it never retains journal duplicates.
      while (hasMore.value) {
        const result = await options.fetch(
          current.workspaceId,
          current.sdkSessionId,
          current.runnerId,
          { chatBefore: before, ...(snapshot === undefined ? {} : { chatSnapshot: snapshot }) },
        );
        if (generation !== expected) return;
        if (!result.ok) {
          if (result.code === "SDK_HISTORY_EXPIRED") {
            messages.value = [];
            before = Number.MAX_SAFE_INTEGER;
            snapshot = undefined;
            hasMore.value = true;
          }
          options.onError(result.message);
          return;
        }
        if (!validSdkChatPage(result, before, snapshot)) {
          options.onError("Trang lịch sử không hợp lệ. Hãy thử tải lại.");
          return;
        }
        const prefix = sdkOnlyPrefix(result.messages, journal);
        snapshot = result.chatSnapshot;
        const next = result.chatBefore ?? 0;
        hasMore.value = result.hasMore;
        before = next;
        if (prefix.length > 0) {
          messages.value = [...prefix, ...messages.value];
          return;
        }
      }
    })().finally(() => {
      if (generation === expected) pending = null;
    });
    return pending;
  }
  return { messages, hasMore, update, load };
}
