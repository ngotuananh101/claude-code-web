import type { Database } from "bun:sqlite";
import type { UsageDay, UsageStats } from "@cc-web/protocol";

/**
 * The dashboard's read model over the journal: token usage plus volume
 * counts, all owner-scoped.
 *
 * Usage lives on `message.completed` payloads — the SDK's assistant messages
 * carry `message.usage` with the API's token accounting, and the runner's
 * redactor keeps token counts while stripping cost figures (§19.4). The
 * `result` frame repeats the whole turn's totals, so reading anything but
 * assistant messages would double-count.
 */

export type { UsageDay, UsageStats, UsageTotals } from "@cc-web/protocol";

const USAGE_COLUMNS = `
  CAST(COALESCE(SUM(json_extract(e.payload, '$.message.usage.input_tokens')), 0) AS INTEGER)              AS input_tokens,
  CAST(COALESCE(SUM(json_extract(e.payload, '$.message.usage.cache_read_input_tokens')), 0) AS INTEGER)   AS cache_read_tokens,
  CAST(COALESCE(SUM(json_extract(e.payload, '$.message.usage.cache_creation_input_tokens')), 0) AS INTEGER) AS cache_creation_tokens,
  CAST(COALESCE(SUM(json_extract(e.payload, '$.message.usage.output_tokens')), 0) AS INTEGER)             AS output_tokens`;

type UsageRow = {
  day: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
};

export function usageStats(
  db: Database,
  ownerId: string,
  options: { days?: number; now?: number } = {},
): UsageStats {
  const days = options.days ?? 14;
  const now = options.now ?? Date.now();

  const totalsRow = db
    .prepare(
      `SELECT ${USAGE_COLUMNS}
       FROM run_events e
       JOIN runners r ON r.id = e.runner_id
       WHERE r.owner_id = ? AND e.type = 'message.completed'`,
    )
    .get(ownerId) as {
    input_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    output_tokens: number;
  };

  const dailyRows = db
    .prepare(
      `SELECT date(e.occurred_at) AS day, ${USAGE_COLUMNS}
       FROM run_events e
       JOIN runners r ON r.id = e.runner_id
       WHERE r.owner_id = ? AND e.type = 'message.completed'
       GROUP BY day`,
    )
    .all(ownerId) as UsageRow[];

  const byDay = new Map(dailyRows.map((row) => [row.day, row]));

  // Zero-fill the window so the chart shows gaps as gaps, not as missing bars.
  const daily: UsageDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
    const row = byDay.get(day);
    daily.push({
      day,
      inputTokens: row?.input_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      cacheCreationTokens: row?.cache_creation_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
    });
  }

  // Sessions and runs count what the journal (or the dispatch table, for a
  // run in flight that has not journaled its first event yet) holds; events
  // counts every row of every type.
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM (
            SELECT e.session_id AS id FROM run_events e
              JOIN runners r ON r.id = e.runner_id WHERE r.owner_id = ?
            UNION
            SELECT a.session_id AS id FROM active_runs a
              JOIN runners r ON r.id = a.runner_id WHERE r.owner_id = ?
         ) AS u) AS sessions,
         (SELECT COUNT(*) FROM (
            SELECT e.run_id AS id FROM run_events e
              JOIN runners r ON r.id = e.runner_id WHERE r.owner_id = ?
            UNION
            SELECT a.run_id AS id FROM active_runs a
              JOIN runners r ON r.id = a.runner_id WHERE r.owner_id = ?
         ) AS u) AS runs,
         (SELECT COUNT(*) FROM run_events e
            JOIN runners r ON r.id = e.runner_id WHERE r.owner_id = ?) AS events`,
    )
    .get(ownerId, ownerId, ownerId, ownerId, ownerId) as {
    sessions: number;
    runs: number;
    events: number;
  };

  return {
    totals: {
      inputTokens: totalsRow.input_tokens,
      cacheReadTokens: totalsRow.cache_read_tokens,
      cacheCreationTokens: totalsRow.cache_creation_tokens,
      outputTokens: totalsRow.output_tokens,
    },
    daily,
    sessions: counts.sessions,
    runs: counts.runs,
    events: counts.events,
  };
}
