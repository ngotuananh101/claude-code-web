/**
 * Control database schema, migrations and repository interfaces.
 *
 * SQLite + Drizzle for the single-instance MVP; PostgreSQL is a later upgrade
 * behind the same repository interface (§18.4).
 */

export {
  type CommandKind,
  CommandOutbox,
  type DeliveryState,
  type EnqueueInput,
  type OutboxCommand,
} from "./command-outbox.ts";
export { migrate } from "./db.ts";
export {
  type ConsumedEnrollment,
  type CreatedEnrollment,
  consumeEnrollment,
  createEnrollment,
} from "./enrollment.ts";
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
  type DispatchDecision,
  type DispatchRequest,
  type RunnerCapacity,
  type RunnerState,
  Scheduler,
} from "./scheduler.ts";
