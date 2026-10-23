/**
 * Runner-local SQLite schema: command inbox, event outbox, attempts,
 * workspace locks, pending approvals (§18.2).
 *
 * Local disk only — never NFS or a shared network database file.
 */

export { migrateRunnerDb } from "./db.ts";
export {
  type AppendParams,
  type AppendResult,
  ackUpTo,
  appendEvent,
  highestContiguousAcked,
  type PendingEvent,
  pendingEvents,
} from "./event-outbox.ts";
export {
  type AcceptResult,
  acceptCommand,
  type CommandEnvelope,
  fingerprintCommand,
  type InboxState,
} from "./inbox.ts";
