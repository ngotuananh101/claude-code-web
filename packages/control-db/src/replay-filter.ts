/**
 * The journal projection omits only SDK thinking-token progress estimates.
 * Keep unknown statuses, task activity, message content and accounting intact.
 * This predicate also backs the partial replay index in db.ts; sharing the SQL
 * makes the index usable without a per-open scan of omitted payloads.
 * Missing/null fields and malformed legacy JSON are not telemetry.
 */
export const JOURNAL_EVENT_SQL = `CASE
  WHEN type = 'run.status' AND json_valid(payload)
  THEN COALESCE(json_extract(payload, '$.type') = 'system'
    AND json_extract(payload, '$.subtype') = 'thinking_tokens', 0)
  ELSE 0
END = 0`;
