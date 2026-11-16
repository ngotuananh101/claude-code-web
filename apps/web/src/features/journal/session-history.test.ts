import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { taskStateFromEvents } from "./background-tasks.ts";
import { deriveChatTurns } from "./chat-turns.ts";
import { createSessionHistory, sessionHistoryTarget } from "./session-history.ts";
import { deriveSubagentItems } from "./subagent-events.ts";

const pin = { sessionId: "s-1", sdkSessionId: "sdk-old", runnerId: "r-1", workspaceId: "w-1" };
function event(
  seq: number,
  type: BrowserReplayEvent["type"],
  payload: unknown,
): BrowserReplayEvent {
  return {
    sessionSequence: seq,
    eventId: `e-${seq}`,
    runId: "run-clear",
    attemptId: "a-1",
    occurredAt: "now",
    type,
    payload,
  };
}
const reset = event(10, "session.updated", {
  type: "conversation_reset",
  new_conversation_id: "sdk-new",
  session_id: "sdk-old",
  trigger: "clear",
});
const oldMessages: SessionMessage[] = [
  { type: "user", uuid: "old-user", message: { content: "Old prompt" } },
  {
    type: "assistant",
    uuid: "old-child",
    agentId: "old-agent",
    parentToolUseId: "old-tool",
    message: { content: [{ type: "text", text: "Old child" }] },
  },
];

function deferred() {
  let resolve!: (value: { ok: true; messages: SessionMessage[] }) => void;
  const promise = new Promise<{ ok: true; messages: SessionMessage[] }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("session history across /clear", () => {
  test("the reset target wins over a stale session listing and resume prompt", () => {
    const target = sessionHistoryTarget(pin, [reset]);
    expect(target).toEqual({ ...pin, sdkSessionId: "sdk-new", resetEventId: "e-10" });
    expect(
      sessionHistoryTarget(pin, [
        event(1, "run.started", { resumeSessionId: "sdk-ancient" }),
        reset,
      ]),
    ).toEqual(target);
    expect(sessionHistoryTarget({ ...pin, runnerId: null }, [reset])).toBeNull();
  });

  test("a later init keeps the reset boundary and legacy reset events override stale listings", () => {
    expect(
      sessionHistoryTarget(pin, [reset, event(11, "session.updated", { session_id: "sdk-next" })]),
    ).toEqual({ ...pin, sdkSessionId: "sdk-next", resetEventId: "e-10" });
    expect(sessionHistoryTarget(pin, [{ ...reset, type: "run.status" }])).toEqual({
      ...pin,
      sdkSessionId: "sdk-new",
      resetEventId: "e-10",
    });
    expect(
      sessionHistoryTarget({ ...pin, sdkSessionId: null }, [
        event(1, "run.started", { resumeSessionId: "sdk-resumed" }),
      ]),
    ).toEqual({ ...pin, sdkSessionId: "sdk-resumed", resetEventId: null });
  });

  test("old chat and subagent history disappear immediately and late reads cannot restore them", async () => {
    const first = deferred();
    const late = deferred();
    const fresh = deferred();
    let reads = 0;
    const requested: string[] = [];
    const history = createSessionHistory({
      fetch: (_workspace, sdkId) => {
        requested.push(sdkId);
        return [first, late, fresh][reads++]!.promise;
      },
      onError: () => {
        throw new Error("unexpected history error");
      },
    });
    history.update(sessionHistoryTarget(pin, []));
    first.resolve({ ok: true, messages: oldMessages });
    await settle();
    expect(deriveChatTurns(history.messages.value, []).map((turn) => turn.kind)).toEqual(["user"]);
    expect(deriveSubagentItems(history.messages.value, [], taskStateFromEvents([]))).toHaveLength(
      1,
    );

    history.update(sessionHistoryTarget({ ...pin, sdkSessionId: "sdk-old-2" }, []));
    history.update(sessionHistoryTarget(pin, [reset]));
    expect(requested).toEqual(["sdk-old", "sdk-old-2", "sdk-new"]);
    expect(deriveChatTurns(history.messages.value, [reset])).toEqual([]);
    expect(
      deriveSubagentItems(history.messages.value, [reset], taskStateFromEvents([reset])),
    ).toEqual([]);
    late.resolve({ ok: true, messages: oldMessages });
    await settle();
    expect(history.messages.value).toEqual([]);
    const newMessages: SessionMessage[] = [
      { type: "user", uuid: "new-user", message: { content: "New prompt" } },
    ];
    fresh.resolve({ ok: true, messages: newMessages });
    await settle();
    expect(deriveChatTurns(history.messages.value, [reset]).map((turn) => turn.text)).toEqual([
      "New prompt",
    ]);
  });

  test("repeated journal updates keep loaded history, but route changes invalidate pending reads", async () => {
    const pending = deferred();
    const history = createSessionHistory({ fetch: () => pending.promise, onError: () => {} });
    const target = sessionHistoryTarget(pin, []);
    history.update(target);
    history.update(null);
    pending.resolve({ ok: true, messages: oldMessages });
    await settle();
    expect(history.messages.value).toEqual([]);

    history.update(target);
    await settle();
    const loaded = history.messages.value;
    history.update(sessionHistoryTarget(pin, [event(11, "run.status", { subtype: "progress" })]));
    expect(history.messages.value).toBe(loaded);
  });
});
