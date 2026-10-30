import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  getSessionAttachment,
  getSessionAttachmentById,
  insertSessionAttachment,
  type SessionAttachmentRecord,
  sessionPin,
} from "@cc-web/control-db";
import type { AttachmentInfo } from "@cc-web/protocol";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * Attachment endpoints (§4.4 Task 3).
 *
 *   POST /api/sessions/:sessionId/attachments    — owner uploads one or more files
 *   GET  /api/attachments/:attachmentId           — owner downloads a file
 *   GET  /api/runner/attachments/:attachmentId    — runner downloads a file
 *
 * Auth mirrors every browser route: Origin allowlist first, then the session
 * cookie for browser routes. The runner route uses a Bearer token instead.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * `path.basename` strips any directory components a crafted `file.name` carries,
 * then the replace keeps only URL-safe characters — preventing both path traversal
 * and filesystem-unsafe names.
 */
function sanitizeName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Resolve the on-disk attachments directory, defaulting to `./data/attachments`
 * under the process CWD when the server was not given an explicit one.
 */
function resolveAttachmentsDir(options: ServerOptions): string {
  return options.attachmentsDir ?? join(process.cwd(), "data", "attachments");
}

/**
 * `POST /api/sessions/:sessionId/attachments`
 *
 * Parse a multipart upload, enforce per-file and total size limits, sanitize each
 * filename, write each file to `<attachmentsDir>/<sessionId>/<id>-<sanitizedName>`,
 * insert a metadata row per file, and answer with the `AttachmentInfo[]` the
 * browser needs to list the upload.
 */
export async function handleUploadAttachments(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  sessionId: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const pin = sessionPin(options.db, sessionId);
  if (pin === undefined || pin.ownerId !== authorized.userId) {
    // Existence is not another user's to learn: 404 before any other signal.
    return new Response("not found", { status: 404 });
  }

  let formData: { getAll: (name: string) => unknown[] };
  try {
    formData = await request.formData();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const all = formData.getAll("files");
  const files: File[] = [];
  for (const entry of all) {
    // Bun's FormData entry is a File when the field carried one; strings are
    // ignored so a stray non-file field does not become a pseudo-attachment.
    if (entry instanceof File && entry.name !== "") {
      files.push(entry);
    }
  }

  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return new Response("payload too large", { status: 413 });
    }
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  const attachmentsDir = resolveAttachmentsDir(options);
  const sessionDir = join(attachmentsDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const infos: AttachmentInfo[] = [];
  for (const file of files) {
    const attachmentId = crypto.randomUUID();
    const sanitized = sanitizeName(file.name);
    const storagePath = join(sessionDir, `${attachmentId}-${sanitized}`);

    const buffer = await file.arrayBuffer();
    writeFileSync(storagePath, Buffer.from(buffer));

    const mimeType = (file.type || "application/octet-stream").split(";")[0]!.trim();
    insertSessionAttachment(options.db, {
      id: attachmentId,
      sessionId,
      ownerId: authorized.userId,
      name: file.name,
      mimeType,
      size: file.size,
      storagePath,
      createdAt: Date.now(),
    });

    infos.push({ id: attachmentId, name: file.name, mimeType, size: file.size });
  }

  return new Response(JSON.stringify({ ok: true, attachments: infos }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `GET /api/attachments/:attachmentId`
 *
 * Serve an attachment to the session owner. The owner must match, and the file
 * must exist on disk. `image/*` types stream `inline`; everything else carries a
 * `Content-Disposition: attachment` header with the original filename.
 */
export async function handleGetAttachment(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  attachmentId: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const record = getSessionAttachment(options.db, attachmentId, authorized.userId);
  if (record === undefined) {
    return new Response("not found", { status: 404 });
  }

  return serveAttachment(record);
}

/**
 * `GET /api/runner/attachments/:attachmentId`
 *
 * Serve an attachment to the runner that owns the session it belongs to. Auth is a
 * Bearer token verified through `options.verifyRunnerCredential`; ownership is
 * checked via the session pin rather than the `owner_id` on the row, because the
 * runner reaches an attachment through its session, not through the owner.
 */
export async function handleGetRunnerAttachment(
  request: Request,
  options: ServerOptions,
  attachmentId: string,
): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (token === undefined) {
    return new Response("unauthorized", { status: 401 });
  }

  const runner = options.verifyRunnerCredential(token);
  if (!runner.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const record = getSessionAttachmentById(options.db, attachmentId);
  if (record === undefined) {
    return new Response("not found", { status: 404 });
  }

  const pin = sessionPin(options.db, record.sessionId);
  if (pin === undefined || pin.runnerId !== runner.runnerId) {
    return new Response("not found", { status: 404 });
  }

  return serveAttachment(record);
}

/**
 * Stream an attachment row from disk with the right Content-Type,
 * Content-Disposition, and a private cache directive.
 */
function serveAttachment(record: SessionAttachmentRecord): Response {
  if (!existsSync(record.storagePath)) {
    return new Response("not found", { status: 404 });
  }

  const data = readFileSync(record.storagePath);

  let contentDisposition: string;
  if (record.mimeType.startsWith("image/")) {
    contentDisposition = "inline";
  } else {
    contentDisposition = `attachment; filename="${record.name}"`;
  }

  return new Response(data, {
    headers: {
      "Content-Type": record.mimeType,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
