import { describe, expect, test } from "bun:test";
import {
  parseAttachmentInfo,
  parseRunnerAttachmentItems,
  parseSessionCleanupRequest,
  type SessionCleanupResult,
} from "./attachments.ts";

describe("parseAttachmentInfo", () => {
  const valid = { id: "att-1", name: "report.pdf", mimeType: "application/pdf", size: 1024 };

  test("parses a valid attachment info", () => {
    expect(parseAttachmentInfo(valid)).toEqual(valid);
  });

  test("rejects when a field is missing", () => {
    for (const partial of [
      { name: "report.pdf", mimeType: "application/pdf", size: 1024 },
      { id: "att-1", mimeType: "application/pdf", size: 1024 },
      { id: "att-1", name: "report.pdf", size: 1024 },
      { id: "att-1", name: "report.pdf", mimeType: "application/pdf" },
    ] as const) {
      expect(parseAttachmentInfo(partial)).toBeUndefined();
    }
  });

  test("rejects when a field has the wrong type", () => {
    for (const bad of [
      { ...valid, id: 1 },
      { ...valid, name: 42 },
      { ...valid, mimeType: null },
      { ...valid, size: "1024" },
    ] as const) {
      expect(parseAttachmentInfo(bad)).toBeUndefined();
    }
  });

  test("rejects a negative size", () => {
    expect(parseAttachmentInfo({ ...valid, size: -1 })).toBeUndefined();
  });

  test("rejects a zero size", () => {
    expect(parseAttachmentInfo({ ...valid, size: 0 })).toBeUndefined();
  });

  test("rejects an empty id", () => {
    expect(parseAttachmentInfo({ ...valid, id: "" })).toBeUndefined();
  });

  test("rejects a non-object value", () => {
    for (const bad of [undefined, null, "string", 42, [1, 2]]) {
      expect(parseAttachmentInfo(bad)).toBeUndefined();
    }
  });

  test("drops unknown keys", () => {
    const parsed = parseAttachmentInfo({ ...valid, extra: "ignored" });
    expect(parsed).toEqual(valid);
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("parseRunnerAttachmentItems", () => {
  const item = { id: "att-1", name: "report.pdf", mimeType: "application/pdf", size: 1024 };

  test("parses an array of valid items", () => {
    expect(parseRunnerAttachmentItems([item, { ...item, id: "att-2", name: "data.json" }])).toEqual(
      [item, { ...item, id: "att-2", name: "data.json" }],
    );
  });

  test("returns an empty array when undefined is passed", () => {
    expect(parseRunnerAttachmentItems(undefined)).toEqual([]);
  });

  test("rejects when any element is malformed", () => {
    expect(parseRunnerAttachmentItems([item, { ...item, size: -5 }])).toBeUndefined();
    expect(parseRunnerAttachmentItems([{ ...item, id: 1 }])).toBeUndefined();
    expect(parseRunnerAttachmentItems([{}])).toBeUndefined();
  });

  test("rejects a non-array value", () => {
    for (const bad of [null, "string", 42, { id: "att-1" }]) {
      expect(parseRunnerAttachmentItems(bad)).toBeUndefined();
    }
  });

  test("rejects each item using AttachmentInfo validation", () => {
    const parsed = parseRunnerAttachmentItems([item, { ...item, id: "" }, { ...item, name: null }]);
    expect(parsed).toBeUndefined();
  });
});

describe("parseSessionCleanupRequest", () => {
  test("parses a valid sessionId", () => {
    expect(parseSessionCleanupRequest({ sessionId: "sess-1" })).toEqual({ sessionId: "sess-1" });
  });

  test("rejects an empty sessionId", () => {
    expect(parseSessionCleanupRequest({ sessionId: "" })).toBeUndefined();
  });

  test("rejects a non-string sessionId", () => {
    for (const bad of [1, null, true, [1], {}]) {
      expect(parseSessionCleanupRequest({ sessionId: bad })).toBeUndefined();
    }
  });

  test("rejects a missing sessionId", () => {
    expect(parseSessionCleanupRequest({})).toBeUndefined();
  });

  test("rejects a non-object value", () => {
    for (const bad of [undefined, null, "string", 42]) {
      expect(parseSessionCleanupRequest(bad)).toBeUndefined();
    }
  });

  test("drops unknown keys", () => {
    const parsed = parseSessionCleanupRequest({ sessionId: "sess-1", extra: "ignored" });
    expect(parsed).toEqual({ sessionId: "sess-1" });
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("SessionCleanupResult", () => {
  // Type-level check: the shape is { ok: boolean; error?: string }
  test("has the expected shape", () => {
    const ok: SessionCleanupResult = { ok: true };
    const fail: SessionCleanupResult = { ok: false, error: "Session not found" };
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.error).toBe("Session not found");
  });
});
