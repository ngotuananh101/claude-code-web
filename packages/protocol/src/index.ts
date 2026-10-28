/**
 * Wire protocol between Control Server and Runner.
 *
 * These are application-level types, deliberately independent of raw SDK types.
 * See ARCHITECTURE.md §9 (commands), §12 (events), §17 (HTTP/wire).
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * The largest single WebSocket message either endpoint accepts (§12.6).
 *
 * Bun's default is 16 MiB, which is roughly 30× the largest measured legitimate
 * frame (558 KiB — 64 events each carrying an 8 KiB tool input). An inbound
 * limit is free to tighten, and stating it turns "a 16 MiB message occupies the
 * peer until it is parsed" from a default into a decision.
 */
export const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The largest serialized payload one event may carry (§12.6).
 *
 * The transport ceiling above rejects an oversized frame, so a single event
 * larger than it can never be delivered — and because the row is durable, a
 * replayed event is refused on every attempt: a livelock, not a slow send. The
 * sender therefore bounds each event before it is persisted, leaving headroom
 * under the transport ceiling for the frame envelope and the ACK that follows.
 *
 * 1 MiB is ~128× the largest measured legitimate event (8,240 bytes, a
 * `message.completed` carrying a Write tool result), so it is a backstop for a
 * pathological message rather than a routine truncation.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;

export type RunnerCommand = {
  protocolVersion: ProtocolVersion;
  commandId: string;
  runnerId: string;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  assignmentEpoch?: number;
  kind: CommandKind;
  issuedAt: string;
  expiresAt?: string;
  payload: unknown;
};

export type CommandKind =
  | "run.start"
  | "run.cancel"
  | "approval.respond"
  | "workspace.file.write"
  | "workspace.file.revert"
  | "workspace.revert"
  | "workspace.inspect"
  | "config.inspect";

export type RunnerEvent = {
  protocolVersion: ProtocolVersion;
  eventId: string;
  runnerId: string;
  bootId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  /** Increases within an attempt; never reset on reconnect. */
  localSequence: number;
  occurredAt: string;
  type: EventType;
  payload: unknown;
};

export type EventType =
  | "command.accepted"
  | "command.rejected"
  | "run.started"
  | "run.status"
  | "run.finished"
  | "run.failed"
  | "run.interrupted"
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "approval.expired"
  | "question.requested"
  | "question.answered"
  | "workspace.changed"
  | "usage.updated"
  | "spool.warning"
  | "session.updated";

/**
 * The `EventType` union as a runtime list. The wire carries event types as
 * strings, and a server that accepted any string would journal invented types
 * forever; this list is what validation checks against. The `satisfies` plus the
 * completeness check below make the list and the union impossible to drift
 * apart at typecheck time.
 */
export const EVENT_TYPES = [
  "command.accepted",
  "command.rejected",
  "run.started",
  "run.status",
  "run.finished",
  "run.failed",
  "run.interrupted",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "question.requested",
  "question.answered",
  "workspace.changed",
  "usage.updated",
  "spool.warning",
  "session.updated",
] as const satisfies readonly EventType[];

type EventTypesCoverEventType = EventType extends (typeof EVENT_TYPES)[number] ? true : false;
// If this line fails to compile, EVENT_TYPES is missing an EventType member.
type _EventTypesAreComplete = [EventTypesCoverEventType] extends [true] ? true : false;

/** Runner → Server: a batch of journaled events (§12.2). */
export type EventBatchFrame = {
  type: "events";
  events: RunnerEvent[];
};

/** Server → Runner: the contiguous watermark an attempt is acknowledged through. */
export type EventAckFrame = {
  type: "events.ack";
  attemptId: string;
  through: number;
};

/**
 * Browser replay (§12.5). One frame type carries both the replay batches and
 * the live tail: the client deduplicates by `sessionSequence` and detects gaps,
 * so a frame is a delivery, never a promise about what came before it.
 */
export type BrowserReplayEvent = {
  sessionSequence: number;
  eventId: string;
  runId: string;
  attemptId: string;
  occurredAt: string;
  type: EventType;
  payload: unknown;
};

export type SessionEventsFrame = {
  type: "session.events";
  sessionId: string;
  /** False while replaying committed history, true once the tail is live. */
  live: boolean;
  /** The highest session sequence this frame's stream has reached. */
  through: number;
  events: BrowserReplayEvent[];
};

/**
 * Retention has deleted the range a subscription's offset points into; the
 * client resynchronizes from `fromSequence` (or a snapshot, once those exist).
 */
export type SessionResyncFrame = {
  type: "session.resync_required";
  sessionId: string;
  fromSequence: number;
};

/**
 * Usage accounting for the dashboard (§12.3 usage side). The numbers come
 * from the API's token fields on assistant messages; cost figures are
 * redacted before the journal and never appear here (§19.4).
 */
export type UsageTotals = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
};

export type UsageDay = UsageTotals & { day: string };

export type UsageStats = {
  /** All-time sums; the dashboard's KPI cards. */
  totals: UsageTotals;
  /** The last N UTC days, zero-filled, oldest first; the chart's series. */
  daily: UsageDay[];
  sessions: number;
  runs: number;
  events: number;
};

export type RunnerHello = {
  protocolVersion: ProtocolVersion;
  runnerId: string;
  bootId: string;
  runnerVersion: string;
  sdkVersion: string;
  platform: string;
  maxConcurrentRuns: number;
  activeRuns: RunInventoryItem[];
  eventOffsets: RunEventOffset[];
  /**
   * Optional so an older runner can still say hello (§6.4). Absent and empty
   * both mean "serves no optional capabilities", which is what the server
   * gates on before dispatching an inspection.
   */
  capabilities?: string[];
};

export type RunInventoryItem = {
  runId: string;
  attemptId: string;
  sessionId: string;
  state: "starting" | "running" | "waiting_for_approval" | "cancelling";
};

export type RunEventOffset = {
  attemptId: string;
  lastAcknowledgedSequence: number;
};

export {
  ConnectionRegistry,
  type OpenParams,
  type OpenResult,
  type TrafficCheck,
} from "./connection-registry.ts";
export {
  type NegotiatedPolicy,
  type NegotiateResult,
  type Negotiation,
  negotiateHello,
  parseCapabilities,
  type ServerPolicy,
} from "./handshake.ts";
export {
  BINARY_SNIFF_BYTES,
  type ChangeStatus,
  type ConfigInspectRequest,
  type DiagnosticsReport,
  type DiagnosticsResult,
  type FileListResult,
  type FileReadResult,
  type GitChangesResult,
  type GitDiffResult,
  INSPECT_CAPABILITY,
  type InspectRequest,
  type InspectResult,
  MAX_CHANGE_ENTRIES,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_LISTING_ENTRIES,
  parseInspectRequest,
  parseRpcResultFrame,
  type RpcResultFrame,
  type SnapshotEntry,
  type SnapshotStatusResult,
  type WorkspaceInspectRequest,
} from "./inspection.ts";
export { MODEL_IDS, type ModelId } from "./models.ts";
export * from "./mutation.ts";
export {
  type DeclaredWorkspace,
  parseDeclaredWorkspaces,
  type ReconcileAction,
  type ReconcileResult,
  type RunnerRunState,
  type RunState,
  reconcile,
  type ServerRunState,
} from "./reconcile.ts";
export {
  type DesiredState,
  type ObservedState,
  type Run,
  RunRegistry,
  toServerRunState,
} from "./run-registry.ts";
