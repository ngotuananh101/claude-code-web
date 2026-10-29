/**
 * The workspace discovery surface's HTTP half (§23, Task 10): directory browsing
 * and workspace registration against a runner.
 *
 * Pure mapping, like `runs-api.ts` and `inspect-api.ts` — which statuses collapse
 * into which operator-facing outcome is decided here so a component never parses a
 * body meant for a person. Two rules shape the module:
 *
 * - **Never throw.** A panel that has to wrap every call in try/catch is a panel
 *   that will forget one; a network failure is just another outcome.
 * - **Known runner codes become Vietnamese copy.** An unknown code keeps the
 *   server's own message — inventing copy for a code nobody defined would hide the
 *   runner's reason.
 */

import type { FsBrowseResult } from "@cc-web/protocol";
import { authFetch } from "./auth-api.ts";

export type BrowseOutcome =
  | { ok: true; value: FsBrowseResult }
  | { ok: false; code: string; message: string };

export type RegisterWorkspaceOutcome =
  | { ok: true; value: { workspaceId: string; path: string; runnerId: string } }
  | { ok: false; code: string; message: string };

type ApiError = { ok: false; code: string; message: string };

/**
 * Compose the `<runnerId>/<workspaceId>` composite id into one URL path segment.
 *
 * The whole composite is encoded, not each half: a raw `/` between them would make
 * the id two path segments and the route would never match. Exported so callers
 * that already hold a runner id can build the id for a workspace-scoped call
 * without re-encoding.
 */
export function compositeId(runnerId: string, workspaceId: string): string {
  return encodeURIComponent(`${runnerId}/${workspaceId}`);
}

/** Operator-facing Vietnamese copy for the codes the runner and server define. */
const MESSAGES: Record<string, string> = {
  RUNNER_UNAVAILABLE: "Runner không sẵn sàng.",
  RUNNER_NOT_FOUND: "Runner không sẵn sàng.",
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

async function failure(response: Response): Promise<ApiError> {
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

/**
 * The never-throw spine shared by both calls: a transport/parse failure is a
 * generic outcome, or the server's own translated error. No call site needs its
 * own try/catch.
 */
export async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | ApiError> {
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

async function mutate<T>(url: string, body: unknown): Promise<{ ok: true; value: T } | ApiError> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Build a relative URL with a percent-encoded path query value. */
function buildBrowseUrl(runnerId: string, path: string | undefined): string {
  const q = encodeURIComponent(path ?? "");
  return `/api/runners/${encodeURIComponent(runnerId)}/browse?path=${q}`;
}

/**
 * Browse the directory on the runner host (§23). The path is a relative query
 * value; the runner resolves it against its workspace root (Task 3). When `path`
 * is omitted the browse payload omits it, which the runner resolves to its root.
 */
export function fetchDirectory(runnerId: string, path?: string): Promise<BrowseOutcome> {
  return request<FsBrowseResult>(buildBrowseUrl(runnerId, path));
}

/**
 * Register a custom path under a runner so it is addressable by a stable
 * composite id (§15.1). `workspaceId` is optional and minted by the server when
 * absent; a client-supplied id is forwarded in the body.
 */
export function registerWorkspace(
  runnerId: string,
  path: string,
  workspaceId?: string,
): Promise<RegisterWorkspaceOutcome> {
  const body: Record<string, unknown> = { path };
  if (workspaceId !== undefined) body["workspaceId"] = workspaceId;

  const result = mutate<{ workspaceId: string; path: string; runnerId: string }>(
    `/api/runners/${encodeURIComponent(runnerId)}/workspaces`,
    body,
  );
  return result.then((r) =>
    r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, message: r.message },
  );
}
