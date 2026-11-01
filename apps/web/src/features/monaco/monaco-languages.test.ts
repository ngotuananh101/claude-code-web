import { describe, expect, test } from "bun:test";
import { monacoLanguageForPath } from "./monaco-languages.ts";

describe("monacoLanguageForPath", () => {
  test("maps typescript and javascript extensions", () => {
    expect(monacoLanguageForPath("src/index.ts")).toBe("typescript");
    expect(monacoLanguageForPath("src/App.vue")).toBe("html");
    expect(monacoLanguageForPath("src/main.js")).toBe("javascript");
    expect(monacoLanguageForPath("types.d.ts")).toBe("typescript");
  });

  test("maps common formats", () => {
    expect(monacoLanguageForPath("README.md")).toBe("markdown");
    expect(monacoLanguageForPath("package.json")).toBe("json");
    expect(monacoLanguageForPath("script.py")).toBe("python");
    expect(monacoLanguageForPath("style.css")).toBe("css");
    expect(monacoLanguageForPath("config.yaml")).toBe("yaml");
    expect(monacoLanguageForPath("deploy.sh")).toBe("shell");
  });

  test("falls back to plaintext for unknown extensions or extensionless files", () => {
    expect(monacoLanguageForPath("LICENSE")).toBe("plaintext");
    expect(monacoLanguageForPath("data.xyz123")).toBe("plaintext");
  });
});
