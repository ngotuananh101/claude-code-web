<script setup lang="ts">
import type {
  DiagnosticsResult,
  FileListResult,
  FileReadResult,
  GitChangesResult,
  GitDiffResult,
  ScheduledTask,
  SnapshotEntry,
  SnapshotStatusResult,
} from "@cc-web/protocol";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  editableReadNotice,
  isDirty,
  isEditableRead,
  viewerAfterSave,
} from "../features/inspect/edit";
import { formatSize } from "../features/inspect/format";
import { breadcrumbs, joinPath, parentPath } from "../features/inspect/paths";
import { canApplyPlan, summarisePlan } from "../features/inspect/revert";
import { draftAfterNavigation, rememberDraft } from "../features/review/diff-drafts";
import {
  isReviewed,
  isReviewedByPath,
  resolveIncoming,
  reviewKey,
} from "../features/review/review-state";
import { parseUnifiedDiff, spliceOriginal } from "../features/review/unified-diff";
import { toScheduleRow } from "../features/schedules/schedule-rows";
import {
  compositeId,
  fetchChanges,
  fetchDiagnostics,
  fetchDiff,
  fetchSnapshotStatus,
  listFiles,
  readFile,
  revertFile,
  revertWorkspace,
  writeFile,
} from "../services/inspect-api";
import { cancelSchedule, listSchedules } from "../services/schedules-api";
import { sessions } from "../stores/sessions.ts";

/**
 * Inspection beside the conversation (§16.1's secondary panel, P3-A ruling 12).
 *
 * The sidebar is navigation only: Files lists directories and opens a file in
 * the review dialog, Changes lists the working tree and opens a diff there.
 * Everything that renders code — the editor, the diff, review marks, save and
 * revert — lives in `ReviewDialog`, so the diff gets the full dialog width
 * instead of the sidebar's few hundred pixels.
 *
 * The composite workspace id comes from the session's pin, which the rail's
 * own list already carries (T10) — a pre-pin session answers null and the
 * panel says so instead of guessing where the session runs.
 */

const props = defineProps<{ sessionId: string }>();

type Tab = "files" | "changes" | "diagnostics" | "schedules";
const TAB_LABELS: Record<Tab, string> = {
  files: "Tệp tin",
  changes: "Thay đổi",
  diagnostics: "Chẩn đoán",
  schedules: "Lịch",
};

const tab = ref<Tab>("files");

const activeSession = computed(() =>
  sessions.sessions.find((row) => row.sessionId === props.sessionId),
);

/** One encoded path segment, or null when the session has no pin. */
const workspace = computed(() => {
  const row = activeSession.value;
  if (row === undefined || row.runnerId === null || row.workspaceId === null) return null;
  return compositeId(row.runnerId, row.workspaceId);
});

// Files
const directory = ref("");
const listing = ref<FileListResult | null>(null);
const filesError = ref<string | null>(null);
const filesLoading = ref(false);
const viewer = ref<FileReadResult | null>(null);

// Files editor (P3-B save)
const draft = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

// Draft conflict handling (P3-D): a file changed on the runner between open
// and write, while the operator still had an unsaved draft.
const conflictIncoming = ref<FileReadResult | null>(null);
// Why a clicked file cannot open the dialog editor (binary / truncated).
const fileNotice = ref<string | null>(null);

/** True when the open viewer has unsaved edits in the draft. */
function isDraftDirty(): boolean {
  return (
    viewer.value !== null &&
    draft.value !== null &&
    isDirty(viewer.value.content ?? "", draft.value)
  );
}

// Changes
const changes = ref<GitChangesResult | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);
const diffPath = ref<string | null>(null);
const diffError = ref<string | null>(null);
const diffLoading = ref(false);

// Changes — review-dialog state
const diffOriginal = ref<string>(""); // HEAD side: read document with hunks spliced
const diffRead = ref<FileReadResult | null>(null); // authoritative working side
const diffModified = ref<string>(""); // merged document the reviewer settles on
const reviewed = ref<Set<string>>(new Set());
// Reviewed keys are (path, content hash) pairs. Navigation only knows paths,
// so every read/save records the hash it observed; a path never opened here
// has no hash and therefore cannot be reviewed.
const reviewedPathHashes = ref<Map<string, string>>(new Map());
// Unsaved diff edits survive navigating to another file and back.
const diffDrafts = ref<Map<string, string>>(new Map());
const reviewSnapshotEntry = ref<SnapshotEntry | null>(null);
const diffSaving = ref(false);
const diffReverting = ref(false);
const diffSaveError = ref<string | null>(null);

// The dialog owns both the diff view and the file editor; the sidebar is
// navigation only.
const ReviewDialog = defineAsyncComponent(() => import("./review/ReviewDialog.vue"));

// ReviewDialog integration state
const reviewDialogOpen = ref(false);
const reviewDialogMode = ref<"diff" | "file">("diff");

// Changes — source toggle (Git diff by default, snapshot baseline for revert)
const source = ref<"git" | "snapshot">("git");
const snapshotStatus = ref<SnapshotStatusResult | null>(null);
const snapshotError = ref<string | null>(null);
const snapshotLoading = ref(false);
const confirmingPath = ref<string | null>(null);
const workspaceRevertConfirm = ref(false);

// Diagnostics
const diagnostics = ref<DiagnosticsResult | null>(null);
const diagnosticsError = ref<string | null>(null);
const diagnosticsLoading = ref(false);

// Schedules (§11.5): the control server owns these; the panel only lists the
// ones still active and cancels on request. A schedule fetch carries its own
// epoch so it can never drop an in-flight file or diff response — the tabs'
// loads are independent, and only the session change cancels both.
const schedules = ref<ScheduledTask[] | null>(null);
const schedulesError = ref<string | null>(null);
const schedulesLoading = ref(false);
const cancellingScheduleId = ref<string | null>(null);
let schedulesEpoch = 0;

