import { describe, expect, test } from "bun:test";
import { languageForPath } from "./languages.ts";

describe("languageForPath", () => {
  test("maps the supported extensions case-insensitively", () => {
    expect(languageForPath("src/app.ts")).toBe("javascript");
    expect(languageForPath("src/App.TSX")).toBe("javascript");
    expect(languageForPath("src/index.mjs")).toBe("javascript");
    expect(languageForPath("types/index.d.ts")).toBe("javascript");
    expect(languageForPath("tsconfig.json")).toBe("json");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("tools/run.PY")).toBe("python");
    expect(languageForPath("public/index.html")).toBe("html");
    expect(languageForPath("styles/app.css")).toBe("css");
  });

  test("returns null for unknown or extensionless paths", () => {
    expect(languageForPath("Makefile")).toBeNull();
    expect(languageForPath("src/notes.txt")).toBeNull();
    expect(languageForPath(".gitignore")).toBeNull();
    expect(languageForPath("src/widget.yaml")).toBeNull();
  });
});
