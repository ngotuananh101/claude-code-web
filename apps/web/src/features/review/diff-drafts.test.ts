import { describe, expect, test } from "bun:test";
import { draftAfterNavigation, rememberDraft } from "./diff-drafts.ts";

describe("diff draft preservation", () => {
  test("rememberDraft stores a dirty draft and drops a clean one", () => {
    const drafts = new Map<string, string>();

    expect(rememberDraft(drafts, "src/a.ts", "edited", "server")).toBe(true);
    expect(drafts.get("src/a.ts")).toBe("edited");

    // Editing back to the server content is clean: no draft to preserve.
    expect(rememberDraft(drafts, "src/a.ts", "server", "server")).toBe(false);
    expect(drafts.has("src/a.ts")).toBe(false);
  });

  test("draftAfterNavigation prefers the stored draft over server content", () => {
    const drafts = new Map([["src/a.ts", "edited"]]);

    expect(draftAfterNavigation(drafts, "src/a.ts", "server")).toBe("edited");
    expect(draftAfterNavigation(drafts, "src/b.ts", "server")).toBe("server");
  });
});