// "trong 2 phút" is computed from a clock, so the clock has to move: a
// rendered row only re-evaluates when its dependencies change. The 30 s tick
// keeps the phrases honest without re-fetching anything.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onBeforeUnmount(() => {
  if (nowTimer !== null) clearInterval(nowTimer);
  nowTimer = null;
});

/**
 * Every load bumps this; a response whose epoch is stale is dropped instead of
 * written into a panel that has since moved to another directory, tab or
 * session. Without it, switching sessions mid-fetch painted the previous
 * workspace's listing under the new session's header.
 */
let epoch = 0;

const crumbs = computed(() => breadcrumbs(directory.value));

// The runner is trusted to be well-behaved, not to be bug-free: a wrongly typed
// result must not tear down the whole panel's render.
const entries = computed(() => {
  const value = listing.value?.entries;
  return Array.isArray(value) ? value : [];
});

const changeEntries = computed(() => {
  const value = changes.value?.entries;
  return Array.isArray(value) ? value : [];
});

const diffDirty = computed(() => {
  const read = diffRead.value;
  return read !== null && read.content !== null && read.content !== diffModified.value;
});

function isPathReviewed(path: string): boolean {
  // ReviewDialog navigation: the reviewed set is keyed by (path, hash); use
  // the hash observed when this path was last read or saved.
  return isReviewedByPath(reviewed.value, reviewedPathHashes.value, path);
}

const scheduleRows = computed(() => {
  const tasks = schedules.value;
  if (tasks === null) return [];
  return tasks.map((task) => ({ ...toScheduleRow(task, now.value), cron: task.cron }));
});

const changedPaths = computed(() => {
  if (changes.value && changes.value.entries.length > 0) {
    return changes.value.entries.map((c) => c.path);
  }
  if (snapshotStatus.value?.entries) {
    return snapshotStatus.value.entries.map((e) => e.path);
  }
  return [];
});

const STATUS_LABELS: Record<string, string> = {
  added: "thêm",
  modified: "sửa",
  deleted: "xoá",
  renamed: "đổi tên",
  copied: "sao chép",
  untracked: "chưa theo dõi",
  conflicted: "xung đột",
  typechange: "đổi loại",
};

async function loadFiles(dir: string, options: { keepViewer?: boolean } = {}): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  filesLoading.value = true;
  filesError.value = null;
  fileNotice.value = null;
  // Navigating to a directory closes the open file; a listing refresh behind
  // an open file keeps it (and its draft) in place.
  if (options.keepViewer !== true) viewer.value = null;
  const outcome = await listFiles(id, dir);
  if (current !== epoch) return;
  filesLoading.value = false;
  if (!outcome.ok) {
    filesError.value = outcome.message;
    listing.value = null;
    return;
  }
  directory.value = dir;
  listing.value = outcome.value;
}

async function loadChanges(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  changesLoading.value = true;
  changesError.value = null;
  diffPath.value = null;
  diffError.value = null;
  const outcome = await fetchChanges(id);
  if (current !== epoch) return;
  changesLoading.value = false;
  if (!outcome.ok) {
    changesError.value = outcome.message;
    changes.value = null;
    return;
  }
  changes.value = outcome.value;
}

async function loadDiagnostics(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  diagnosticsLoading.value = true;
  diagnosticsError.value = null;
  const outcome = await fetchDiagnostics(id);
  if (current !== epoch) return;
  diagnosticsLoading.value = false;
  if (!outcome.ok) {
    diagnosticsError.value = outcome.message;
    diagnostics.value = null;
    return;
  }
  diagnostics.value = outcome.value;
}

async function loadSchedules(): Promise<void> {
  const current = ++schedulesEpoch;
  schedulesLoading.value = true;
  schedulesError.value = null;
  const outcome = await listSchedules(props.sessionId);
  if (current !== schedulesEpoch) return;
  schedulesLoading.value = false;
  if (!outcome.ok) {
    schedulesError.value = outcome.message;
    schedules.value = null;
    return;
  }
  schedules.value = outcome.schedules;
}

async function cancelOneSchedule(scheduleId: string): Promise<void> {
  // One cancel at a time: two clicks would race two reloads against one list.
  if (cancellingScheduleId.value !== null) return;
  const current = schedulesEpoch;
  cancellingScheduleId.value = scheduleId;
  schedulesError.value = null;
  const outcome = await cancelSchedule(scheduleId);
  // A session change resets the panel and bumps the epoch; this response
  // belongs to the previous session and must not paint state into the new one.
  if (current !== schedulesEpoch) return;
  cancellingScheduleId.value = null;
  if (outcome === "cancelled" || outcome === "not_found") {
    // not_found means the row is already gone (fired, or cancelled from
    // another tab): reloading drops it from the list either way.
    await loadSchedules();
    return;
  }
  schedulesError.value =
    outcome === "unauthorized"
      ? "Phiên đăng nhập đã hết hạn."
      : "Không huỷ được lịch — thử lại sau.";
}

