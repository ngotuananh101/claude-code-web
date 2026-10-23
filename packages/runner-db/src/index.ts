/**
 * Runner-local SQLite schema: command inbox, event outbox, attempts,
 * workspace locks, pending approvals (§18.2).
 *
 * Local disk only — never NFS or a shared network database file.
 */

export { migrateRunnerDb } from "./db.ts";
export {
  acceptCommand,
  fingerprintCommand,
  type CommandEnvelope,
  type AcceptResult,
  type InboxState,
} from "./inbox.ts";
export {
  appendEvent,
  ackUpTo,
  pendingEvents,
  highestContiguousAcked,
  type AppendParams,
  type AppendResult,
  type PendingEvent,
} from "./event-outbox.ts";
