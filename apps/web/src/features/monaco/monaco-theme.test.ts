import { describe, expect, test } from "bun:test";
import {
  CC_WEB_DARK_THEME,
  CC_WEB_LIGHT_THEME,
  defineCcWebThemes,
  monacoThemeForResolvedTheme,
} from "./monaco-theme.ts";

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

describe("CC_WEB_LIGHT_THEME", () => {
  test("defines light base and matching background", () => {
    expect(CC_WEB_LIGHT_THEME.base).toBe("vs");
    expect(CC_WEB_LIGHT_THEME.colors["editor.background"]).toBe("#ffffff");
  });

  test("defines readable diff colors for light background", () => {
    expect(CC_WEB_LIGHT_THEME.colors["diffEditor.insertedTextBackground"]).toBeDefined();
    expect(CC_WEB_LIGHT_THEME.colors["diffEditor.removedTextBackground"]).toBeDefined();
  });
});

describe("monacoThemeForResolvedTheme", () => {
  test("maps resolved theme to Monaco theme name", () => {
    expect(monacoThemeForResolvedTheme("dark")).toBe("cc-web-dark");
    expect(monacoThemeForResolvedTheme("light")).toBe("cc-web-light");
  });

  test("defineCcWebThemes registers both dark and light themes", () => {
    const defined: string[] = [];
    defineCcWebThemes({
      editor: {
        defineTheme: (name: string) => {
          defined.push(name);
        },
      },
    } as never);
    expect(defined).toEqual(["cc-web-dark", "cc-web-light"]);
  });
});