async function openEntry(name: string, kind: "file" | "directory" | "other"): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const path = joinPath(directory.value, name);
  if (kind === "directory") {
    await loadFiles(path);
    return;
  }
  if (kind !== "file") return;

  const current = ++epoch;
  filesLoading.value = true;
  filesError.value = null;
  fileNotice.value = null;
  saving.value = false;
  saveError.value = null;
  const outcome = await readFile(id, path);
  if (current !== epoch) return;
  filesLoading.value = false;
  if (!outcome.ok) {
    filesError.value = outcome.message;
    viewer.value = null;
    draft.value = null;
    // Nothing left to edit: an open dialog would sit on an empty document.
    reviewDialogOpen.value = false;
    return;
  }

  // An incoming open of the same path the operator is already editing: the
  // runner may have changed the file since the draft was opened. Resolve
  // against the draft's dirtiness — a clean draft silently adopts the new
  // content, a dirty one raises a conflict and keeps the draft.
  if (viewer.value !== null && viewer.value.path === path && draft.value !== null) {
    const resolution = resolveIncoming({
      currentHash: viewer.value.hash,
      incomingHash: outcome.value.hash,
      draftDirty: isDraftDirty(),
    });
    if (resolution === "conflict") {
      // Keep viewer + draft, keep the operator's work; surface the new bytes.
      conflictIncoming.value = outcome.value;
      openFileDialog();
      return;
    }
    if (resolution === "adopt-keep-draft") {
      // Same bytes the draft was based on: refresh the viewer fields (hash,
      // size) but keep the unsaved draft.
      viewer.value = outcome.value;
      conflictIncoming.value = null;
      openFileDialog();
      return;
    }
  }

  // Different path or a clean resolution: drop any stale conflict state.
  conflictIncoming.value = null;

  // Only text, untruncated reads open in the dialog editor; anything else
  // explains itself in the sidebar instead of rendering a stale viewer.
  const notice = editableReadNotice(outcome.value);
  if (notice !== null) {
    viewer.value = null;
    draft.value = null;
    fileNotice.value = notice;
    // The sidebar explains the refusal; do not leave a dialog on an empty file.
    reviewDialogOpen.value = false;
    return;
  }

  viewer.value = outcome.value;
  draft.value = outcome.value.content ?? "";
  openFileDialog();
}

/** Show the Files tab's viewer in the dialog (a mode switch keeps the diff draft). */
function openFileDialog(): void {
  reviewDialogMode.value = "file";
  reviewDialogOpen.value = true;
}

async function openDiff(path: string): Promise<void> {
  const id = workspace.value;
  if (id === null) return;

  // Navigating away from a dirty diff keeps the operator's edits: remember
  // them under the previous path and restore them when that path reopens.
  const previousPath = diffPath.value;
  if (previousPath !== null && previousPath !== path && diffRead.value !== null) {
    rememberDraft(diffDrafts.value, previousPath, diffModified.value, diffRead.value.content ?? "");
  }

  const current = ++epoch;
  diffLoading.value = true;
  diffError.value = null;

  // Concurrent: fetch the diff and the file read in parallel.
  const [diffOutcome, readOutcome] = await Promise.all([fetchDiff(id, path), readFile(id, path)]);

  if (current !== epoch) return;
  diffLoading.value = false;

  // Diff fetch failed — keep the changes list, operator can pick another file.
  if (!diffOutcome.ok) {
    diffError.value = diffOutcome.message;
    return;
  }

  diffPath.value = path;

  // A truncated diff never becomes a merge view. Track the reason so the
  // sidebar can explain why no dialog opened.
  let unavailable: string | null = diffOutcome.value.truncated
    ? "Diff đã được rút gọn — không mở được trình so sánh."
    : null;
  let parsed = diffOutcome.value.truncated ? null : parseUnifiedDiff(diffOutcome.value.diff);

  // Authoritative working side: the file read as it stands on the runner.
  const read = readOutcome.ok ? readOutcome.value : null;
  diffRead.value = read;
  if (read !== null) {
    // Remember which revision this path was reviewed against.
    reviewedPathHashes.value.set(path, read.hash);
  }

  let original = "";
  let modified = "";
  if (parsed !== null) {
    if (read !== null && !read.binary && !read.truncated && read.content !== null) {
      // A default-context `git diff` carries only its hunks, so the parser's
      // own original is a fragment. Splice the hunks into the full read of the
      // file to rebuild the HEAD side; if they no longer match (the file
      // changed between the two RPCs) fall back to the plain-text diff rather
      // than show a merge view over mismatched documents.
      const spliced = spliceOriginal(parsed, read.content);
      if (spliced === null) {
        parsed = null;
        unavailable = "Không dựng được chế độ so sánh cho tệp này.";
      } else {
        original = spliced;
        // Restore any preserved draft instead of the freshly read content.
        modified = draftAfterNavigation(diffDrafts.value, path, read.content);
      }
    } else if (read === null) {
      // Deleted file (or a failed read): the diff carries the whole old
      // document, the working side is empty, and the view is read-only.
      original = parsed.original;
      modified = parsed.modified;
    } else {
      // Binary or truncated read: there is no authoritative full document to
      // edit or diff against.
      parsed = null;
      unavailable = "Tệp nhị phân hoặc rút gọn — không mở được trình so sánh.";
    }
  }

  diffOriginal.value = original;
  diffModified.value = parsed === null ? "" : modified;

  // Only a file with a comparable diff opens the dialog; the sidebar explains
  // the rest instead of rendering an editor it cannot drive.
  if (parsed !== null) {
    reviewDialogMode.value = "diff";
    reviewDialogOpen.value = true;
  } else {
    diffError.value = unavailable ?? "Không dựng được chế độ so sánh cho tệp này.";
    reviewDialogOpen.value = false;
  }

  // Review state resets for the newly opened diff. Reviewed keys stay: the set
  // is session-scoped (path + hash), not diff-open-scoped.
  diffSaveError.value = null;

  // Lazily fetch snapshot status so we can know the revertable entry for this
  // path. Failure leaves reviewSnapshotEntry null and Revert disabled.
  const snapshotOutcome = await fetchSnapshotStatus(id);
  if (current !== epoch) return;
  if (!snapshotOutcome.ok) {
    reviewSnapshotEntry.value = null;
    return;
  }

  const status = snapshotOutcome.value;
  if (status.baseline === null) {
    reviewSnapshotEntry.value = null;
    return;
  }

  // Find the snapshot entry for this path.
  const entry = status.entries.find((e) => e.path === path);
  reviewSnapshotEntry.value = entry ?? null;
}

