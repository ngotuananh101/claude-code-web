import type {
  AttachmentInfo,
  BrowserReplayEvent,
  HistoryTurn,
  SessionMessage,
} from "@cc-web/protocol";
import {
  type ChatTurn,
  deriveChatTurns,
  eventAgentId,
  eventParentToolUseId,
} from "./chat-turns.ts";

type Pending = { runId: string; prompt: string; attachments?: AttachmentInfo[] };
const TERMINALS = new Set(["run.finished", "run.failed", "run.interrupted"]);
function main(event: BrowserReplayEvent): boolean {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return eventAgentId(payload) === undefined && eventParentToolUseId(payload) === undefined;
}

/** Settled pages never re-reduce when a new live fragment arrives. */
export function createPagedTurns() {
  const historyCache = new WeakMap<HistoryTurn, ChatTurn[]>();
  const liveCache = new Map<string, { last: BrowserReplayEvent; turns: ChatTurn[] }>();
  const sdkCache = new WeakMap<
    readonly SessionMessage[],
    { signature: string; turns: ChatTurn[] }
  >();
  return (
    history: readonly HistoryTurn[],
    live: readonly BrowserReplayEvent[],
    pending?: Pending,
    sdkHistory: readonly SessionMessage[] = [],
  ): ChatTurn[] => {
    const turns: ChatTurn[] = [];
    let prefix: BrowserReplayEvent[] = [];
    let prefixKind: "agent" | undefined;
    let prefixKey: string | undefined;
    for (let index = 0; index < history.length; index++) {
      const input = history[index]!;
      let cached = historyCache.get(input);
      if (cached === undefined) {
        cached = deriveChatTurns([], input.events).filter((turn) => turn.kind === input.kind);
        // The page cursor names the chunk, not the bubble: a chunk that derives
        // more than one turn of its kind still needs a sibling-safe key, or Vue
        // reuses one bubble's DOM for both.
        for (const [position, turn] of cached.entries()) {
          turn.key =
            position === 0 ? `history-${input.cursor}` : `history-${input.cursor}-${position}`;
        }
        historyCache.set(input, cached);
      }
      const tail = cached.at(-1);
      // Continue the bootstrap's active bubble with post-watermark events.
      if (
        index === history.length - 1 &&
        tail?.kind === "agent" &&
        tail.status === "running" &&
        live.length > 0 &&
        !(live[0]!.type === "run.started" && main(live[0]!))
      ) {
        prefix = input.events;
        prefixKind = "agent";
        prefixKey = tail.key;
      } else turns.push(...cached);
    }

    let group = [...prefix];
    let firstKind = prefixKind;
    const activeKeys = new Set<string>();
    function flush(settled: boolean): void {
      if (group.length === 0) return;
      const key = group[0]!.eventId;
      const last = group.at(-1)!;
      activeKeys.add(key);
      const cached = settled ? liveCache.get(key) : undefined;
      const derived =
        cached?.last === last
          ? cached.turns
          : deriveChatTurns([], group).filter(
              (turn) => firstKind === undefined || turn.kind === firstKind,
            );
      if (cached?.last !== last) {
        for (const turn of derived) {
          turn.key =
            firstKind === "agent" && prefixKey !== undefined
              ? prefixKey
              : `page-live-${key}-${turn.kind}`;
        }
      }
      if (settled) liveCache.set(key, { last, turns: derived });
      turns.push(...derived);
      group = [];
      firstKind = undefined;
      prefixKey = undefined;
    }
    for (const event of live) {
      if (event.type === "run.started" && main(event)) flush(true);
      group.push(event);
      if (TERMINALS.has(event.type) && main(event)) flush(true);
    }
    flush(false);
    for (const key of liveCache.keys()) if (!activeKeys.has(key)) liveCache.delete(key);
    if (
      pending !== undefined &&
      !live.some((event) => event.runId === pending.runId) &&
      !history.some((turn) => turn.events.some((event) => event.runId === pending.runId))
    ) {
      turns.push(...deriveChatTurns([], [], pending));
    }
    if (sdkHistory.length > 0) {
      // The SDK prefix is only what journal pages do not already hold, so its cut
      // depends on the loaded page set as well as the SDK rows themselves.
      // Text fragments cannot change overlap. Cache on main-run/identity
      // evidence instead, so the settled SDK prefix survives a streaming delta.
      const overlap = new Set<string>();
      for (const event of live) {
        if (!main(event)) continue;
        if (event.type === "message.delta") {
          const id = (event.payload as { messageId?: unknown } | null)?.messageId;
          if (typeof id === "string") overlap.add(`message-${id}`);
        } else if (
          [
            "run.started",
            "message.started",
            "message.completed",
            "tool.started",
            "tool.completed",
          ].includes(event.type)
        ) {
          overlap.add(event.eventId);
        }
      }
      const signature = `${history.length}:${history[0]?.cursor ?? ""}:${history.at(-1)?.cursor ?? ""}:${JSON.stringify([...overlap])}`;
      let cached = sdkCache.get(sdkHistory);
      if (cached === undefined || cached.signature !== signature) {
        const journal = [...history.flatMap((input) => input.events), ...live];
        const fused = deriveChatTurns(sdkHistory, journal);
        const firstLive = fused.findIndex(
          (turn) => turn.key.startsWith("live-") || turn.key.startsWith("page-live-"),
        );
        cached = { signature, turns: firstLive < 0 ? fused : fused.slice(0, firstLive) };
        sdkCache.set(sdkHistory, cached);
      }
      return [...cached.turns, ...turns];
    }
    return turns;
  };
}
