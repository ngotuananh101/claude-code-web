/**
 * Runner-local SQLite schema: command inbox, event outbox, attempts,
 * workspace locks, pending approvals (§18.2).
 *
 * Local disk only — never NFS or a shared network database file.
 */

export {
  finishApproval,
  type InsertPendingApprovalInput,
  insertPendingApproval,
  type PendingApproval,
  type PendingApprovalKind,
  pendingApproval,
} from "./approvals.ts";
export {
  type AttemptState,
  attemptState,
  type BeginInput,
  type BeginResult,
  beginAttempt,
  finishAttempt,
  lockHolder,
  recordSdkSessionId,
  recoverStaleAttempts,
  releaseAttempt,
  sdkSessionIdForSession,
  type TerminalState,
} from "./attempts.ts";
export { migrateRunnerDb } from "./db.ts";
export {
  type AppendParams,
  type AppendResult,
  ackUpTo,
  appendEvent,
  highestContiguousAcked,
  type PendingEvent,
  pendingEventAttempts,
  pendingEvents,
} from "./event-outbox.ts";
export {
  type AcceptResult,
  acceptCommand,
  type CommandEnvelope,
  fingerprintCommand,
  type InboxState,
} from "./inbox.ts";