/**
 * Closing the dialog (or switching it to file mode) is a navigation away from
 * the open diff: preserve unsaved edits so reopening the file restores them.
 */
function rememberOpenDiffDraft(): void {
  if (diffPath.value === null || diffRead.value === null) return;
  rememberDraft(diffDrafts.value, diffPath.value, diffModified.value, diffRead.value.content ?? "");
}

watch(reviewDialogOpen, (open) => {
  if (!open && reviewDialogMode.value === "diff") rememberOpenDiffDraft();
});

watch(reviewDialogMode, (mode, previous) => {
  if (previous === "diff" && mode === "file") rememberOpenDiffDraft();
});

function toggleReviewed(path: string, hash: string): void {
  const key = reviewKey(path, hash);
  reviewedPathHashes.value.set(path, hash);
  const next = new Set(reviewed.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  reviewed.value = next;
}

async function saveDiff(): Promise<void> {
  // Guard: need all the pieces to perform a write.
  if (diffRead.value === null || diffPath.value === null || workspace.value === null) return;

  const current = ++epoch;
  diffSaving.value = true;
  diffSaveError.value = null;

  const path = diffPath.value;
  const content = diffModified.value;
  const expectedHash = diffRead.value.hash;

  const outcome = await writeFile(workspace.value, path, content, expectedHash);
  if (current !== epoch) return;
  diffSaving.value = false;

  if (!outcome.ok) {
    diffSaveError.value = outcome.message;
    return;
  }

  // Success: mark reviewed under the new hash, then refresh the change list.
  reviewed.value = new Set([...reviewed.value, reviewKey(path, outcome.value.hash)]);
  reviewedPathHashes.value.set(path, outcome.value.hash);
  // The saved content is the new baseline: no draft left to preserve.
  diffDrafts.value.delete(path);

  await loadChanges();

  // Re-open the diff ONLY if the refreshed change list still contains the path.
  // If the saved content now matches HEAD, the change is gone and we clear the
  // diff state instead of letting openDiff 404.
  const stillPresent = changes.value?.entries.some((e) => e.path === path) ?? false;
  if (stillPresent) {
    void openDiff(path);
  } else {
    diffPath.value = null;
    diffRead.value = null;
    diffModified.value = "";
    // Nothing left to compare: keep the dialog from sitting on an empty path.
    reviewDialogOpen.value = false;
  }
}

async function confirmRevert(path: string): Promise<void> {
  // Wrapper for revert called from ReviewDialog. The dialog renders its own
  // inline confirmation, so this runs only after the operator confirmed.
  if (reviewDialogMode.value === "diff") {
    await revertDiff();
    return;
  }

  const id = workspace.value;
  if (id === null) return;
  // The Files tab does not load the snapshot status; fetch it on demand.
  if (snapshotStatus.value === null) await loadSnapshot();
  const entry = snapshotStatus.value?.entries.find((e) => e.path === path) ?? null;
  if (entry === null) {
    saveError.value = "Không tìm thấy bản chụp cho tệp này.";
    return;
  }
  if (!entry.revertable) {
    saveError.value = "Tệp này không thể khôi phục từ bản chụp.";
    return;
  }

  await revertOneFile(entry);
  // The revert reloads bump the epoch; a session switch during them means this
  // continuation belongs to the previous panel.
  if (workspace.value !== id) return;
  if (snapshotError.value !== null) {
    saveError.value = snapshotError.value;
    return;
  }

  // Reflect the reverted bytes in the still-open dialog.
  const fresh = await readFile(id, path);
  if (workspace.value !== id) return;
  if (!fresh.ok) {
    saveError.value = fresh.message;
    return;
  }
  viewer.value = fresh.value;
  draft.value = isEditableRead(fresh.value) ? fresh.value.content : null;
  conflictIncoming.value = null;
  saveError.value = null;
}

async function revertDiff(): Promise<void> {
  if (diffReverting.value) return;
  const id = workspace.value;
  if (id === null) return;
  // Capture the path before the refreshes below clear it.
  const path = diffPath.value;
  if (path === null) return;
  const entry = reviewSnapshotEntry.value;
  if (entry === null) return;

  const current = ++epoch;
  diffReverting.value = true;

  try {
    const outcome = await revertFile(id, path, entry.currentHash);
    if (current !== epoch) return;

    if (!outcome.ok) {
      diffSaveError.value = outcome.message;
      return;
    }

    // The reverted bytes are the new baseline: drop any preserved draft.
    diffDrafts.value.delete(path);

    // Refresh the snapshot status and the git changes sequentially (each bumps
    // the epoch; firing them concurrently would make one loader drop its own
    // response and leave its spinner stuck), then re-open the diff against the
    // post-revert baseline.
    await loadSnapshot();
    if (source.value === "git") await loadChanges();
    // The session watcher closes the dialog on a session switch; reopening here
    // would pull the previous session's path into the new panel.
    if (workspace.value === id) await openDiff(path);
  } finally {
    diffReverting.value = false;
  }
}

async function saveDraft(): Promise<void> {
  // Wrapper for save file called from ReviewDialog in file mode
  await saveFile();
}

async function loadSnapshot(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  snapshotLoading.value = true;
  snapshotError.value = null;
  const outcome = await fetchSnapshotStatus(id);
  if (current !== epoch) return;
  snapshotLoading.value = false;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    snapshotStatus.value = null;
    return;
  }
  snapshotStatus.value = outcome.value;
}

