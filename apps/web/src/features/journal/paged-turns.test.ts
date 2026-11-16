import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, HistoryTurn, SessionMessage } from "@cc-web/protocol";
import { createPagedTurns } from "./paged-turns.ts";

const event = (
  sequence: number,
  type: BrowserReplayEvent["type"],
  payload: unknown,
  runId = "run",
): BrowserReplayEvent => ({
  sessionSequence: sequence,
  eventId: `e-${sequence}`,
  runId,
  attemptId: runId,
  occurredAt: "2026-11-16T00:00:00Z",
  type,
  payload,
});

describe("cached paged chat turns", () => {
  test("an assistant page border does not create a hidden user bubble", () => {
    const derive = createPagedTurns();
    const inputs: HistoryTurn[] = [
      {
        cursor: 3,
        kind: "agent",
        events: [
          event(1, "run.started", { prompt: "do not duplicate" }),
          event(2, "message.delta", { text: "answer" }),
          event(3, "run.finished", {}),
        ],
      },
    ];
    const turns = derive(inputs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.kind).toBe("agent");
    expect(turns[0]!.text).toBe("answer");
  });

  test("settled older bubbles retain identity while the live turn changes", () => {
    const derive = createPagedTurns();
    const inputs: HistoryTurn[] = [
      {
        cursor: 3,
        kind: "agent",
        events: [
          event(1, "run.started", { prompt: "old" }),
          event(2, "message.delta", { text: "old answer" }),
          event(3, "run.finished", {}),
        ],
      },
    ];
    const live = [
      event(4, "run.started", { prompt: "new" }, "new"),
      event(5, "message.delta", { text: "a" }, "new"),
    ];
    const first = derive(inputs, live);
    const next = derive(inputs, [...live, event(6, "message.delta", { text: "b" }, "new")]);
    expect(first[0]).toBe(next[0]);
    expect(next.map((turn) => turn.text)).toEqual(["old answer", "new", "ab"]);
    expect(first.at(-1)!.text).toBe("a");
  });

  test("running history retains its bubble key when the live tail arrives", () => {
    const derive = createPagedTurns();
    const inputs: HistoryTurn[] = [
      {
        cursor: 3,
        kind: "agent",
        events: [
          event(1, "run.started", { prompt: "question" }),
          event(2, "message.delta", { text: "prefix" }),
        ],
      },
    ];
    const before = derive(inputs, []);
    const after = derive(inputs, [event(3, "message.delta", { text: " tail" })]);
    expect(after[0]!.key).toBe(before[0]!.key);
  });

  test("subsequent turns of one run receive distinct stable bubble keys", () => {
    const derive = createPagedTurns();
    const live = [
      event(1, "message.delta", { text: "one" }),
      event(2, "run.finished", {}),
      event(3, "message.delta", { text: "two" }),
      event(4, "run.finished", {}),
    ];
    const turns = derive([], live);
    expect(turns.map((turn) => turn.text)).toEqual(["one", "two"]);
    expect(new Set(turns.map((turn) => turn.key)).size).toBe(2);
  });

  test("SDK prefix drops the turns journal pages already cover and re-fuses when pages change", () => {
    const derive = createPagedTurns();
    const newest: HistoryTurn[] = [
      { cursor: 1, kind: "user", events: [event(1, "run.started", { prompt: "old" })] },
      {
        cursor: 3,
        kind: "agent",
        events: [
          event(2, "message.delta", { messageId: "m-old", text: "old answer" }),
          event(3, "run.finished", {}),
        ],
      },
    ];
    const sdk: SessionMessage[] = [
      { type: "user", uuid: "u-older", message: { content: "older" } },
      {
        type: "assistant",
        uuid: "a-older",
        message: { id: "m-older", content: [{ type: "text", text: "older answer" }] },
      },
      { type: "user", uuid: "u-old", message: { content: "old" } },
      {
        type: "assistant",
        uuid: "a-old",
        message: { id: "m-old", content: [{ type: "text", text: "old answer" }] },
      },
    ];
    const fused = derive(newest, [], undefined, sdk);
    expect(fused.map((turn) => turn.text)).toEqual(["older", "older answer", "old", "old answer"]);

    // An older page grows the journal; the cached SDK prefix must shrink so the
    // page's copy is the only one rendered.
    const older: HistoryTurn[] = [
      { cursor: -3, kind: "user", events: [event(-3, "run.started", { prompt: "older" })] },
      {
        cursor: -1,
        kind: "agent",
        events: [
          event(-2, "message.delta", { messageId: "m-older", text: "older answer" }),
          event(-1, "run.finished", {}),
        ],
      },
    ];
    const grown = derive([...older, ...newest], [], undefined, sdk);
    expect(grown.map((turn) => turn.text)).toEqual(["older", "older answer", "old", "old answer"]);
    expect(new Set(grown.map((turn) => turn.key)).size).toBe(4);
  });

  test("SDK overlap re-fuses when live content arrives without a history-page change", () => {
    const derive = createPagedTurns();
    const sdk: SessionMessage[] = [
      { type: "user", uuid: "u-question", message: { content: "question" } },
      { type: "assistant", uuid: "a-answer", message: { id: "m-answer", content: "answer" } },
    ];
    expect(derive([], [], undefined, sdk).map((turn) => turn.text)).toEqual(["question", "answer"]);
    const live = [
      event(1, "run.started", { prompt: "question" }),
      event(2, "message.delta", { messageId: "m-answer", text: "answer" }),
      event(3, "run.finished", {}),
    ];
    const next = derive([], live, undefined, sdk);
    expect(next.map((turn) => turn.text)).toEqual(["question", "answer"]);
    expect(new Set(next.map((turn) => turn.key)).size).toBe(2);
  });

  test("settled SDK prefix retains identity during live text deltas", () => {
    const derive = createPagedTurns();
    const sdk: SessionMessage[] = [
      { type: "user", uuid: "u-old", message: { content: "old" } },
      { type: "assistant", uuid: "a-old", message: { id: "m-old", content: "old answer" } },
    ];
    const live = [
      event(1, "run.started", { prompt: "new" }, "new"),
      event(2, "message.delta", { messageId: "m-new", text: "a" }, "new"),
    ];
    const first = derive([], live, undefined, sdk);
    const next = derive(
      [],
      [...live, event(3, "message.delta", { messageId: "m-new", text: "b" }, "new")],
      undefined,
      sdk,
    );
    expect(next.map((turn) => turn.text)).toEqual(["old", "old answer", "new", "ab"]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });

  test("live deltas continue a running bootstrap bubble without losing its prefix", () => {
    const derive = createPagedTurns();
    const inputs: HistoryTurn[] = [
      {
        cursor: 3,
        kind: "agent",
        events: [
          event(1, "run.started", { prompt: "question" }),
          event(2, "message.delta", { text: "prefix" }),
        ],
      },
    ];
    const next = derive(inputs, [
      event(3, "message.delta", { text: " tail" }),
      event(4, "run.finished", {}),
    ]);
    expect(next).toHaveLength(1);
    expect(next[0]!.text).toBe("prefix tail");
    expect(next[0]!.kind === "agent" && next[0]!.status).toBe("done");
  });

  /**
   * Vue keys a `v-for` list by `turn.key`, so two siblings sharing one key make
   * it reuse or mispatch the wrong bubble. A history page assigns keys from the
   * page cursor, which is one value — so a chunk that derives more than one turn
   * of the same kind (a run boundary this reducer splits into two bubbles) must
   * still hand out distinct keys.
   */
  test("a history chunk that derives several turns still yields distinct keys", () => {
    const derive = createPagedTurns();
    const inputs: HistoryTurn[] = [
      {
        cursor: 11,
        kind: "agent",
        events: [
          event(1, "run.started", { prompt: "question" }),
          event(2, "message.delta", { text: "first" }),
          event(3, "run.finished", {}),
          event(4, "message.delta", { text: "second" }),
        ],
      },
    ];
    const turns = derive(inputs, []);
    const keys = turns.map((turn) => turn.key);
    expect(turns.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
