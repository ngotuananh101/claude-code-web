import { describe, expect, it } from "bun:test";
import type { RunnerCapabilities } from "@cc-web/protocol";
import {
  applyCommandToPrompt,
  filterCommands,
  getAvailableCommands,
  type SlashCommandItem,
} from "./slash-commands";

describe("slash-commands", () => {
  describe("getAvailableCommands", () => {
    it("should return default builtin commands when no capabilities", () => {
      const commands = getAvailableCommands();
      expect(commands).toContainEqual({
        name: "clear",
        displayName: "Clear",
        description: "Clear the conversation",
        category: "builtin",
      });
    });

    it("should include runner commands when capabilities provided", () => {
      const mockCapabilities: RunnerCapabilities = {
        commands: [
          {
            name: "test-command",
            description: "A test command",
          },
        ],
        plugins: [],
        mcpServers: [],
        agents: [],
      };
      const commands = getAvailableCommands(mockCapabilities);
      expect(commands).toContainEqual({
        name: "test-command",
        displayName: "test-command",
        description: "A test command",
        category: "plugin",
      });
    });
  });

  describe("filterCommands", () => {
    it("should filter commands based on query", () => {
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
      const filtered = filterCommands(commands, "cle");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe("clear");
    });

    it("should handle fuzzy matching", () => {
      const commands: SlashCommandItem[] = [
        {
          name: "code-review",
          displayName: "Code Review",
          description: "Review code",
          category: "builtin",
        },
      ];
      const filtered = filterCommands(commands, "rev");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe("code-review");
    });
  });

  describe("applyCommandToPrompt", () => {
    it("should apply command to prompt", () => {
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
  });
});
