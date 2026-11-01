import { describe, expect, test } from "bun:test";
import { CC_WEB_DARK_THEME } from "./monaco-theme.ts";

describe("CC_WEB_DARK_THEME", () => {
  test("defines dark base and matching background", () => {
    expect(CC_WEB_DARK_THEME.base).toBe("vs-dark");
    expect(CC_WEB_DARK_THEME.colors["editor.background"]).toBe("#09090b");
  });

  test("defines readable diff colors without intrusive buttons", () => {
    expect(CC_WEB_DARK_THEME.colors["diffEditor.insertedTextBackground"]).toBeDefined();
    expect(CC_WEB_DARK_THEME.colors["diffEditor.removedTextBackground"]).toBeDefined();
  });
});
