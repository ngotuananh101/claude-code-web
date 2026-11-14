import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The generated shadcn-vue Button carries `whitespace-nowrap` in its base class
 * (`components/ui/button/index.ts`, which this repo never hand-edits). That is
 * right for a one-line action button and wrong for an option row: the question
 * card renders each `AskUserQuestion` option as a full-width button whose
 * description is a sentence, so nowrap made the text run straight out of the
 * card — the label was clipped at the card edge and the description painted
 * over the session behind it.
 *
 * `bun test` cannot compile an SFC (no @vue/compiler-sfc), and no type or lint
 * gate can see a missing Tailwind utility, so the class list is pinned from the
 * source text — the same approach `scripts/caddyfile-csp.test.ts` takes for the
 * Caddyfile. The fix lives at the call site: `whitespace-normal` must beat the
 * generated `whitespace-nowrap` through `cn`'s merge.
 */
const SOURCE = new URL("./ApprovalCard.vue", import.meta.url).pathname;

/** The `<Button>` block that renders one question option, as source text. */
function optionButtonBlock(): string {
  const source = readFileSync(SOURCE, "utf8");
  const start = source.indexOf('<Button\n            v-for="option in q.options"');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("</Button>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ApprovalCard question options", () => {
  test("an option row wraps its text instead of inheriting the button's nowrap", () => {
    // Without this the label is clipped and the description overflows the card.
    expect(optionButtonBlock()).toContain("whitespace-normal");
  });

  test("an option row lets a long unbreakable token break", () => {
    // Descriptions name paths like tools/fetch_external_tools.sh; a single
    // long token with no break opportunity would still overflow.
    expect(optionButtonBlock()).toContain("break-words");
  });
});
