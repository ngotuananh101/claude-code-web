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
  type ExpiredApproval,
  expirePendingApprovalsForAttempt,
  recordApprovalDecision,
  type UpsertApprovalRequestedInput,
  upsertApprovalRequested,
} from "./approvals.ts";
export {
  deleteSessionAttachments,
  getSessionAttachment,
  getSessionAttachmentById,
  insertSessionAttachment,
  listSessionAttachments,
  type SessionAttachmentRecord,
} from "./attachments.ts";
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
  appendServerEvent,
  attemptWatermark,
  type IngestResult,
  ingestEvent,
  type JournalEvent,
  SERVER_EVENT_SEQUENCE_BASE,
  type ServerEventAppend,
  type ServerEventInput,
} from "./journal.ts";
export {
  type CreateProfileInput,
  createProfile,
  deleteProfile,
  getProfileById,
  getProfileWithSecret,
  listProfilesForOwner,
  type ProfileWithSecret,
  type UpdateProfilePatch,
  updateProfile,
} from "./profiles.ts";
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
  deleteRunner,
  type ListedRunner,
  listRunners,
  type MintedRunnerToken,
  updateRunnerName,
} from "./runner-tokens.ts";
export {
  advanceSchedule,
  cancelScheduleForOwner,
  computeNextFire,
  type DueScheduleCursor,
  dueSchedules,
  listActiveSchedules,
  projectScheduleEvent,
  reopenRejectedSchedule,
  runKnown,
  type ScheduleEventInput,
  type ScheduleRecord,
} from "./scheduled-tasks.ts";
export {
  type DispatchDecision,
  type DispatchRequest,
  type RunnerCapacity,
  type RunnerState,
  Scheduler,
} from "./scheduler.ts";
export {
  deleteSession,
  type EnsureSessionPinInput,
  ensureSessionPin,
  type SessionPin,
  sessionPin,
  updateSessionTitle,
} from "./sessions.ts";
export {
  type UsageDay,
  type UsageStats,
  type UsageTotals,
  usageStats,
} from "./stats.ts";
export {
  type DeclaredWorkspaceRow,
  type OwnerWorkspace,
  registerWorkspace,
  upsertRunnerWorkspaces,
  workspacesForOwner,
} from "./workspaces.ts";
