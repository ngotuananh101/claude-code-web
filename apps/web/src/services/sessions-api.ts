/**
 * The session-history surface's HTTP half (§16.1, Task 10).
 *
 * Two reads over the composite id:
 * - `fetchWorkspaceSessions` forwards `workspace.sessions.list` to the runner that
 *   owns the workspace and answers with the parsed `SessionSummary[]`.
 * - `fetchSessionMessages` forwards `workspace.sessions.messages` and answers
 *   with the parsed `SessionMessage[]`.
 *
 * Pure mapping, like `inspect-api.ts`: which statuses collapse into which
 * operator-facing outcome is decided here so a component never parses a body meant
 * for a person. The never-throw spine and the Vietnamese copy for known runner
 * codes are shared with `browse-api.ts` (§23's whole surface speaks one convention).
 */

import type { SessionMessage, SessionSummary } from "@cc-web/protocol";
import { compositeId, request } from "./browse-api.ts";

export type WorkspaceSessionsOutcome =
  | { ok: true; sessions: SessionSummary[] }
  | { ok: false; code: string; message: string };

export type SessionMessagesOutcome =
  | { ok: true; messages: SessionMessage[] }
  | { ok: false; code: string; message: string };

export type SessionsOptions = { limit?: number; offset?: number };

/**
 * Resolve the workspace id for the URL from either a `(runnerId, workspaceId)`
 * pair or a pre-composed `workspaceId`.
 *
 * - A supplied `runnerId` wins and composes `runnerId/workspaceId` into one
 *   encoded segment.
 * - Without a `runnerId`, a `workspaceId` that already contains a `/` is
 *   URL-encoded as a whole (it is already a composite id); a bare id is used as-is.
 */
export function composeWorkspaceId(runnerId: string | undefined, workspaceId: string): string {
  if (runnerId !== undefined && runnerId !== "") {
    if (workspaceId.startsWith(`${runnerId}/`)) {
      return encodeURIComponent(workspaceId);
    }
    return compositeId(runnerId, workspaceId);
  }
  if (workspaceId.includes("/")) {
    return encodeURIComponent(workspaceId);
  }
  return workspaceId;
}

/**
 * Append `limit` and/or `offset` query parameters when present; omitted values are
 * not sent as the string "undefined" so the runner never sees a literal it cannot
 * coerce to a number.
 */
function withPagination(url: string, options?: SessionsOptions): string {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return query === "" ? url : `${url}?${query}`;
}

/**
 * The sessions list for a workspace (§16.1): forwards `workspace.sessions.list`
 * and answers with the `sessions` array the runner's `SessionsListResult` carries.
 */
export function fetchWorkspaceSessions(
  workspaceId: string,
  runnerId?: string,
  options?: SessionsOptions,
): Promise<WorkspaceSessionsOutcome> {
  const id = composeWorkspaceId(runnerId, workspaceId);
  const url = withPagination(`/api/workspaces/${id}/sessions`, options);
  return request<{ op: string; dir: string; sessions: SessionSummary[] }>(url).then((r) =>
    r.ok
      ? { ok: true, sessions: r.value.sessions }
      : { ok: false, code: r.code, message: r.message },
  );
}

/**
 * The message history of one session (§16.1): forwards
 * `workspace.sessions.messages` and answers with the `messages` array the
 * runner's `SessionMessagesResult` carries.
 */
export function fetchSessionMessages(
  workspaceId: string,
  sessionId: string,
  runnerId?: string,
  options?: SessionsOptions,
): Promise<SessionMessagesOutcome> {
  const id = composeWorkspaceId(runnerId, workspaceId);
  const base = `/api/workspaces/${id}/sessions/${encodeURIComponent(sessionId)}/messages`;
  const url = withPagination(base, options);
  return request<{ op: string; sessionId: string; messages: SessionMessage[] }>(url).then((r) =>
    r.ok
      ? { ok: true, messages: r.value.messages }
      : { ok: false, code: r.code, message: r.message },
  );
}
