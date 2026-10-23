/**
 * Pure helpers shared across apps.
 *
 * Must stay free of secrets, Node/Bun-specific APIs and SDK imports so it can
 * be imported by the web bundle. See ARCHITECTURE.md §4.2.
 */

/** Canonical JSON: stable key order, used for request fingerprints (§9.1). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
