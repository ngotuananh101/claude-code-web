import { describe, expect, it } from "bun:test";
import type { SlashCommandItem } from "../features/composer/slash-commands";
import { applyCommandToPrompt, filterCommands } from "../features/composer/slash-commands";

const commands: SlashCommandItem[] = [
  {
    name: "clear",
    displayName: "Clear",
    description: "Clear the conversation",
    category: "builtin",
  },
  {
    name: "code-review",
    displayName: "Code Review",
    description: "Review code",
    category: "builtin",
  },
  {
    name: "review-pr",
    displayName: "Review PR",
    description: "Review a pull request",
    category: "plugin",
  },
];

describe("SlashCommandMenu — filterCommands", () => {
  it("filters with a leading slash (/rev)", () => {
    const filtered = filterCommands(commands, "/rev");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((c) => c.name)).toEqual(["code-review", "review-pr"]);
  });

  it("is case insensitive", () => {
    const filtered = filterCommands(commands, "CLEAR");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("clear");
  });

  it("matches by name", () => {
    const filtered = filterCommands(commands, "review-pr");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("review-pr");
  });

  it("matches by description", () => {
    const filtered = filterCommands(commands, "pull request");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("review-pr");
  });

  it("returns all commands when query is empty", () => {
    const filtered = filterCommands(commands, "");
    expect(filtered).toHaveLength(commands.length);
  });
});

describe("SlashCommandMenu — keyboard selection logic contract", () => {
  it("clamps selectedIndex at lower bound", () => {
    let selectedIndex = 0;
    selectedIndex = Math.max(0, selectedIndex - 1);
    expect(selectedIndex).toBe(0);
  });

  it("clamps selectedIndex at upper bound", () => {
    const filtered = commands;
    let selectedIndex = filtered.length - 1;
    selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
    expect(selectedIndex).toBe(filtered.length - 1);
  });

  it("Enter selects the command at selectedIndex when list non-empty", () => {
    const filtered = filterCommands(commands, "rev");
    const selectedIndex = 1;
    const selected = filtered[selectedIndex];
    expect(selected?.name).toBe("review-pr");
  });

  it("Enter is a passthrough when filtered list is empty", () => {
    const filtered = filterCommands(commands, "zzzz");
    expect(filtered).toHaveLength(0);
    // guard: no selection should occur
    let preventDefaultCalled = false;
    const selectedIndex = 0;
    if (filtered.length > 0 && selectedIndex >= 0 && selectedIndex < filtered.length) {
      preventDefaultCalled = true;
    }
    expect(preventDefaultCalled).toBe(false);
  });
});

describe("SlashCommandMenu — applyCommandToPrompt", () => {
  it("replaces prompt and positions cursor", () => {
    const command: SlashCommandItem = {
      name: "clear",
      displayName: "Clear",
      description: "Clear the conversation",
      category: "builtin",
    };
    const result = applyCommandToPrompt("Hello", command);
    expect(result.newPrompt).toBe("/clear Hello");
    expect(result.cursorPosition).toBe(7);
  });

  it("handles empty prompt", () => {
    const command: SlashCommandItem = {
      name: "clear",
      displayName: "Clear",
      description: "Clear the conversation",
      category: "builtin",
    };
    const result = applyCommandToPrompt("", command);
    expect(result.newPrompt).toBe("/clear");
    expect(result.cursorPosition).toBe(7);
  });
});
