import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { taskStateFromEvents } from "./background-tasks.ts";
import { deriveChatTurns } from "./chat-turns.ts";
import * as historyModule from "./session-history.ts";
import {
  createSdkChatHistory,
  createSessionHistory,
  sessionHistoryTarget,
} from "./session-history.ts";
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
  test("SDK-only history waits for demand and drops reset-stale reads", async () => {
    let reads = 0;
    const pending = deferred();
    const create = (
      historyModule as unknown as {
        createSdkChatHistory: (options: {
          fetch: (...args: unknown[]) => Promise<unknown>;
          onError: (message: string) => void;
        }) => {
          update: (target: ReturnType<typeof sessionHistoryTarget>) => void;
          load: () => Promise<void>;
          messages: { value: SessionMessage[] };
          hasMore: { value: boolean };
        };
      }
    ).createSdkChatHistory;
    const history = create({
      fetch: () => {
        reads++;
        return pending.promise;
      },
      onError: () => {},
    });
    history.update(sessionHistoryTarget(pin, []));
    expect(reads).toBe(0);
    const loading = history.load();
    history.update(sessionHistoryTarget(pin, [reset]));
    pending.resolve({ ok: true, messages: oldMessages });
    await loading;
    expect(history.messages.value).toEqual([]);
  });

  test("SDK snapshot expiration refreshes only on new demand and never mixes snapshot rows", async () => {
    const calls: unknown[] = [];
    const errors: string[] = [];
    const pages = [
      {
        ok: true as const,
        messages: [{ type: "user" as const, uuid: "old", message: { content: "old" } }],
        chatBefore: 24,
        hasMore: true,
        chatSnapshot: "first",
      },
      { ok: false as const, code: "SDK_HISTORY_EXPIRED", message: "expired" },
      {
        ok: true as const,
        messages: [{ type: "user" as const, uuid: "fresh", message: { content: "fresh" } }],
        chatBefore: 0,
        hasMore: false,
        chatSnapshot: "fresh",
      },
    ];
    const history = createSdkChatHistory({
      fetch: async (_w, _s, _r, options) => {
        calls.push(options);
        return pages[calls.length - 1]!;
      },
      onError: (error) => errors.push(error),
    });
    history.update(sessionHistoryTarget(pin, []));
    await history.load();
    await history.load();
    expect(calls).toEqual([
      { chatBefore: Number.MAX_SAFE_INTEGER },
      { chatBefore: 24, chatSnapshot: "first" },
    ]);
    expect(errors).toEqual(["expired"]);
    expect(history.messages.value).toEqual([]);
    expect(history.hasMore.value).toBe(true);
    await history.load();
    expect(calls[2]).toEqual({ chatBefore: Number.MAX_SAFE_INTEGER });
    expect(history.messages.value.map((row) => row.uuid)).toEqual(["fresh"]);
  });

  test("SDK snapshot changes are refused rather than silently combined", async () => {
    let calls = 0;
    const errors: string[] = [];
    const history = createSdkChatHistory({
      fetch: async () => ({
        ok: true,
        messages: [{ type: "user", uuid: `u-${++calls}`, message: { content: "prompt" } }],
        chatBefore: calls === 1 ? 24 : 12,
        hasMore: true,
        chatSnapshot: calls === 1 ? "first" : "wrong",
      }),
      onError: (error) => errors.push(error),
    });
    history.update(sessionHistoryTarget(pin, []));
    await history.load();
    await history.load();
    expect(history.messages.value.map((row) => row.uuid)).toEqual(["u-1"]);
    expect(errors).toHaveLength(1);
  });

  test("SDK-only history prepends older pages, single-flights, and stops at the oldest", async () => {
    const calls: (number | undefined)[] = [];
    const pages = [
      {
        ok: true as const,
        messages: [{ type: "user" as const, uuid: "u-9", message: { content: "nine" } }],
        chatBefore: 30,
        hasMore: true,
        chatSnapshot: "snapshot-1",
      },
      {
        ok: true as const,
        messages: [{ type: "user" as const, uuid: "u-3", message: { content: "three" } }],
        chatBefore: 0,
        hasMore: false,
        chatSnapshot: "snapshot-1",
      },
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history = createSdkChatHistory({
      fetch: async (_workspace, _sdk, _runner, options) => {
        calls.push(options.chatBefore);
        await gate;
        return pages[calls.length - 1]!;
      },
      onError: () => {},
    });
    history.update(sessionHistoryTarget(pin, []));
    const first = history.load();
    const concurrent = history.load();
    expect(calls).toEqual([Number.MAX_SAFE_INTEGER]);
    release();
    await Promise.all([first, concurrent]);
    expect(history.messages.value.map((message) => message.uuid)).toEqual(["u-9"]);
    expect(history.hasMore.value).toBe(true);

    await history.load();
    expect(calls).toEqual([Number.MAX_SAFE_INTEGER, 30]);
    expect(history.messages.value.map((message) => message.uuid)).toEqual(["u-3", "u-9"]);
    expect(history.hasMore.value).toBe(false);

    await history.load();
    expect(calls).toHaveLength(2);
  });

  test("SDK fallback skips journal-covered pages and stores only the older prefix", async () => {
    const covered = [
      event(1, "run.started", { prompt: "overlap" }),
      event(2, "message.delta", { messageId: "m-overlap", text: "covered answer" }),
      event(3, "run.finished", {}),
      { ...event(4, "run.started", { prompt: "latest" }), runId: "run-latest" },
      { ...event(5, "run.finished", {}), runId: "run-latest" },
    ];
    const calls: (number | undefined)[] = [];
    const pages = [
      {
        ok: true as const,
        messages: [
          { type: "user" as const, uuid: "u-latest", message: { content: "latest" } },
          { type: "assistant" as const, uuid: "a-latest", message: { content: "latest answer" } },
        ],
        chatBefore: 24,
        hasMore: true,
        chatSnapshot: "snapshot-1",
      },
      {
        ok: true as const,
        messages: [
          { type: "user" as const, uuid: "u-old", message: { content: "older" } },
          { type: "assistant" as const, uuid: "a-old", message: { content: "older answer" } },
          { type: "user" as const, uuid: "u-overlap", message: { content: "overlap" } },
          {
            type: "assistant" as const,
            uuid: "a-overlap",
            message: { id: "m-overlap", content: "covered answer" },
          },
        ],
        chatBefore: 12,
        hasMore: true,
        chatSnapshot: "snapshot-1",
      },
      {
        ok: true as const,
        messages: [{ type: "user" as const, uuid: "u-oldest", message: { content: "oldest" } }],
        chatBefore: 0,
        hasMore: false,
        chatSnapshot: "snapshot-1",
      },
    ];
    const history = createSdkChatHistory({
      fetch: async (_workspace, _sdk, _runner, options) => {
        calls.push(options.chatBefore);
        return pages[calls.length - 1]!;
      },
      onError: () => {},
    });
    history.update(sessionHistoryTarget(pin, covered));
    expect(calls).toEqual([]);
    await history.load(covered);
    expect(history.messages.value.map((message) => message.uuid)).toEqual(["u-old", "a-old"]);
    expect(calls).toEqual([Number.MAX_SAFE_INTEGER, 24]);
    await history.load(covered);
    expect(history.messages.value.map((message) => message.uuid)).toEqual([
      "u-oldest",
      "u-old",
      "a-old",
    ]);
    expect(history.hasMore.value).toBe(false);
    expect(calls).toEqual([Number.MAX_SAFE_INTEGER, 24, 12]);
  });

  test("lazy history performs no read until explicitly opened and reset invalidates it", async () => {
    let reads = 0;
    const pending = deferred();
    const history = createSessionHistory({
      lazy: true,
      fetch: () => {
        reads++;
        return pending.promise;
      },
      onError: () => {},
    });
    history.update(sessionHistoryTarget(pin, []));
    await settle();
    expect(reads).toBe(0);
    history.load();
    expect(reads).toBe(1);
    history.update(sessionHistoryTarget(pin, [reset]));
    pending.resolve({ ok: true, messages: oldMessages });
    await settle();
    expect(history.messages.value).toEqual([]);
    expect(reads).toBe(1);
  });

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
