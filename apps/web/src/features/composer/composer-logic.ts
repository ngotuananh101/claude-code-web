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

import type { EffortLevel, ModelMapping, ProfileSummary, SessionSummary } from "@cc-web/protocol";
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
): Promise<
  { ok: true; workspaceId: string; compositeId: string } | { ok: false; message: string }
> {
  const outcome: RegisterWorkspaceOutcome = await registerWorkspace(runnerId, path);
  if (!outcome.ok) {
    return { ok: false, message: outcome.message };
  }
  // The register API returns the runner-scoped workspace id; the composite
  // id the UI selects on is `${runnerId}/${workspaceId}`.
  const workspaceId = outcome.value.workspaceId;
  const compositeId = `${runnerId}/${workspaceId}`;
  return { ok: true, workspaceId, compositeId };
}

/** A workspace row as the composer reasons about it. */
export type KnownWorkspace = { runnerId: string; workspaceId: string; path: string };

/** Two folder paths that name the same directory, ignoring trailing slashes. */
function samePath(a: string, b: string): boolean {
  const strip = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, "") : value);
  return strip(a) === strip(b);
}

/**
 * The workspace a browsed folder already is, if any.
 *
 * Browsing to a folder a runner *declared* must select that row, not register a
 * second one: the control plane keys workspaces on `(runnerId, workspaceId)`,
 * so a fresh id for a known path would leave two rows for one directory.
 */
export function workspaceForPath<T extends KnownWorkspace>(
  workspaces: readonly T[],
  runnerId: string,
  path: string,
): T | undefined {
  return workspaces.find(
    (workspace) => workspace.runnerId === runnerId && samePath(workspace.path, path),
  );
}

/**
 * The inputs the Composer.send() needs to build its run payload. All come
 * from the component's own refs so the function stays pure and testable.
 */
export type RunPayloadInputs = {
  prompt: string;
  permission: string;
  model: string;
  /** The chosen effort; null means the SDK's own default. */
  effort: EffortLevel | null;
  /** The standing ultracode mode — the picker's current state, sent verbatim. */
  ultracode: boolean;
  /** The selected folder's workspace id; undefined when no folder is chosen. */
  workspaceId: string | undefined;
  /** The selected folder's runner id, or undefined when no folder is chosen. */
  projectRunnerId: string | undefined;
  /** The runner select's current value; empty until the operator picks one. */
  runnerId: string;
  /** The selected session value: "new" or a session id. */
  selectedSession: string;
  /** Whether this is a fresh session (the new-session page) or an existing one. */
  isNewSessionPage: boolean;
  /**
   * The ids of attachments the Composer picked for this run (Task 5). Sent only
   * when the operator dropped files in — an empty/absent value means "no
   * attachments" and travels as nothing on the wire.
   */
  attachmentIds?: string[];
  /**
   * The selected profile id (Task 7), or null when the "Runner Host" default is
   * active. Sent only when a real profile is chosen so the server applies the
   * profile overlay; omitted otherwise so the run falls back to the host config.
   * `undefined` is accepted for callers that have not yet resolved a value.
   */
  profileId: string | null | undefined;
};

/**
 * Build the `StartRunRequest` body for a run, following the exact conditional
 * rules Composer.vue enforces:
 *
 * - `resumeSessionId` is included only when `selectedSession` is not "new".
 * - Workspace/runner context rides only on the new-session page, and only
 *   when a folder is chosen: there is no "any ready runner" placement, the
 *   operator names the runner, so `runnerId` always travels with it.
 * - No branch is ever sent: the run uses whatever HEAD the workspace holds,
 *   and the composer only displays that branch.
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
    effort,
    ultracode,
    profileId,
    workspaceId,
    projectRunnerId,
    runnerId,
    selectedSession,
    attachmentIds,
  } = inputs;

  const body: StartRunRequest = {
    prompt: prompt.trim(),
    permissionMode: permission,
  };

  // Model travels only when not "default" — nothing sent means the SDK's own default.
  if (model !== "default") body.model = model;

  // §5.2: effort rides only when one was chosen; ultracode always travels,
  // because the toggle is the operator's standing choice and an omitted flag
  // would let a host config silently turn it back on.
  if (effort !== null) body.effort = effort;
  body.ultracode = ultracode;

  // Profile: only when a real profile is chosen (not null/undefined) — the
  // server applies the profile overlay; omitted means fall back to host config.
  if (profileId !== null && profileId !== undefined) {
    body.profileId = profileId;
  }

  // Workspace / runner context rides only on the new-session page, and only
  // once the operator has chosen a folder to run in.
  if (inputs.isNewSessionPage && projectRunnerId !== undefined && workspaceId !== undefined) {
    body.workspaceId = workspaceId;
    if (runnerId !== "") body.runnerId = runnerId;
  }

  // Resume: only when an existing session is selected.
  if (selectedSession !== NEW_SESSION && selectedSession !== "") {
    body.resumeSessionId = selectedSession;
  }

  // Attachments: only when the operator picked files.
  if (attachmentIds !== undefined && attachmentIds.length > 0) {
    body.attachmentIds = attachmentIds;
  }

  return body;
}

/**
 * Resolve the display label for a model role, given the active profile.
 *
 * When the active profile remaps that role to an upstream name (e.g.
 * `sonnet -> prime`), the mapped value is appended in parentheses to the
 * canonical label: `"Sonnet (prime)"` (§4.5.3). With no mapping the plain
 * canonical label is returned so the picker always reads naturally.
 */
export function resolveModelLabel(input: {
  model: string;
  profile?: { modelMapping?: ModelMapping } | null;
}): string {
  const role = input.model.toLowerCase();
  const mapping: ModelMapping | undefined = input.profile?.modelMapping;
  const mapped = mapping?.[role as keyof ModelMapping];

  // The canonical label for a role uses its capitalized form; an arbitrary
  // value falls back gracefully to itself.
  const canonical =
    role === "sonnet"
      ? "Sonnet"
      : role === "opus"
        ? "Opus"
        : role === "haiku"
          ? "Haiku"
          : role === "fable"
            ? "Fable"
            : role === "subagent"
              ? "Subagent"
              : input.model;

  if (typeof mapped === "string" && mapped.trim() !== "") {
    return `${canonical} (${mapped})`;
  }
  return canonical;
}

/** Resolve a profile's display name from a summary. */
export function profileName(profile: ProfileSummary | null | undefined): string {
  if (!profile) return "Mặc định (Runner Host)";
  return profile.name || profile.profileId;
}