async function saveFile(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  if (viewer.value === null || draft.value === null) return;
  // Only text, untruncated reads are editable. Guarding here as well keeps a
  // stray Save from overwriting a binary or truncated file with the empty
  // string the dialog was handed.
  if (!isEditableRead(viewer.value)) return;

  // Capture the current epoch without bumping it: the save belongs to the
  // epoch that opened the file, and a stale epoch drops the response.
  const current = epoch;
  saving.value = true;
  saveError.value = null;
  const outcome = await writeFile(id, viewer.value.path, draft.value, viewer.value.hash);
  if (current !== epoch) return;
  saving.value = false;
  if (!outcome.ok) {
    // A hash mismatch means the file changed under the operator since they
    // last read it: surface the runner's current bytes so they can adopt or
    // overwrite their draft instead of losing it to a silent overwrite.
    if (outcome.code === "FILE_CONFLICT") {
      const fresh = await readFile(id, viewer.value.path);
      // A session/workspace change while the fresh bytes were in flight means
      // they belong to the previous panel: drop them.
      if (current !== epoch) return;
      if (fresh.ok) {
        conflictIncoming.value = fresh.value;
      } else {
        // Network/parse failure fetching the fresh bytes: fall back to the
        // translated save error so the operator still sees a reason.
        saveError.value = outcome.message;
      }
      return;
    }
    saveError.value = outcome.message;
    return;
  }

  // A clean write clears any in-flight conflict. `viewerAfterSave` already
  // carries the written draft and the fresh hash, so the draft needs no
  // reassignment — and `FileWriteResult` has no `content` field to copy from.
  conflictIncoming.value = null;
  viewer.value = viewerAfterSave(viewer.value, draft.value, outcome.value);
  // Keep the viewer: the dialog is still open on this file and its header,
  // review state and revert target all read from it.
  void loadFiles(directory.value, { keepViewer: true });
}

/** Adopt the runner's version of the file, discarding the unsaved draft. */
async function adoptConflict(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const fresh = conflictIncoming.value;
  if (fresh === null) return;
  // Only text, untruncated files are editable — others keep the read-only
  // `<pre>` path and have no draft to clear.
  if (isEditableRead(fresh)) {
    draft.value = fresh.content;
  } else {
    draft.value = null;
  }
  viewer.value = fresh;
  conflictIncoming.value = null;
  saveError.value = null;
}

/**
 * Overwrite the runner's version with the draft, re-checking against the
 * freshest hash the runner currently holds.
 */
async function overwriteConflict(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  if (viewer.value === null || draft.value === null) return;
  const path = viewer.value.path;
  // Capture the epoch without bumping it: every continuation below belongs to
  // the panel state this call started from.
  const current = epoch;

  const latest = await readFile(id, path);
  if (current !== epoch) return;
  if (!latest.ok) {
    saveError.value = latest.message;
    return;
  }
  const outcome = await writeFile(id, path, draft.value, latest.value.hash);
  if (current !== epoch) return;
  if (!outcome.ok) {
    // A second hash mismatch keeps the banner: refetch the latest bytes again
    // so the adopt/overwrite buttons work against fresh state.
    if (outcome.code === "FILE_CONFLICT") {
      const fresh = await readFile(id, path);
      if (current !== epoch) return;
      if (fresh.ok) conflictIncoming.value = fresh.value;
    } else {
      saveError.value = outcome.message;
    }
    return;
  }

  conflictIncoming.value = null;
  saveError.value = null;
  // As in `saveFile`: the viewer carries the written draft, and the write
  // result has no `content` field.
  viewer.value = viewerAfterSave(latest.value, draft.value, outcome.value);
  void loadFiles(directory.value, { keepViewer: true });
}

async function revertOneFile(entry: { path: string; currentHash: string | null }): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  confirmingPath.value = null;
  const outcome = await revertFile(id, entry.path, entry.currentHash);
  if (current !== epoch) return;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    return;
  }
  // Sequential reloads: each bumps the epoch, so firing both at once leaves
  // one loader's spinner stuck on a dropped response.
  await loadSnapshot();
  if (source.value === "git") await loadChanges();
}

async function doRevertWorkspace(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  if (snapshotStatus.value === null) return;
  const applicable = canApplyPlan(snapshotStatus.value);
  if (!applicable.ok) {
    snapshotError.value = applicable.reason;
    return;
  }
  const current = ++epoch;
  workspaceRevertConfirm.value = false;
  const outcome = await revertWorkspace(id, snapshotStatus.value.digest ?? "");
  if (current !== epoch) return;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    return;
  }
  await loadSnapshot();
  if (source.value === "git") await loadChanges();
}

function goUp(): void {
  const parent = parentPath(directory.value);
  if (parent !== undefined) void loadFiles(parent);
}

// A different session is a different workspace: drop everything the previous
// one showed rather than presenting its contents under a new header. The key
// is a primitive so the rail's 15 s refresh — which replaces the session array
// but not this session's pin — does not reset the panel mid-navigation.
watch(
  () => `${props.sessionId}\u0000${workspace.value ?? ""}`,
  () => {
    // Cancel whatever was in flight: its response belongs to the previous
    // session's workspace and must not land in this one's panel.
    epoch += 1;
    directory.value = "";
    listing.value = null;
    viewer.value = null;
    filesError.value = null;
    filesLoading.value = false;
    fileNotice.value = null;
    draft.value = null;
    saving.value = false;
    saveError.value = null;
    conflictIncoming.value = null;
    changes.value = null;
    changesError.value = null;
    changesLoading.value = false;
    diffPath.value = null;
    diffError.value = null;
    diffLoading.value = false;
    diffOriginal.value = "";
    diffRead.value = null;
    diffModified.value = "";
    reviewed.value = new Set();
    reviewedPathHashes.value = new Map();
    diffDrafts.value = new Map();
    reviewDialogOpen.value = false;
    reviewSnapshotEntry.value = null;
    diffSaving.value = false;
    diffReverting.value = false;
    diffSaveError.value = null;
    snapshotStatus.value = null;
    snapshotError.value = null;
    snapshotLoading.value = false;
    confirmingPath.value = null;
    workspaceRevertConfirm.value = false;
    diagnostics.value = null;
    diagnosticsError.value = null;
    diagnosticsLoading.value = false;
    schedules.value = null;
    schedulesError.value = null;
    schedulesLoading.value = false;
    cancellingScheduleId.value = null;
    schedulesEpoch += 1;
    // The tab watcher does not fire for a session change, so a panel left on
    // the Lịch tab would keep the previous session's answer ("Chưa có lịch
    // nào.") until a manual refresh. Schedules are session-scoped, so reload
    // even while the new session has no pin yet.
    if (tab.value === "schedules") void loadSchedules();
    if (workspace.value !== null) void loadFiles("");
  },
  { immediate: true },
);

