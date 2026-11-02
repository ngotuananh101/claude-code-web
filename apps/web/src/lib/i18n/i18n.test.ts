import { beforeEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "./index.ts";

describe("i18n module", () => {
  beforeEach(() => {
    setLocale("vi");
  });

  test("returns Vietnamese string when locale is vi", () => {
    expect(t("common.save")).toBe("Lưu");
  });

  test("reactively updates translation when locale changes to en", () => {
    setLocale("en");
    expect(t("common.save")).toBe("Save");
  });

  test("replaces named parameters in translation strings", () => {
    expect(t("common.pageCount", { current: 1, total: 5 })).toBe("Trang 1 / 5");
    setLocale("en");
    expect(t("common.pageCount", { current: 1, total: 5 })).toBe("Page 1 of 5");
  });

  test("falls back to vi when key is missing in en", () => {
    setLocale("en");
    expect(t("common.save")).toBe("Save");
  });

  test("returns raw key string when missing in all locales", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });
});
