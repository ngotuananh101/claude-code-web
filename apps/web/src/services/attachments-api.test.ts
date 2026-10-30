import { afterEach, describe, expect, test } from "bun:test";
import { attachmentUrl, uploadSessionAttachments } from "./attachments-api.ts";

/**
 * Attachments HTTP surface: upload files to a session's attachments endpoint.
 *
 * The upload uses authFetch (transparent token refresh) and FormData. The
 * response mapping lives here — not in Composer.vue — so a 413 size refusal
 * answers with the operator-facing Vietnamese message rather than a body the
 * view would have to translate.
 */

type Captured = { url: string; method: string; body: FormData | null };

const realFetch = globalThis.fetch;

function captureFormData(status: number, body: unknown = {}): { captured: Captured } {
  const captured = { url: "", method: "", body: null as FormData | null } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body instanceof FormData ? init.body : null;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { captured };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("attachmentUrl", () => {
  test("returns the path with the encoded id", () => {
    expect(attachmentUrl("att-1")).toBe("/api/attachments/att-1");
  });

  test("URL-encodes the id", () => {
    expect(attachmentUrl("a b+c")).toBe("/api/attachments/a%20b%2Bc");
  });
});

describe("uploadSessionAttachments", () => {
  test("a 201 returns ok with the attachments list", async () => {
    const { captured } = captureFormData(201, {
      attachments: [{ id: "a1", name: "hello.txt", mimeType: "text/plain", size: 12 }],
    });

    const file = new File(["hello world"], "hello.txt", { type: "text/plain" });
    const result = await uploadSessionAttachments("sess-1", [file]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments).toEqual([
        { id: "a1", name: "hello.txt", mimeType: "text/plain", size: 12 },
      ]);
    }

    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/sessions/sess-1/attachments");
    // The body must be FormData, and the session id is in the URL not the form.
    expect(captured.body).toBeInstanceOf(FormData);
    expect(captured.body?.get("files")).toBeInstanceOf(File);
  });

  test("a 413 answers with the Vietnamese size-limit message", async () => {
    captureFormData(413, {});

    const file = new File(["x".repeat(10)], "big.bin", { type: "application/octet-stream" });
    const result = await uploadSessionAttachments("sess-1", [file]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "Kích thước tệp quá giới hạn cho phép (tối đa 20MB/tệp, 50MB tổng cộng)",
      );
    }
  });

  test("any other status answers ok false with the server message", async () => {
    captureFormData(500, { message: "server on fire" });

    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const result = await uploadSessionAttachments("sess-1", [file]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("server on fire");
    }
  });

  test("a non-JSON body falls back to a generic message", async () => {
    const captured = { url: "", method: "", body: null as FormData | null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input);
      captured.method = init?.method ?? "GET";
      captured.body = init?.body instanceof FormData ? init.body : null;
      return new Response("not json", { status: 502 });
    }) as typeof fetch;

    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const result = await uploadSessionAttachments("sess-1", [file]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Không thể tải tệp lên.");
    }
  });

  test("a network failure answers ok false without throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const result = await uploadSessionAttachments("sess-1", [file]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Không thể tải tệp lên.");
    }
  });

  test("multiple files are appended to the FormData", async () => {
    const { captured } = captureFormData(201, { attachments: [] });

    const f1 = new File(["a"], "a.txt", { type: "text/plain" });
    const f2 = new File(["b"], "b.txt", { type: "text/plain" });
    await uploadSessionAttachments("sess-1", [f1, f2]);

    expect(captured.body).toBeInstanceOf(FormData);
    expect(captured.body?.getAll("files")).toHaveLength(2);
  });
});
