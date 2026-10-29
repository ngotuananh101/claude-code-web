/**
 * Pure logic for the Composer's workspace & session picking (Task 12).
 *
 * The Composer.vue SFC cannot be compiled in the Bun test environment (no
 * @vue/compiler-sfc), so the workspace-session wiring that has observable,
 * testable behaviour lives here as pure functions — the same convention the
 * codebase uses for `features/browse/folder-browser.ts`, `features/journal/`,
 * and `features/inspect/*`. Composer.vue is a thin DOM wrapper that calls
 * into these helpers.
 */

import type { SessionSummary } from "@cc-web/protocol";
import { relativeTime } from "@/lib/relative-time.ts";
import { type RegisterWorkspaceOutcome, registerWorkspace } from "@/services/browse-api.ts";
import type { StartRunRequest } from "@/services/runs-api.ts";
import { fetchWorkspaceSessions, type WorkspaceSessionsOutcome } from "@/services/sessions-api.ts";

/** The "new session" sentinel value the session select offers as its first option. */
export const NEW_SESSION = "new" as const;

/**
 * The run-time representation of one option in the session selector dropdown.
 * `value` is what `selectedSession.value` holds; `"new"` creates a fresh
 * session, anything else resumes that session id.
 */
export type SessionOption = {
  value: string;
  label: string;
};

/**
 * Convert a `SessionSummary` from the runner into a dropdown option with a
 * human-readable label. Falls back to the raw session id when the SDK supplied
 * no summary.
 */
export function sessionOption(session: SessionSummary, now: number = Date.now()): SessionOption {
  const name = session.summary || session.sessionId;
  const when = relativeTime(session.lastModified, now);
  return { value: session.sessionId, label: `${name} · ${when}` };
}

/**
 * Fetch and sort the Claude Code sessions for a workspace.
 *
 * Returns `{ ok: false }` when the sessions fetch failed — the caller can toast
 * the message and keep the old (or empty) list rather than crashing.
 * On success returns the sessions sorted by `lastModified` descending, so the
 * newest session is the first item after the "new session" option.
 */
export async function loadWorkspaceSessions(
  workspaceId: string,
  runnerId: string | undefined,
): Promise<{ ok: true; sessions: SessionSummary[] } | { ok: false; message: string }> {
  const outcome: WorkspaceSessionsOutcome = await fetchWorkspaceSessions(workspaceId, runnerId);
  if (!outcome.ok) {
    return { ok: false, message: outcome.message };
  }
  const sorted = [...outcome.sessions].sort((a, b) => b.lastModified - a.lastModified);
  return { ok: true, sessions: sorted };
}

/**
 * Decide whether the resumeSessionId field should be sent on the run payload.
 *
 * - `"new"` (or an empty value) → omit: the runner starts a fresh session.
 * - any other string → include as `resumeSessionId`.
 */
export function resumeSessionIdFor(selectedSession: string): string | undefined {
  if (selectedSession === NEW_SESSION || selectedSession === "") return undefined;
  return selectedSession;
}

/**
 * Resolve a `runnerId/workspaceId` composite value from a project option back
 * into the pair the services expect. The composite uses `/` as the in-object
 * separator (UUIDs never contain one), so this is a simple split.
 */
export function splitCompositeId(composite: string): { runnerId: string; workspaceId: string } {
  const parts = composite.split("/");
  const runnerId = parts[0] ?? "";
  const workspaceId = parts.slice(1).join("/");
  return { runnerId, workspaceId };
}

/**
 * Register a custom-path workspace through the browse API and return the
 * composite id the UI uses to select it. On failure the caller surfaces the
 * Vietnamese message.
 */
export async function registerCustomWorkspace(
  runnerId: string,
  path: string,
): Promise<{ ok: true; compositeId: string } | { ok: false; message: string }> {
  const outcome: RegisterWorkspaceOutcome = await registerWorkspace(runnerId, path);
  if (!outcome.ok) {
    return { ok: false, message: outcome.message };
  }
  // The register API returns the runner-scoped workspace id; the composite
  // id the UI selects on is `${runnerId}/${workspaceId}`.
  const workspaceId = outcome.value.workspaceId;
  const compositeId = `${runnerId}/${workspaceId}`;
  return { ok: true, compositeId };
}

/**
 * The inputs the Composer.send() needs to build its run payload. All come
 * from the component's own refs so the function stays pure and testable.
 */
export type RunPayloadInputs = {
  prompt: string;
  permission: string;
  model: string;
  /** The selected project option's workspace id. */
  workspaceId: string;
  /** The selected project option's runner id, or undefined for the legacy fallback. */
  projectRunnerId: string | undefined;
  /** The runner select's current value ("auto" or a specific runner id). */
  runnerId: string;
  branch: string;
  /** The selected session value: "new" or a session id. */
  selectedSession: string;
  /** Whether this is a fresh session (the new-session page) or an existing one. */
  isNewSessionPage: boolean;
  /** The branch option's known branches, used to decide whether to send branch. */
  branchOptions: string[];
};

/**
 * Build the `StartRunRequest` body for a run, following the exact conditional
 * rules Composer.vue enforces:
 *
 * - `resumeSessionId` is included only when `selectedSession` is not "new".
 * - Workspace/runner/branch context rides only on the new-session page, and
 *   only when the project has a declared runner (legacy fallback projects send
 *   a prompt-only body).
 * - Model travels only when not "default".
 *
 * Extracting this into a pure function lets the test suite assert the payload
 * shape without mounting the Vue SFC.
 */
export function buildRunRequest(inputs: RunPayloadInputs): StartRunRequest {
  const {
    prompt,
    permission,
    model,
    workspaceId,
    projectRunnerId,
    runnerId,
    branch,
    selectedSession,
  } = inputs;

  const body: StartRunRequest = {
    prompt: prompt.trim(),
    permissionMode: permission,
  };

  // Model travels only when not "default" — nothing sent means the SDK's own default.
  if (model !== "default") body.model = model;

  // Workspace / runner / branch context rides only on the new-session page,
  // and only when the project was declared by a runner (not the legacy fallback).
  if (inputs.isNewSessionPage && projectRunnerId !== undefined) {
    body.workspaceId = workspaceId;
    if (runnerId !== "auto") body.runnerId = runnerId;
    if (branch !== "current" && inputs.branchOptions.includes(branch)) {
      body.branch = branch;
    }
  }

  // Resume: only when an existing session is selected.
  if (selectedSession !== NEW_SESSION && selectedSession !== "") {
    body.resumeSessionId = selectedSession;
  }

  return body;
}
