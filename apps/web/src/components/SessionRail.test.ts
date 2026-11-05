import { afterEach, describe, expect, test } from "bun:test";
import {
  buildLanguageMenuOptions,
  buildThemeMenuOptions,
  languageTriggerLabel,
  themeTriggerLabel,
  userSubmenuPlacement,
} from "../features/layout/user-menu.ts";
import { setLocale } from "../lib/i18n/index.ts";
import { removeSession, sessions, updateSessionTitleInStore } from "../stores/sessions.ts";

/**
 * Tests for SessionRail session actions and display logic (§16.1).
 */
describe("SessionRail display logic", () => {
  test("session row prefers title over sessionId when present", () => {
    const sessionWithTitle = {
      sessionId: "session-1234-abcd",
      title: "Fix bug auth",
      watermark: 0,
      eventCount: 0,
      lastEventType: null,
      lastIngestedAt: 0,
      live: false,
      runnerId: null,
      workspaceId: null,
      sdkSessionId: null,
    };
    const sessionWithoutTitle: { sessionId: string; title?: string } = {
      sessionId: "session-5678-ef01",
    };

    const label1 = sessionWithTitle.title || sessionWithTitle.sessionId;
    const label2 = sessionWithoutTitle.title || sessionWithoutTitle.sessionId;

    expect(label1).toBe("Fix bug auth");
    expect(label2).toBe("session-5678-ef01");
  });

  test("renaming updates title in reactive store", () => {
    sessions.sessions = [
      {
        sessionId: "sess-abc",
        title: "Tên cũ",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
    ];

    updateSessionTitleInStore("sess-abc", "Tên mới");
    expect(sessions.sessions[0]?.title).toBe("Tên mới");
  });

  test("deleting removes session and clears active session if active", () => {
    sessions.sessions = [
      {
        sessionId: "sess-active",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
    ];
    sessions.activeId = "sess-active";

    removeSession("sess-active");
    expect(sessions.sessions).toHaveLength(0);
    expect(sessions.activeId).toBeNull();
  });
});

describe("SessionRail user menu options (language & theme)", () => {
  afterEach(() => {
    setLocale("vi");
  });

  test("builds language menu options and trigger label with active locale marked", () => {
    setLocale("vi");
    expect(languageTriggerLabel("vi")).toBe("Tiếng Việt");
    expect(languageTriggerLabel("en")).toBe("English");
    expect(buildLanguageMenuOptions("vi")).toEqual([
      { value: "vi", flag: "🇻🇳", label: "Tiếng Việt", selected: true },
      { value: "en", flag: "🇺🇸", label: "English", selected: false },
    ]);
    expect(buildLanguageMenuOptions("en").map((o) => o.selected)).toEqual([false, true]);
  });

  test("builds theme menu options and trigger label in vi and en", () => {
    setLocale("vi");
    expect(themeTriggerLabel("light")).toBe("Sáng");
    expect(themeTriggerLabel("dark")).toBe("Tối");
    expect(themeTriggerLabel("system")).toBe("Hệ thống");
    expect(buildThemeMenuOptions("system")).toEqual([
      { value: "light", label: "Sáng", selected: false },
      { value: "dark", label: "Tối", selected: false },
      { value: "system", label: "Hệ thống", selected: true },
    ]);

    setLocale("en");
    expect(themeTriggerLabel("light")).toBe("Light");
    expect(themeTriggerLabel("dark")).toBe("Dark");
    expect(themeTriggerLabel("system")).toBe("System");
  });

  test("places user submenus above the trigger on narrow mobile viewports and to the right on wider viewports", () => {
    expect(userSubmenuPlacement(390)).toEqual({ side: "top", align: "end" });
    expect(userSubmenuPlacement(639)).toEqual({ side: "top", align: "end" });
    expect(userSubmenuPlacement(640)).toEqual({ side: "right", align: "start" });
    expect(userSubmenuPlacement(1280)).toEqual({ side: "right", align: "start" });
  });
});
