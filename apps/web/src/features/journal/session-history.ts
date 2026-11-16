import {
  type BrowserReplayEvent,
  conversationResetId,
  isConversationReset,
  type SessionMessage,
} from "@cc-web/protocol";
import { ref } from "vue";

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
  onError: (message: string) => void;
}) {
  const messages = ref<SessionMessage[]>([]);
  let key: string | null = null;
  let generation = 0;
  function update(target: SessionHistoryTarget | null): void {
    const nextKey = target === null ? null : JSON.stringify(target);
    if (nextKey === key) return;
    key = nextKey;
    const expected = ++generation;
    messages.value = [];
    if (target === null) return;
    void (async () => {
      const result = await options.fetch(target.workspaceId, target.sdkSessionId, target.runnerId);
      if (expected !== generation) return;
      if (result.ok) messages.value = result.messages;
      else options.onError(result.message);
    })();
  }
  return { messages, update };
}
