/**
 * Human size formatting for the Files panel (P3-A ruling 12).
 *
 * The runner reports byte counts; the panel shows them the way a file browser
 * does. Binary units, one decimal, a trailing `.0` dropped so a round number
 * does not read as a measurement.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatSize(bytes: number): string {
  // A negative or non-finite count is not a size; answer the empty one rather
  // than a nonsense string the panel would render verbatim.
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  if (value < 1024) return `${value} B`;

  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const rounded = Math.round(size * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}
