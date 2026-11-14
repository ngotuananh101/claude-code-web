import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The spawning step's badge is the main screen's only view of a background
 * subagent, and it used to carry the subagent's *current tool name*
 * (`task.lastToolName`). For a Workflow run that value is not a tool at all —
 * the SDK cycled it through each child's label ("Scout: plan-critique" →
 * "Scout: ytdlp-discovery") — so the row renamed itself while the four other
 * children stayed invisible, and every subagent's tool activity read as one
 * line on the main screen instead of a transcript in its inspector.
 *
 * The rule now: a subagent's tool history lives in the inspector only. The
 * badge keeps the status dot, the elapsed clock, and the way in; nothing else.
 *
 * `bun test` cannot compile an SFC (no @vue/compiler-sfc) and no type or lint
 * gate can catch a field reintroduced into a template, so the badge is pinned
 * from the source text — the same approach `ApprovalCard.test.ts` takes.
 */
const SOURCE = new URL("./AgentToolStep.vue", import.meta.url).pathname;

/** The spawning-step badge block, as source text. */
function badgeBlock(): string {
  const source = readFileSync(SOURCE, "utf8");
  const start = source.indexOf("<!--\n          Spawning-step badge");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("<!-- Status badge. -->", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("AgentToolStep spawning badge", () => {
  test("does not print the subagent's current tool name on the main screen", () => {
    // `lastToolName` is the subagent's activity; it belongs to its inspector.
    expect(badgeBlock()).not.toContain("lastToolName");
  });

  test("always offers the way into the subagent's inspector", () => {
    // Without a tool name the button is the only affordance left, and it must
    // stay reachable for a spawning step the journal has no task row for yet.
    const block = badgeBlock();
    expect(block).toContain(":title=\"t('subagentTree.inspectSubagent')\"");
    expect(block).toContain("emit('inspectSubagent'");
  });
});
