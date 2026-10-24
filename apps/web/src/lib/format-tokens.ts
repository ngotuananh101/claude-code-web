/**
 * Dashboard token numbers: 999 stays exact, then K/M/B with the fewest
 * decimals that still say something. Called per render on KPI cards.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const units: Array<[bigint, string]> = [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ];
  const value = BigInt(tokens);
  for (const [size, suffix] of units) {
    if (value >= size) {
      const decimals = suffix === "K" ? 1 : 2;
      const scaled = Number(value) / Number(size);
      return `${trimTo(scaled, decimals)}${suffix}`;
    }
  }
  return String(tokens);
}

function trimTo(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}
