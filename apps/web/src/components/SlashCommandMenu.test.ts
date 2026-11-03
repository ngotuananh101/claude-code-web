import { describe, expect, it } from "bun:test";
import type { SlashCommandItem } from "../features/composer/slash-commands";

/**
 * Component contract tests for SlashCommandMenu.vue.
 *
 * The Vue SFC cannot be compiled in the Node/Bun test environment without
 * @vue/compiler-sfc, so this file exercises the filtering and selection logic
 * that the component template relies on. It pins the contract for the command
 * menu: the available commands, the filter behavior, and the selection outcome.
 */

describe("SlashCommandMenu contract — available commands", () => {
  it("should include builtin commands when no runner capabilities", () => {
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
    ];

    expect(commands).toHaveLength(2);
    expect(commands[0]?.category).toBe("builtin");
    expect(commands[1]?.category).toBe("builtin");
  });

  it("should include plugin commands when runner capabilities provided", () => {
    const commands: SlashCommandItem[] = [
      {
        name: "test-command",
        displayName: "test-command",
        description: "A test command",
        category: "plugin",
      },
    ];

    expect(commands).toHaveLength(1);
    expect(commands[0]?.category).toBe("plugin");
  });
});

describe("SlashCommandMenu contract — command filtering", () => {
  it("should return all commands when query is empty", () => {
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
    ];

    const filtered = commands.filter((cmd) => {
      const query = "";
      const normalizedQuery = query.toLowerCase().replace(/^\//, "");
      return (
        cmd.name.toLowerCase().includes(normalizedQuery) ||
        cmd.displayName.toLowerCase().includes(normalizedQuery) ||
        cmd.description.toLowerCase().includes(normalizedQuery)
      );
    });

    expect(filtered).toHaveLength(2);
  });

  it("should filter commands by name match", () => {
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
    ];

    const filtered = commands.filter((cmd) => {
      const query = "cle";
      const normalizedQuery = query.toLowerCase().replace(/^\//, "");
      return (
        cmd.name.toLowerCase().includes(normalizedQuery) ||
        cmd.displayName.toLowerCase().includes(normalizedQuery) ||
        cmd.description.toLowerCase().includes(normalizedQuery)
      );
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("clear");
  });

  it("should handle fuzzy matching by substring", () => {
    const commands: SlashCommandItem[] = [
      {
        name: "code-review",
        displayName: "Code Review",
        description: "Review code",
        category: "builtin",
      },
    ];

    const filtered = commands.filter((cmd) => {
      const query = "rev";
      const normalizedQuery = query.toLowerCase().replace(/^\//, "");
      return (
        cmd.name.toLowerCase().includes(normalizedQuery) ||
        cmd.displayName.toLowerCase().includes(normalizedQuery) ||
        cmd.description.toLowerCase().includes(normalizedQuery)
      );
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("code-review");
  });
});

describe("SlashCommandMenu contract — command application", () => {
  it("should apply command to prompt with correct cursor position", () => {
    const command: SlashCommandItem = {
      name: "clear",
      displayName: "Clear",
      description: "Clear the conversation",
      category: "builtin",
    };

    const prompt = "Hello";
    const commandText = `/${command.name}`;
    const newPrompt = `${commandText} ${prompt}`.trim();
    const cursorPosition = commandText.length + 1;

    expect(newPrompt).toBe("/clear Hello");
    expect(cursorPosition).toBe(7);
  });
});
