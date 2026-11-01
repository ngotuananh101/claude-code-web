import { describe, expect, test } from "bun:test";
import { createLanguageLoader, languageForPath } from "./languages.ts";

const notUnderTest = () => Promise.reject(new Error("loader not under test"));

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

describe("createLanguageLoader", () => {
  test("caches a successful load and shares the in-flight promise", async () => {
    let calls = 0;
    const load = createLanguageLoader({
      javascript: async () => {
        calls++;
        return [];
      },
      json: notUnderTest,
      markdown: notUnderTest,
      python: notUnderTest,
      html: notUnderTest,
      css: notUnderTest,
    });

    const first = load("javascript");
    const second = load("javascript");
    expect(second).toBe(first);
    await first;
    await load("javascript");
    expect(calls).toBe(1);
  });

  test("evicts a rejected load so a later call retries", async () => {
    let calls = 0;
    const load = createLanguageLoader({
      javascript: async () => {
        calls++;
        if (calls === 1) throw new Error("chunk failed");
        return [];
      },
      json: notUnderTest,
      markdown: notUnderTest,
      python: notUnderTest,
      html: notUnderTest,
      css: notUnderTest,
    });

    await expect(load("javascript")).rejects.toThrow("chunk failed");
    await load("javascript");
    expect(calls).toBe(2);
  });
});
