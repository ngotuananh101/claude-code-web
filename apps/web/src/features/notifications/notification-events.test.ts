import { describe, expect, test } from "bun:test";
import {
  createNotificationDedupe,
  formatBrowserNotification,
  getBrowserNotificationEnabled,
  isNotifiableBrowserEvent,
  type SimpleStorage,
  setBrowserNotificationEnabled,
  shouldShowSystemNotification,
} from "./notification-events.ts";

function memoryStorage(): SimpleStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("isNotifiableBrowserEvent", () => {
  test("covers approvals and run terminal events only", () => {
    for (const type of [
      "approval.requested",
      "approval.expired",
      "run.finished",
      "run.failed",
      "run.interrupted",
    ]) {
      expect(isNotifiableBrowserEvent(type)).toBe(true);
    }
    expect(isNotifiableBrowserEvent("message.completed")).toBe(false);
    expect(isNotifiableBrowserEvent("tool.completed")).toBe(false);
  });
});

describe("formatBrowserNotification", () => {
  test("approval notification carries session, tool and a capped summary", () => {
    const content = formatBrowserNotification({
      eventId: "evt-1",
      type: "approval.requested",
      sessionId: "session-1",
      sessionTitle: "My session",
      toolName: "Bash",
      inputSummary: "x".repeat(1000),
    });
    expect(content).not.toBeNull();
    expect(content!.title).toBe("Cần phê duyệt");
    expect(content!.body).toContain("My session");
    expect(content!.body).toContain("Bash");
    expect(content!.body.length).toBeLessThan(400);
  });

  test("other events format to null", () => {
    expect(
      formatBrowserNotification({ eventId: "evt-2", type: "message.completed", sessionId: "s" }),
    ).toBeNull();
  });
});

describe("shouldShowSystemNotification", () => {
  const base = {
    permission: "granted",
    browserEnabled: true,
    documentHidden: false,
    currentSessionId: "session-1",
    eventSessionId: "session-1",
  };
  test("same session in a visible tab: no system notification", () => {
    expect(shouldShowSystemNotification(base)).toBe(false);
  });
  test("hidden tab, different session, or no session open: show", () => {
    expect(shouldShowSystemNotification({ ...base, documentHidden: true })).toBe(true);
    expect(shouldShowSystemNotification({ ...base, eventSessionId: "session-2" })).toBe(true);
    expect(shouldShowSystemNotification({ ...base, currentSessionId: null })).toBe(true);
  });
  test("permission denied or toggle off: never show", () => {
    expect(shouldShowSystemNotification({ ...base, permission: "denied" })).toBe(false);
    expect(shouldShowSystemNotification({ ...base, browserEnabled: false })).toBe(false);
  });
});

describe("dedupe and preference storage", () => {
  test("the same event id notifies once", () => {
    const dedupe = createNotificationDedupe();
    expect(dedupe.seen("evt-1")).toBe(false);
    expect(dedupe.seen("evt-1")).toBe(true);
    expect(dedupe.seen("evt-2")).toBe(false);
  });

  test("preference defaults to on and persists off", () => {
    const storage = memoryStorage();
    expect(getBrowserNotificationEnabled(storage)).toBe(true);
    setBrowserNotificationEnabled(storage, false);
    expect(getBrowserNotificationEnabled(storage)).toBe(false);
  });
});
