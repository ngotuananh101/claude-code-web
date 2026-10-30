/**
 * Attachment metadata and session cleanup for the file-attachments feature.
 *
 * `AttachmentInfo` and `RunnerAttachmentItem` describe the wire shape of one
 * attachment as it is listed or sent back from a runner. They overlap because
 * the runner is the only producer of both a list of attachments and an inline
 * per-message attachment set, and the two shapes are the same set of fields.
 *
 * `SessionCleanupRequest` / `SessionCleanupResult` are the request and answer
 * for the `session.cleanup` command kind, which asks a runner to reclaim a
 * session's attachments after the session has finished (§session-cleanup).
 */

/** Metadata describing one attachment on the wire. */
export type AttachmentInfo = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

/** One attachment entry in a runner's inline attachment list. */
export type RunnerAttachmentItem = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

/** The server's request to clean up a finished session's attachments. */
export type SessionCleanupRequest = {
  sessionId: string;
};

/** The runner's answer to a `session.cleanup` command. */
export type SessionCleanupResult = {
  ok: boolean;
  error?: string;
};

/**
 * Parse an unknown value into `AttachmentInfo`, returning `undefined` when the
 * value does not match the expected shape.
 *
 * This sits at an untrusted boundary (§9.1's pattern): the value comes off the
 * wire and may be anything. Unknown keys are dropped so that a field nobody
 * defined cannot ride along.
 */
export function parseAttachmentInfo(value: unknown): AttachmentInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const id = record["id"];
  const name = record["name"];
  const mimeType = record["mimeType"];
  const size = record["size"];

  if (typeof id !== "string" || id === "") return undefined;
  if (typeof name !== "string") return undefined;
  if (typeof mimeType !== "string") return undefined;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return undefined;

  return { id, name, mimeType, size };
}

/**
 * Parse a runner's inline attachment list into typed items.
 *
 * `undefined` is read as an absent field, not a malformed payload, and returns
 * an empty list — a runner that has nothing to attach must not make the whole
 * envelope unparseable. If any element fails `parseAttachmentInfo`, the entire
 * list is refused: a partially understood batch would let one bad entry look
 * like a complete set of attachments.
 */
export function parseRunnerAttachmentItems(value: unknown): RunnerAttachmentItem[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;

  const items: RunnerAttachmentItem[] = [];
  for (const entry of value) {
    const parsed = parseAttachmentInfo(entry);
    if (parsed === undefined) return undefined;
    items.push(parsed);
  }
  return items;
}

/**
 * Parse a `session.cleanup` request payload.
 *
 * `undefined` is the refusal signal, matching the other protocol parsers.
 * Unknown keys are dropped so a field nobody defined cannot ride along.
 */
export function parseSessionCleanupRequest(value: unknown): SessionCleanupRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const sessionId = record["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") return undefined;

  return { sessionId };
}
