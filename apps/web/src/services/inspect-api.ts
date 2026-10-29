/**
 * The inspection surface's HTTP half (§17.1, §23 §10): files, a file, changes,
 * a diff, and configuration diagnostics.
 *
 * Pure mapping, like `runs-api.ts` — no component parses a body meant for a
 * person. Two rules shape the module:
 *
 *  - **Never throw.** A panel that has to wrap every call in try/catch is a
 *    panel that will forget one; a network failure is just another outcome.
 *  - **Known runner codes become Vietnamese copy**, because that is the
 *    language the UI speaks. An unknown code keeps the server's own message —
 *    inventing copy for a code nobody defined would hide the runner's reason.
 */

import type {
  DiagnosticsResult,
  FileListResult,
  FileReadResult,
  FileRevertResult,
  FileWriteResult,
  GitChangesResult,
  GitDiffResult,
  SnapshotStatusResult,
  WorkspaceRevertResult,
} from "@cc-web/protocol";
import { authFetch } from "./auth-api.ts";

export type InspectOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/**
 * The composite `<runnerId>/<workspaceId>` as **one URL path segment**.
 *
 * The whole composite is encoded, not each half: a raw `/` between them would
 * make the id two path segments and the route would never match (T9's ruling).
 */
export function compositeId(runnerId: string, workspaceId: string): string {
  return encodeURIComponent(`${runnerId}/${workspaceId}`);
}

/** Operator-facing Vietnamese copy for the codes the runner and server define. */
const MESSAGES: Record<string, string> = {
  RUNNER_UNAVAILABLE: "Runner không sẵn sàng.",
  WORKSPACE_NOT_FOUND: "Không tìm thấy workspace.",
  WORKSPACE_AMBIGUOUS: "Mã workspace không hợp lệ.",
  PATH_OUTSIDE_WORKSPACE: "Đường dẫn nằm ngoài workspace.",
  FILE_NOT_FOUND: "Không tìm thấy tệp.",
  FILE_UNREADABLE: "Không thể đọc tệp.",
  CREDENTIAL_FILE_REFUSED: "Không được phép đọc tệp chứa thông tin đăng nhập.",
  NOT_A_DIRECTORY: "Đường dẫn không phải thư mục.",
  NOT_A_FILE: "Đường dẫn không phải tệp.",
  UNSUPPORTED_COMMAND: "Runner không hỗ trợ yêu cầu này.",
  DIAGNOSTICS_UNAVAILABLE: "Không lấy được chẩn đoán cấu hình.",
  FILE_CONFLICT: "Tệp đã bị thay đổi — hãy tải lên và thử lại.",
  WORKSPACE_BUSY: "Workspace đang bận — hãy thử lại sau.",
  SYMLINK_REFUSED: "Không được phép thao tác liên kết mềm.",
  FILE_UNSUPPORTED: "Loại tệp này không được hỗ trợ.",
  NO_SNAPSHOT: "Chưa có baseline cho workspace này.",
  SNAPSHOT_PARTIAL: "Baseline chưa đầy đủ — không thể khôi phục toàn bộ.",
  REVERT_STALE: "Kế hoạch khôi phục đã cũ — hãy xem lại.",
  PLAN_TOO_LARGE: "Kế hoạch khôi phục quá lớn — không thể áp dụng.",
  SNAPSHOT_INCOMPARABLE: "Baseline không so sánh được với trạng thái hiện tại.",
  FILE_UNWRITABLE: "Không thể ghi tệp.",
};

/** The copy for a transport or parse failure — there is no code to translate. */
const UNREACHABLE = { code: "error", message: "Không kết nối được máy chủ." } as const;

/** §17.3's body, read defensively: a shape we cannot read is not a crash. */
function readErrorBody(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    ...(typeof record["message"] === "string" ? { message: record["message"] } : {}),
  };
}

async function failure(response: Response): Promise<InspectOutcome<never>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A plain-text refusal (401/403 keep that convention on the server) or a
    // proxy's HTML error page: nothing to translate, so answer generically.
    return { ok: false, ...UNREACHABLE };
  }

  const parsed = readErrorBody(body);
  const code = parsed.code ?? UNREACHABLE.code;
  const message =
    MESSAGES[code] ??
    (parsed.message !== undefined && parsed.message !== "" ? parsed.message : UNREACHABLE.message);

  return { ok: false, code, message };
}

async function request<T>(url: string, init?: RequestInit): Promise<InspectOutcome<T>> {
  let response: Response;
  try {
    response = await authFetch(url, init);
  } catch {
    return { ok: false, ...UNREACHABLE };
  }

  if (!response.ok) return failure(response);

  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    // A 200 whose body is not JSON is a broken server, not a panel bug.
    return { ok: false, ...UNREACHABLE };
  }
}

/**
 * Build a JSON-bodied request and answer it through the same never-throw spine
 * as `request`: an `UNREACHABLE` (network/parse) failure, or the server's own
 * translated error. No call site needs its own try/catch.
 */
async function mutate<T>(
  url: string,
  method: "PUT" | "POST",
  body: unknown,
): Promise<InspectOutcome<T>> {
  return request<T>(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listFiles(id: string, path: string): Promise<InspectOutcome<FileListResult>> {
  return request(`/api/workspaces/${id}/files?path=${encodeURIComponent(path)}`);
}

export function readFile(id: string, path: string): Promise<InspectOutcome<FileReadResult>> {
  return request(`/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`);
}

export function fetchChanges(id: string): Promise<InspectOutcome<GitChangesResult>> {
  return request(`/api/workspaces/${id}/changes`);
}

export function fetchDiff(id: string, path: string): Promise<InspectOutcome<GitDiffResult>> {
  return request(`/api/workspaces/${id}/diff?path=${encodeURIComponent(path)}`);
}

export function fetchDiagnostics(id: string): Promise<InspectOutcome<DiagnosticsResult>> {
  return request(`/api/workspaces/${id}/config/diagnostics`);
}

/** (§7.10) A revision-checked save of one file's contents. */
export function writeFile(
  id: string,
  path: string,
  content: string,
  expectedHash: string,
): Promise<InspectOutcome<FileWriteResult>> {
  return mutate(`/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`, "PUT", {
    content,
    expectedHash,
  });
}

/** (§7.10) Restore one file to its baseline, or delete a file the baseline says was created. */
export function revertFile(
  id: string,
  path: string,
  expectedHash: string | null,
): Promise<InspectOutcome<FileRevertResult>> {
  return mutate(`/api/workspaces/${id}/file/revert`, "POST", { path, expectedHash });
}

/** (§7.10) Restore the whole workspace to its run-start baseline, conditioned on the reviewed plan digest. */
export function revertWorkspace(
  id: string,
  planDigest: string,
): Promise<InspectOutcome<WorkspaceRevertResult>> {
  return mutate(`/api/workspaces/${id}/revert`, "POST", { planDigest });
}

/** (§7.10) Preview the current baseline and the per-file revert plan it yields. */
export function fetchSnapshotStatus(id: string): Promise<InspectOutcome<SnapshotStatusResult>> {
  return request(`/api/workspaces/${id}/snapshot`);
}
