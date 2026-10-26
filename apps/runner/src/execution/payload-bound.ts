import { MAX_EVENT_PAYLOAD_BYTES } from "@cc-web/protocol";

/**
 * Bound one event's payload before it is persisted (§12.6).
 *
 * The transport refuses a frame larger than `WS_MAX_PAYLOAD_BYTES`. An event
 * whose own row exceeds that can never be delivered — and because the row is
 * durable, every replay is refused the same way: the connection closes and the
 * event comes back, forever. This is the bound the pump's "always send one
 * event, however large" guard assumes when it says the oversized event is
 * "bounded by the per-event caps elsewhere in the pipeline." There are none on
 * the generic path (`message.completed` from a raw SDK frame is whatever the
 * SDK emitted), so the cap is here, at the single writer every attempt event
 * passes through.
 *
 * The bound is a backstop, not a routine cut: the largest measured legitimate
 * event is 8,240 bytes, ~128× under the ceiling.
 *
 * Truncation is marked. A silently shortened transcript would violate §12.6's
 * rule against dropping mandatory content while reporting success; a reader of
 * the replayed event can see that text was cut.
 */

/** The marker appended to any string this module shortens. */
const TRUNCATION_MARKER = "…[truncated: event payload exceeded its byte ceiling]";

/** The starting per-string allowance. Halved on each pass until the event fits. */
const START_STRING_BYTES = 64 * 1024;

/** Below this a string carries no useful content, so the loop stops halving. */
const MIN_STRING_BYTES = 64;

/** Entries kept per array/object, so a pathological breadth is bounded too. */
const MAX_ENTRIES = 500;

/** Depth kept, so a pathological nesting cannot recurse without end. */
const MAX_DEPTH = 32;

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null");
}

/** Truncate a string to at most `cap` UTF-8 bytes, without splitting a char. */
function clampString(value: string, cap: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= cap) return value;
  // `toString` replaces a trailing partial sequence with U+FFFD; drop it so the
  // kept prefix is real text rather than a mojibake edge.
  const prefix = buffer
    .subarray(0, cap)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return prefix + TRUNCATION_MARKER;
}

/**
 * The same shape with every string over `cap` shortened and every container
 * limited in breadth and depth. Small scalars — the ids and types the browser
 * pairs events on — are copied verbatim.
 */
function clampValue(value: unknown, cap: number, depth: number): unknown {
  if (typeof value === "string") return clampString(value, cap);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return null;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map((item) => clampValue(item, cap, depth + 1));
  }

  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_ENTRIES) break;
    out[key] = clampValue(item, cap, depth + 1);
    kept += 1;
  }
  return out;
}

export function boundEventPayload(payload: unknown): unknown {
  // Identity for the common case: a small event pays for no copy at all.
  if (bytesOf(payload) <= MAX_EVENT_PAYLOAD_BYTES) return payload;

  // Halve the per-string allowance until the serialized event fits. Every pass
  // strictly shrinks the strings, so the loop terminates; the depth and breadth
  // clamps mean a payload that is over by sheer count is bounded from the first
  // pass rather than never.
  let cap = START_STRING_BYTES;
  for (;;) {
    const candidate = clampValue(payload, cap, 0);
    if (bytesOf(candidate) <= MAX_EVENT_PAYLOAD_BYTES) return candidate;
    if (cap <= MIN_STRING_BYTES) return clampValue(payload, MIN_STRING_BYTES, 0);
    cap = Math.max(MIN_STRING_BYTES, Math.floor(cap / 2));
  }
}
