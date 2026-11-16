import { afterEach, describe, expect, it } from "bun:test";
import type { RunnerCapabilities } from "@cc-web/protocol";
import { setLocale, t } from "../../lib/i18n";
import {
  applyCommandToPrompt,
  filterCommands,
  getAvailableCommands,
  SLASH_CATEGORY_LABEL_KEY,
  type SlashCommandItem,
} from "./slash-commands";

// The locale is module state shared with every other suite.
afterEach(() => {
  setLocale("vi");
});

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

  describe("SLASH_CATEGORY_LABEL_KEY", () => {
    // The copy itself is pinned in the i18n suite; this pins that every
    // category has a key at all, so the badge cannot leak "composer.slash…".
    const categories = ["builtin", "skill", "plugin", "agent"] as const;

    it("resolves every category to copy in vi and en", () => {
      for (const locale of ["vi", "en"] as const) {
        setLocale(locale);
        for (const category of categories) {
          const key = SLASH_CATEGORY_LABEL_KEY[category];
          expect(key.startsWith("composer.")).toBe(true);
          expect(t(key)).not.toBe(key);
        }
      }
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

    it("replaces slash token at cursor position", () => {
      const command: SlashCommandItem = {
        name: "clear",
        displayName: "Clear",
        description: "Clear the conversation",
        category: "builtin",
      };
      const result = applyCommandToPrompt("Please /cl", command, 10);
      expect(result.newPrompt).toBe("Please /clear ");
      expect(result.cursorPosition).toBe(14);
    });
  });
});
