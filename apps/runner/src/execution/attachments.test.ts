import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RunnerAttachmentItem } from "@cc-web/protocol";
import { injectAttachmentsContext } from "./attachments.ts";

/**
 * Attachment download and prompt context injection for the runner (§attachments).
 *
 * `injectAttachmentsContext` prepends a block listing every downloaded file so
 * Claude Code can `Read` text, code, PDFs, or images. `downloadRunnerAttachments`
 * fetches files from the control server's attachment endpoint and writes them to
 * `${runnerHome}/tmp/sessions/${sessionId}/attachments/`.
 */

describe("injectAttachmentsContext", () => {
  test("returns the prompt unchanged when there are no files", () => {
    expect(injectAttachmentsContext("hello world", [])).toBe("hello world");
  });

  test("formats the attachment block and appends the prompt", () => {
    const files = [
      { name: "spec.md", path: "/tmp/attachments/spec.md", mimeType: "text/markdown" },
      { name: "screenshot.png", path: "/tmp/attachments/screen.png", mimeType: "image/png" },
    ];
    const result = injectAttachmentsContext("analyze this", files);

    expect(result).toContain("[Attached Files]");
    expect(result).toContain("The user attached the following file(s) for this run");
    expect(result).toContain("spec.md: /tmp/attachments/spec.md (text/markdown)");
    expect(result).toContain("screenshot.png: /tmp/attachments/screen.png (image/png)");
    expect(result).toContain("Use your native `Read` tool to inspect them");
    expect(result).toContain("User prompt:");
    expect(result).toContain("analyze this");
    // The prompt appears after the "User prompt:" marker.
    expect(result.indexOf("analyze this")).toBeGreaterThan(result.indexOf("User prompt:"));
  });

  test("lists each file with its original name, path, and mimeType", () => {
    const result = injectAttachmentsContext("do something", [
      { name: "a/b/c.json", path: "/disk/c.json", mimeType: "application/json" },
    ]);
    expect(result).toContain("- a/b/c.json: /disk/c.json (application/json)");
  });
});

describe("downloadRunnerAttachments", () => {
  // The download tests use a real HTTP server (Bun.serve) so the fetch path is
  // exercised end-to-end, including the Authorization header and the on-disk
  // file integrity.

  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function freshDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  test("downloads each attachment into the session attachments directory", async () => {
    const attachments: RunnerAttachmentItem[] = [
      { id: "att-1", name: "hello.txt", mimeType: "text/plain", size: 5 },
      { id: "att-2", name: "data.json", mimeType: "application/json", size: 16 },
    ];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const id = url.pathname.split("/").pop();
        if (!req.headers.get("authorization")?.startsWith("Bearer ")) {
          return new Response("unauthorized", { status: 401 });
        }
        if (id === "att-1") {
          return new Response(Buffer.from("hello"), {
            headers: { "content-type": "text/plain" },
          });
        }
        if (id === "att-2") {
          return new Response(Buffer.from('{"key":"val"}'), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const runnerHome = await freshDir("cc-web-attach-");
      const sessionId = "sess-download-1";

      // Import dynamically so the server URL is known at call time.
      const { downloadRunnerAttachments } = await import("./attachments.ts");
      const files = await downloadRunnerAttachments({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
        sessionId,
        runnerHome,
        attachments,
      });

      expect(files).toHaveLength(2);
      const attachmentsDir = join(runnerHome, `tmp/sessions/${sessionId}/attachments`);
      expect(files[0]).toEqual({
        name: "hello.txt",
        path: join(attachmentsDir, "att-1-hello.txt"),
        mimeType: "text/plain",
      });
      expect(files[1]).toEqual({
        name: "data.json",
        path: join(attachmentsDir, "att-2-data.json"),
        mimeType: "application/json",
      });

      // Verify the downloaded content matches.
      const helloContent = readFileSync(files[0]!.path, "utf8");
      expect(helloContent).toBe("hello");
      const jsonContent = readFileSync(files[1]!.path, "utf8");
      expect(JSON.parse(jsonContent)).toEqual({ key: "val" });
    } finally {
      server.stop();
    }
  });

  test("sanitizes the name to prevent path traversal on disk", async () => {
    const attachments: RunnerAttachmentItem[] = [
      { id: "att-traversal", name: "../escape.txt", mimeType: "text/plain", size: 3 },
    ];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const id = url.pathname.split("/").pop();
        if (id === "att-traversal") {
          return new Response(Buffer.from("pwned"), {
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const runnerHome = await freshDir("cc-web-attach-trav-");
      const sessionId = "sess-download-2";

      const { downloadRunnerAttachments } = await import("./attachments.ts");
      const files = await downloadRunnerAttachments({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
        sessionId,
        runnerHome,
        attachments,
      });

      expect(files).toHaveLength(1);

      // The basename of "../escape.txt" is "escape.txt" — it must land inside the
      // attachments dir, not at runnerHome/escape.txt.
      const safeName = basename(attachments[0]!.name);
      expect(files[0]!.path).toBe(
        join(runnerHome, `tmp/sessions/${sessionId}/attachments`, `att-traversal-${safeName}`),
      );
      expect(files[0]!.path).not.toContain("..");

      // The traversal target must not exist outside the attachments dir.
      expect(existsSync(join(runnerHome, "escape.txt"))).toBe(false);
      expect(existsSync(files[0]!.path)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("sends the Authorization Bearer header", async () => {
    let receivedAuth: string | null = null;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuth = req.headers.get("authorization");
        const url = new URL(req.url);
        const id = url.pathname.split("/").pop();
        if (id === "att-1") {
          return new Response(Buffer.from("ok"), {
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const runnerHome = await freshDir("cc-web-attach-auth-");
      const { downloadRunnerAttachments } = await import("./attachments.ts");
      await downloadRunnerAttachments({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: "secret-token-123",
        sessionId: "sess-download-3",
        runnerHome,
        attachments: [{ id: "att-1", name: "file.txt", mimeType: "text/plain", size: 2 }],
      });

      expect(receivedAuth as string | null).toBe("Bearer secret-token-123" as string | null);
    } finally {
      server.stop();
    }
  });
});
