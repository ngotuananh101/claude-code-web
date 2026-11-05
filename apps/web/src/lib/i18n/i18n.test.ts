import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "./index.ts";

describe("i18n module", () => {
  beforeEach(() => {
    setLocale("vi");
  });

  // Other suites assert the Vietnamese copy; the module state is shared.
  afterEach(() => {
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

  test("translates the inspect, review, and service-copy keys", () => {
    expect(t("inspect.tabFiles")).toBe("Tệp tin");
    expect(t("review.save")).toBe("Lưu");
    expect(t("rpc.fileConflict")).toBe("Tệp đã bị thay đổi — hãy tải lên và thử lại.");
    expect(t("time.minutesAgo", { count: 5 })).toBe("5 phút trước");

    setLocale("en");
    expect(t("inspect.tabFiles")).toBe("Files");
    expect(t("review.save")).toBe("Save");
    expect(t("rpc.fileConflict")).toBe("The file changed — reload it and try again.");
    expect(t("time.minutesAgo", { count: 5 })).toBe("5 minutes ago");
  });

  test("translates user profile dialog keys in vi and en", () => {
    setLocale("vi");
    expect(t("user.dialogTitle")).toBe("Hồ sơ người dùng");
    expect(t("user.uploadBtn")).toBe("Tải ảnh lên");
    expect(t("user.usernameLabel")).toBe("Tên đăng nhập");
    expect(t("user.accountSection")).toBe("Tài khoản & Mật khẩu");
    expect(t("user.notificationsSection")).toBe("Cài đặt thông báo");
    expect(t("profiles.profileDeletedSuccess")).toBe("Đã xóa profile.");

    setLocale("en");
    expect(t("user.dialogTitle")).toBe("User Profile");
    expect(t("user.uploadBtn")).toBe("Upload avatar");
    expect(t("user.usernameLabel")).toBe("Username");
    expect(t("user.accountSection")).toBe("Account & Security");
    expect(t("user.notificationsSection")).toBe("Notification Preferences");
    expect(t("profiles.profileDeletedSuccess")).toBe("Profile deleted.");
  });

  test("translates language and provider profile menu labels in vi and en", () => {
    setLocale("vi");
    expect(t("user.languageVi")).toBe("Tiếng Việt");
    expect(t("user.languageEn")).toBe("English");
    expect(t("modelPicker.providerProfile")).toBe("Provider profile");

    setLocale("en");
    expect(t("user.languageVi")).toBe("Tiếng Việt");
    expect(t("user.languageEn")).toBe("English");
    expect(t("modelPicker.providerProfile")).toBe("Provider profile");
  });
});