watch(tab, (next) => {
  if (workspace.value === null) return;
  if (next === "files" && listing.value === null) void loadFiles(directory.value);
  if (next === "changes") {
    if (source.value === "git" && changes.value === null) void loadChanges();
    if (source.value === "snapshot" && snapshotStatus.value === null) void loadSnapshot();
  }
  if (next === "diagnostics" && diagnostics.value === null) void loadDiagnostics();
  if (next === "schedules" && schedules.value === null) void loadSchedules();
});

watch(source, (next) => {
  if (workspace.value === null) return;
  if (next === "git" && changes.value === null) void loadChanges();
  if (next === "snapshot" && snapshotStatus.value === null) void loadSnapshot();
});
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-col bg-card/40">
    <nav class="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
      <button
        v-for="(label, key) in TAB_LABELS"
        :key="key"
        type="button"
        class="rounded-md px-2.5 py-1 font-mono text-xs transition-colors"
        :class="
          tab === key
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="tab = key"
      >
        {{ label }}
      </button>
    </nav>

    <div
      v-if="workspace === null"
      class="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
    >
      Chưa xác định được workspace của phiên này.
    </div>

    <div v-else class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2.5 font-mono text-xs">
      <!-- Files -->
      <template v-if="tab === 'files'">
        <div class="mb-2 flex flex-wrap items-center gap-1 text-muted-foreground">
          <button type="button" class="hover:text-foreground" @click="loadFiles('')">
            workspace
          </button>
          <template v-for="crumb in crumbs" :key="crumb.path">
            <span>/</span>
            <button type="button" class="hover:text-foreground" @click="loadFiles(crumb.path)">
              {{ crumb.name }}
            </button>
          </template>
        </div>

        <p v-if="filesLoading" class="text-muted-foreground">Đang tải…</p>
        <p v-else-if="filesError !== null" class="text-destructive">{{ filesError }}</p>

        <template v-else-if="listing !== null">
          <p
            v-if="fileNotice !== null"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            {{ fileNotice }}
          </p>
          <div class="mb-1.5 flex items-center justify-between gap-2 text-muted-foreground">
            <span>{{ entries.length }} mục</span>
            <button
              v-if="directory !== ''"
              type="button"
              class="text-primary hover:underline"
              @click="goUp"
            >
              lên trên
            </button>
          </div>
          <p
            v-if="listing.truncated"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            Danh sách đã được rút gọn — hiển thị 2000 mục đầu tiên.
          </p>
          <ul class="grid gap-0.5">
            <li v-for="entry in entries" :key="entry.name">
              <button
                type="button"
                class="flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-background/60"
                @click="openEntry(entry.name, entry.kind)"
              >
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="entry.kind === 'directory' ? 'text-primary' : 'text-foreground'"
                  :title="entry.name"
                >
                  {{ entry.name }}{{ entry.kind === "directory" ? "/" : "" }}
                </span>
                <span v-if="entry.kind === 'file'" class="shrink-0 text-muted-foreground">
                  {{ formatSize(entry.size) }}
                </span>
              </button>
            </li>
          </ul>
          <p v-if="entries.length === 0" class="text-muted-foreground">
            Thư mục trống.
          </p>
        </template>
      </template>

      <!-- Changes -->
      <template v-else-if="tab === 'changes'">
        <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
          <div class="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
            <span>So sánh:</span>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors"
              :class="
                source === 'git'
                  ? 'bg-primary/10 text-primary'
                  : 'hover:text-foreground'
              "
              @click="source = 'git'"
            >
              Git (HEAD)
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors"
              :class="
                source === 'snapshot'
                  ? 'bg-primary/10 text-primary'
                  : 'hover:text-foreground'
              "
              @click="source = 'snapshot'"
            >
              Lúc bắt đầu
            </button>
          </div>
          <template v-if="source === 'git'">
            <button
              type="button"
              class="shrink-0 whitespace-nowrap text-primary hover:underline"
              @click="loadChanges"
            >
              làm mới
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="shrink-0 whitespace-nowrap text-primary hover:underline"
              @click="loadSnapshot"
            >
              làm mới
            </button>
          </template>
        </div>

        <!-- Git source (existing view) -->
        <template v-if="source === 'git'">
          <p v-if="changesLoading" class="text-muted-foreground">Đang tải…</p>
          <p v-else-if="changesError !== null" class="text-destructive">{{ changesError }}</p>

          <template v-else-if="changes !== null">
            <!-- A failed diff keeps the list: only the diff failed, and the
                 operator can pick another file without losing their place. -->
            <p v-if="diffLoading" class="mb-1.5 text-muted-foreground">Đang tải diff…</p>
            <p v-else-if="diffError !== null" class="mb-1.5 text-destructive">{{ diffError }}</p>
            <p
              v-if="changes.truncated"
              class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
            >
              Danh sách đã được rút gọn — hiển thị 2000 thay đổi đầu tiên.
            </p>
            <ul class="grid gap-0.5">
              <li v-for="entry in changeEntries" :key="entry.path">
                <button
                  type="button"
                  class="flex min-w-0 w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-background/60"
                  @click="openDiff(entry.path)"
                >
                  <span
                    class="min-w-0 flex-1 truncate"
                    :title="entry.origPath ? `${entry.path} ← ${entry.origPath}` : entry.path"
                  >
                    {{ entry.path }}
                    <span v-if="entry.origPath" class="text-muted-foreground">← {{ entry.origPath }}</span>
                  </span>
                  <span class="shrink-0 text-muted-foreground">
                    {{ STATUS_LABELS[entry.status] ?? entry.status }}
                  </span>
                </button>
              </li>
            </ul>
            <p v-if="changeEntries.length === 0" class="text-muted-foreground">
              Working tree sạch — không có thay đổi nào.
            </p>
          </template>
        </template>

        <!-- Snapshot source (P3-B baseline) -->
        <template v-else>
          <p v-if="snapshotLoading" class="text-muted-foreground">Đang tải…</p>
          <p v-else-if="snapshotError !== null" class="text-destructive">{{ snapshotError }}</p>

          <template v-else-if="snapshotStatus !== null">
            <div v-if="snapshotStatus.baseline === null" class="text-muted-foreground">
              Chưa có bản chụp ban đầu.
            </div>

            <template v-else>
              <div class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-[11px] leading-relaxed">
                <div class="text-muted-foreground break-words">
                  Bản chụp: lượt
                  <span
                    class="font-mono text-foreground"
                    :title="snapshotStatus.baseline.attemptId"
                  >{{ snapshotStatus.baseline.attemptId.slice(0, 8) }}</span>
                  <template v-if="snapshotStatus.baseline.sessionId !== null">
                    — phiên
                    <span
                      class="font-mono text-foreground"
                      :title="snapshotStatus.baseline.sessionId"
                    >{{ snapshotStatus.baseline.sessionId.slice(0, 8) }}</span>
                  </template>
                  , {{ new Date(snapshotStatus.baseline.capturedAt).toLocaleString() }}
                </div>
                <div v-if="snapshotStatus.baseline.partial" class="text-destructive">
                  Bản chụp không đầy đủ.
                </div>
                <div v-if="snapshotStatus.truncated" class="text-destructive">
                  Danh sách thay đổi đã bị rút gọn.
                </div>
              </div>

              <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
                <span class="shrink-0 text-muted-foreground">
                  {{ snapshotStatus.entries.length }} mục
                </span>
                <button
                  v-if="summarisePlan(snapshotStatus).restores +
                         summarisePlan(snapshotStatus).deletions > 0"
                  type="button"
                  class="shrink-0 text-primary hover:underline"
                  @click="workspaceRevertConfirm = true"
                >
                  Khôi phục tất cả
                </button>
              </div>

              <ul class="grid gap-0.5">
                <li
                  v-for="entry in snapshotStatus.entries"
                  :key="entry.path"
                  class="flex min-w-0 w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-background/60"
                >
                  <button
                    type="button"
                    class="min-w-0 flex-1 truncate text-left hover:text-primary"
                    :title="entry.reason ? `${entry.path} — ${entry.reason}` : entry.path"
                    @click="source = 'git'; openDiff(entry.path)"
                  >
                    {{ entry.path }}
                    <span v-if="entry.reason" class="text-muted-foreground">
                      — {{ entry.reason }}
                    </span>
                  </button>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <span v-if="entry.status === 'modified'" class="text-muted-foreground">
                      sửa
                    </span>
                    <span v-else-if="entry.status === 'created'" class="text-muted-foreground">
                      thêm
                    </span>
                    <span v-else-if="entry.status === 'deleted'" class="text-muted-foreground">
                      xoá
                    </span>
                    <span v-else-if="entry.status === 'excluded'" class="text-muted-foreground">
                      loại trừ
                    </span>

                    <!-- Per-file revert with inline confirm. `confirmingPath` is
                         a ref unwrapped by the template: it IS the path, so the
                         confirm reads and writes the ref itself — `.value` here
                         would be the property of a string (undefined) when the
                         ref holds one, and a render-time TypeError when it
                         holds null, which is what tore the panel down. -->
                    <template v-if="entry.revertable && entry.status !== 'excluded'">
                      <template v-if="confirmingPath === entry.path">
                        <button
                          type="button"
                          class="text-destructive hover:underline"
                          @click="revertOneFile({ path: entry.path, currentHash: entry.currentHash })"
                        >
                          xác nhận
                        </button>
                      </template>
                      <template v-else>
                        <button
                          type="button"
                          class="text-primary hover:underline"
                          @click="confirmingPath = entry.path"
                        >
                          khôi phục
                        </button>
                      </template>
                    </template>
                  </span>
                </li>
              </ul>
            </template>
          </template>

          <!-- Workspace revert confirmation panel -->
          <div
            v-if="workspaceRevertConfirm && snapshotStatus !== null && snapshotStatus.baseline !== null"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          >
            <div class="w-full max-w-lg rounded-md border border-border/60 bg-card p-4 font-mono text-xs">
              <h3 class="mb-3 text-sm font-medium">Xác nhận khôi phục toàn bộ workspace</h3>
              <div v-if="snapshotStatus" class="mb-3 space-y-1 text-muted-foreground">
                <div>
                  Khôi phục: {{ summarisePlan(snapshotStatus).restores }} tệp
                </div>
                <div>Xóa: {{ summarisePlan(snapshotStatus).deletions }} tệp</div>
                <div>Xung đột: {{ summarisePlan(snapshotStatus).conflicts }} mục</div>
              </div>

              <div v-if="canApplyPlan(snapshotStatus).ok === false" class="mb-3 text-destructive">
                {{ (canApplyPlan(snapshotStatus) as { ok: false; reason: string }).reason }}
              </div>

              <div class="mb-3 max-h-60 overflow-y-auto">
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'modified' || e.status === 'deleted').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Khôi phục:</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'modified' || e.status === 'deleted').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'created').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Xóa:</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'created').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'excluded').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Xung đột (không thao tác):</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'excluded').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
              </div>

              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="px-3 py-1 text-muted-foreground hover:text-foreground"
                  @click="workspaceRevertConfirm = false"
                >
                  hủy
                </button>
                <button
                  type="button"
                  class="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
                  :disabled="!canApplyPlan(snapshotStatus).ok"
                  @click="doRevertWorkspace"
                >
                  Xác nhận khôi phục
                </button>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- Diagnostics -->
      <template v-else-if="tab === 'diagnostics'">
        <div class="mb-2 flex items-center justify-between gap-2 text-muted-foreground">
          <span>Cấu hình runner</span>
          <button type="button" class="text-primary hover:underline" @click="loadDiagnostics">
            làm mới
          </button>
        </div>

        <p v-if="diagnosticsLoading" class="text-muted-foreground">Đang tải…</p>
        <p v-else-if="diagnosticsError !== null" class="text-destructive">
          {{ diagnosticsError }}
        </p>

        <dl v-else-if="diagnostics !== null" class="grid gap-1.5">
          <template v-for="source in diagnostics.report.sources" :key="source.source">
            <div class="flex items-baseline justify-between gap-3">
              <dt class="shrink-0 text-muted-foreground">{{ source.source }}</dt>
              <dd class="min-w-0 flex-1 truncate text-right" :title="source.path">
                {{ source.exists ? (source.readable ? "đọc được" : "không đọc được") : "không có" }}
              </dd>
            </div>
          </template>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">Git</dt>
            <dd>{{ diagnostics.report.gitAvailable ? "có" : "không" }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">Xác thực provider</dt>
            <dd>{{ diagnostics.report.providerAuth }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">Môi trường chạy</dt>
            <dd>{{ diagnostics.report.runtime }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="shrink-0 text-muted-foreground">Thư mục gốc</dt>
            <dd class="min-w-0 flex-1 truncate text-right" :title="diagnostics.report.workspaceRoot">
              {{ diagnostics.report.workspaceRoot }}
            </dd>
          </div>
        </dl>

        <ul v-if="diagnostics?.report.warnings.length" class="mt-2 grid gap-1">
          <li
            v-for="warning in diagnostics.report.warnings"
            :key="warning"
            class="rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
          >
            {{ warning }}
          </li>
        </ul>
      </template>

      <!-- Schedules (§11.5): the control server owns what fires; the panel
           only lists what is still active and lets the operator cancel it. -->
      <template v-else>
        <div class="mb-2 flex items-center justify-between gap-2 text-muted-foreground">
          <span>Lịch chạy</span>
          <button type="button" class="text-primary hover:underline" @click="loadSchedules">
            làm mới
          </button>
        </div>

        <p v-if="schedulesLoading" class="text-muted-foreground">Đang tải…</p>
        <p v-else-if="schedulesError !== null" class="text-destructive">{{ schedulesError }}</p>

        <template v-else>
          <ul v-if="scheduleRows.length > 0" class="grid gap-1">
            <li
              v-for="row in scheduleRows"
              :key="row.scheduleId"
              class="rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <div class="break-words text-foreground">{{ row.promptPreview }}</div>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                <span>{{ row.cadence }}</span>
                <span>·</span>
                <span>{{ row.nextFireText }}</span>
                <code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{{
                  row.cron
                }}</code>
                <button
                  type="button"
                  class="ml-auto text-destructive hover:underline disabled:opacity-50"
                  :disabled="cancellingScheduleId !== null"
                  @click="cancelOneSchedule(row.scheduleId)"
                >
                  {{ cancellingScheduleId === row.scheduleId ? "đang huỷ…" : "Huỷ" }}
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="text-muted-foreground">Chưa có lịch nào.</p>
        </template>
      </template>
    </div>

    <!-- ReviewDialog integration -->
    <ReviewDialog
      v-model:open="reviewDialogOpen"
      :mode="reviewDialogMode"
      :path="reviewDialogMode === 'diff' ? (diffPath ?? '') : (viewer?.path ?? '')"
      :all-paths="reviewDialogMode === 'diff' ? changedPaths : (viewer ? [viewer.path] : [])"
      :original="diffOriginal ?? ''"
      :modified="diffModified ?? ''"
      :content="draft ?? ''"
      :is-reviewed="diffPath ? isReviewed(reviewed, diffPath, diffRead?.hash ?? '') : false"
      :is-path-reviewed="isPathReviewed"
      :dirty="reviewDialogMode === 'diff' ? diffDirty : (draft !== null && viewer !== null && draft !== viewer.content)"
      :error="reviewDialogMode === 'diff' ? diffSaveError : saveError"
      :conflict="reviewDialogMode === 'file' && conflictIncoming !== null"
      :saving="reviewDialogMode === 'diff' ? diffSaving : saving"
      :reverting="reviewDialogMode === 'diff' ? diffReverting : false"
      @update:modified="diffModified = $event"
      @update:content="draft = $event"
      @select-path="openDiff($event)"
      @save="reviewDialogMode === 'diff' ? saveDiff() : saveDraft()"
      @revert="reviewDialogMode === 'diff' ? (diffPath ? confirmRevert(diffPath) : undefined) : (viewer ? confirmRevert(viewer.path) : undefined)"
      @toggle-reviewed="diffPath && diffRead ? toggleReviewed(diffPath, diffRead.hash) : undefined"
      @adopt-conflict="adoptConflict"
      @overwrite-conflict="overwriteConflict"
    />
  </aside>
</template>
