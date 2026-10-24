/**
 * Wire protocol between Control Server and Runner.
 *
 * These are application-level types, deliberately independent of raw SDK types.
 * See ARCHITECTURE.md §9 (commands), §12 (events), §17 (HTTP/wire).
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

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
  type ServerPolicy,
} from "./handshake.ts";

export {
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
