/**
 * Attachments HTTP surface (Task 5).
 *
 * `uploadSessionAttachments` posts one or more files to a session's attachments
 * endpoint as multipart/form-data — the upload happens against the control
 * server, not the runner directly, so the files land on the runner's filesystem
 * during the run rather than on the web host.
 */

import type { AttachmentInfo } from "@cc-web/protocol";
import { authFetch } from "./auth-api.ts";

/** A successful upload: the server echoes the metadata it stored per file. */
export type UploadAttachmentsOutcome =
  | { ok: true; attachments: AttachmentInfo[] }
  | { ok: false; message: string };

/** The Vietnamese copy for a 413 payload-too-large refusal. */
const SIZE_LIMIT_MESSAGE = "Kích thước tệp quá giới hạn cho phép (tối đa 20MB/tệp, 50MB tổng cộng)";

/** Generic fallback for a non-JSON or network failure — never throws. */
const UNREACHABLE_MESSAGE = "Không thể tải tệp lên.";

/**
 * Upload files to a session's attachments endpoint.
 *
 * Uses authFetch (transparent token refresh) and FormData so each file rides
 * as its own `files` entry. The session id travels in the URL (§19.4), never
 * the form. A 201 yields the server's attachment metadata list; a 413 yields
 * the operator-facing Vietnamese size message; any other failure yields a
 * message extracted from the JSON body or the generic fallback — without throwing.
 */
export async function uploadSessionAttachments(
  sessionId: string,
  files: File[],
): Promise<UploadAttachmentsOutcome> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }

  let response: Response;
  try {
    response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      body: form,
    });
  } catch {
    return { ok: false, message: UNREACHABLE_MESSAGE };
  }

  if (response.status === 201) {
    const data = (await response.json()) as { attachments?: AttachmentInfo[] };
    return { ok: true, attachments: data.attachments ?? [] };
  }

  if (response.status === 413) {
    return { ok: false, message: SIZE_LIMIT_MESSAGE };
  }

  if (!response.ok) {
    let message = UNREACHABLE_MESSAGE;
    try {
      const data = (await response.json()) as { message?: string };
      if (typeof data.message === "string" && data.message !== "") {
        message = data.message;
      }
    } catch {
      // Non-JSON body — keep the generic message.
    }
    return { ok: false, message };
  }

  return { ok: false, message: UNREACHABLE_MESSAGE };
}

/**
 * Build the URL a view uses to fetch a single attachment by id.
 *
 * The id is URL-encoded because it is an untrusted server value; a `;` or `/`'
 * in it must not escape the final path segment.
 */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}
