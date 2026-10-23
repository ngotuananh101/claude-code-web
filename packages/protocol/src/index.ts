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
