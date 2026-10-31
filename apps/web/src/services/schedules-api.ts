/**
 * The schedule surface's HTTP half (§11.5): list a session's schedules,
 * cancel one by id.
 *
 * Pure mapping, no UI knowledge — same contract as runs-api: the client never
 * throws, ids are URL-encoded, and each status collapses into the one outcome
 * the panel can act on.
 */

import type { ScheduledTask } from "@cc-web/protocol";
import { authFetch } from "./auth-api.ts";

export type ListSchedulesResult =
  | { ok: true; schedules: ScheduledTask[] }
  | { ok: false; code: string; message: string };

export async function listSchedules(sessionId: string): Promise<ListSchedulesResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/schedules`);
  } catch {
    return { ok: false, code: "error", message: "Không kết nối được tới server." };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: "Phiên đăng nhập đã hết hạn." };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: `Không tải được lịch (HTTP ${response.status}).` };
  }

  try {
    const body = (await response.json()) as { schedules?: unknown };
    if (!Array.isArray(body.schedules)) {
      return { ok: false, code: "error", message: "Phản hồi lịch không hợp lệ." };
    }
    return { ok: true, schedules: body.schedules as ScheduledTask[] };
  } catch {
    return { ok: false, code: "error", message: "Phản hồi lịch không hợp lệ." };
  }
}

export type CancelScheduleResult = "cancelled" | "not_found" | "unauthorized" | "error";

export async function cancelSchedule(scheduleId: string): Promise<CancelScheduleResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    });
  } catch {
    return "error";
  }

  if (response.ok) return "cancelled";
  if (response.status === 404) return "not_found";
  if (response.status === 401) return "unauthorized";
  return "error";
}
