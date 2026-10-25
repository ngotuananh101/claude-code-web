/**
 * Control database schema, migrations and repository interfaces.
 *
 * SQLite + Drizzle for the single-instance MVP; PostgreSQL is a later upgrade
 * behind the same repository interface (§18.4).
 */

export {
  type ApprovalKind,
  type ApprovalRecord,
  approvalForSession,
  closeApproval,
  type DecisionOutcome,
  recordApprovalDecision,
  type UpsertApprovalRequestedInput,
  upsertApprovalRequested,
} from "./approvals.ts";
export {
  type CommandKind,
  CommandOutbox,
  type DeliveryState,
  type EnqueueInput,
  fingerprintOf,
  type OutboxCommand,
} from "./command-outbox.ts";
export { migrate } from "./db.ts";
export {
  attemptWatermark,
  type IngestResult,
  ingestEvent,
  type JournalEvent,
} from "./journal.ts";
export {
  listSessions,
  type ReplayEvent,
  readSessionEvents,
  type SessionSummary,
  sessionEarliest,
  sessionOwner,
  sessionWatermark,
} from "./replay.ts";
export {
  issueRunnerCredential,
  revokeRunner,
  type VerifiedRunner,
  verifyRunnerCredential,
} from "./runner-credentials.ts";
export {
  createRunnerToken,
  type ListedRunner,
  listRunners,
  type MintedRunnerToken,
} from "./runner-tokens.ts";
export {
  type DispatchDecision,
  type DispatchRequest,
  type RunnerCapacity,
  type RunnerState,
  Scheduler,
} from "./scheduler.ts";
export {
  type UsageDay,
  type UsageStats,
  type UsageTotals,
  usageStats,
} from "./stats.ts";
