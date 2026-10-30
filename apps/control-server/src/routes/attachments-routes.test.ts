import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The attachment surface over HTTP (§4.4 Task 3).
 *
 *   POST /api/sessions/:sessionId/attachments   — owner uploads one or more files
 *   GET  /api/attachments/:attachmentId           — owner downloads a file
 *   GET  /api/runner/attachments/:attachmentId    — runner downloads a file
 *
 * Auth mirrors every browser route: Origin allowlist first, then the session
 * cookie for browser routes. The runner route uses a Bearer token instead.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;
let fixtures: string[] = [];

afterEach(() => {
  handle?.stop();
  handle = undefined;
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true });
  }
  fixtures = [];
});

/** Make a temp attachments dir and register it for cleanup. */
function makeAttachmentsDir(): string {
  const dir = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    `tmp-fixture-attachments-${crypto.randomUUID()}`,
  );
  mkdirSync(dir, { recursive: true });
  fixtures.push(dir);
  return dir;
}

async function start(attachmentsDir?: string) {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());
  const { credential } = issueRunnerCredential(db, { id: "runner-a", ownerId: "user-1" });

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (candidate) => verifyRunnerCredential(db, candidate),
    outbox: new CommandOutbox(db),
    ...(attachmentsDir === undefined ? {} : { attachmentsDir }),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, auth, url: `http://127.0.0.1:${handle.server.port}`, cookie, credential };
}

async function seedSession(
  db: Database,
  sessionId = "sess-1",
  ownerId = "user-1",
  runnerId = "runner-a",
) {
  db.query(
    "INSERT INTO sessions (id, owner_id, workspace_id, runner_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, ownerId, "default", runnerId, Date.now());
}

async function seedAttachment(
  db: Database,
  attachmentsDir: string,
  sessionId: string,
  ownerId: string,
  id: string,
  name = "photo.png",
): Promise<string> {
  const sessionDir = join(attachmentsDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `${id}-${name}`), "file-bytes");
  db.query(
    "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    sessionId,
    ownerId,
    name,
    "image/png",
    10,
    join(sessionDir, `${id}-${name}`),
    Date.now(),
  );
  return id;
}

describe("POST /api/sessions/:sessionId/attachments", () => {
  test("a multipart upload saves the file and returns AttachmentInfo[]", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, cookie } = await start(dir);
    await seedSession(db);

    const form = new FormData();
    form.append("files", new File(["hello world"], "report.txt", { type: "text/plain" }));

    const response = await fetch(`${url}/api/sessions/sess-1/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: true;
      attachments: Array<Record<string, unknown>>;
    };
    expect(body.ok).toBe(true);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      name: "report.txt",
      mimeType: "text/plain",
      size: 11,
    });
    expect(typeof body.attachments[0]?.id).toBe("string");
    expect(body.attachments[0]?.id).not.toBe("");

    const id = body.attachments[0]!.id as string;
    const onDisk = db
      .query("SELECT storage_path FROM session_attachments WHERE id = ?")
      .get(id) as { storage_path: string };
    expect(readFileSync(onDisk.storage_path, "utf-8")).toBe("hello world");
  });

  test("a foreign Origin is refused", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/sessions/sess-1/attachments`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
      body: new FormData(),
    });
    expect(response.status).toBe(403);
  });

  test("without a session cookie the answer is 401", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/sessions/sess-1/attachments`, {
      method: "POST",
      headers: { Origin: origin },
      body: new FormData(),
    });
    expect(response.status).toBe(401);
  });

  test("uploading to a session the owner does not own returns 404", async () => {
    const { db, url, cookie } = await start();
    await seedSession(db, "foreign-session", "user-2");
    const response = await fetch(`${url}/api/sessions/foreign-session/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: (() => {
        const form = new FormData();
        form.append("files", new File(["x"], "a.txt", { type: "text/plain" }));
        return form;
      })(),
    });
    expect(response.status).toBe(404);
  });

  test("uploading to a new unpinned session succeeds", async () => {
    const dir = makeAttachmentsDir();
    const { url, cookie } = await start(dir);
    const form = new FormData();
    form.append("files", new File(["hello unpinned"], "fresh.txt", { type: "text/plain" }));
    const response = await fetch(`${url}/api/sessions/fresh-new-session/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: boolean; attachments: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]!.name).toBe("fresh.txt");
  });

  test("a single file over 20 MB is rejected with 413", async () => {
    const { db, url, cookie } = await start();
    await seedSession(db, "sess-2");

    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.fill(1);

    const form = new FormData();
    form.append("files", new Blob([big]), "big.txt");

    const response = await fetch(`${url}/api/sessions/sess-2/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(response.status).toBe(413);
  });

  test("total upload over 50 MB across multiple files is rejected with 413", async () => {
    const { db, url, cookie } = await start();
    await seedSession(db, "sess-3");

    const chunk = new Uint8Array(26 * 1024 * 1024);
    chunk.fill(1);

    const form = new FormData();
    form.append("files", new Blob([chunk]), "a.bin");
    form.append("files", new Blob([chunk]), "b.bin");

    const response = await fetch(`${url}/api/sessions/sess-3/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(response.status).toBe(413);
  });

  test("a path traversal name is sanitized", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, cookie } = await start(dir);
    await seedSession(db, "sess-4");

    const form = new FormData();
    form.append("files", new File(["data"], "../../../etc/passwd", { type: "text/plain" }));

    const response = await fetch(`${url}/api/sessions/sess-4/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { attachments: Array<{ name: string; id: string }> };
    // The returned name is the original upload name.
    expect(body.attachments[0]!.name).toBe("../../../etc/passwd");

    // The on-disk file name is sanitized: <id>-<basename-without-dirs>.
    const id = body.attachments[0]!.id;
    const onDisk = db
      .query("SELECT storage_path FROM session_attachments WHERE id = ?")
      .get(id) as { storage_path: string };
    const path = require("node:path");
    expect(path.basename(onDisk.storage_path)).toBe(`${id}-passwd`);
  });

  test("multiple files are uploaded in one request", async () => {
    const { db, url, cookie } = await start();
    await seedSession(db, "sess-5");

    const form = new FormData();
    form.append("files", new File(["a"], "a.txt", { type: "text/plain" }));
    form.append("files", new File(["b"], "b.txt", { type: "text/plain" }));

    const response = await fetch(`${url}/api/sessions/sess-5/attachments`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { attachments: Array<{ name: string }> };
    expect(body.attachments).toHaveLength(2);
    expect(body.attachments.map((a) => a.name).sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("GET /api/attachments/:id", () => {
  test("returns the file with Content-Type, Cache-Control and Content-Disposition", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, cookie } = await start(dir);
    await seedSession(db, "sess-6");
    const id = await seedAttachment(db, dir, "sess-6", "user-1", "att-img-1");

    const response = await fetch(`${url}/api/attachments/${id}`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    // image/* → inline.
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(await response.text()).toBe("file-bytes");
  });

  test("a non-image attachment gets Content-Disposition: attachment with filename", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, cookie } = await start(dir);
    await seedSession(db, "sess-7");

    // Override the seeded attachment with a text/plain name.
    const sessionDir = join(dir, "sess-7");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "att-txt-1-doc.txt"), "textdata");
    db.query(
      "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "att-txt-1",
      "sess-7",
      "user-1",
      "doc.txt",
      "text/plain",
      9,
      join(sessionDir, "att-txt-1-doc.txt"),
      Date.now(),
    );

    const response = await fetch(`${url}/api/attachments/att-txt-1`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="doc.txt"');
  });

  test("404 for an unknown attachment id", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/attachments/nonexistent`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });

  test("401 without a session cookie", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/attachments/anything`, {
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
  });

  test("403 for a foreign origin", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/attachments/anything`, {
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("another owner's attachment is 404 (no existence leak)", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, auth } = await start(dir);
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-2", "other", "hash", 1, Date.now());

    // user-2 owns a session + attachment.
    db.query(
      "INSERT INTO sessions (id, owner_id, workspace_id, runner_id, created_at) VALUES ('sess-other', 'user-2', 'default', 'runner-a', ?)",
    ).run(Date.now());
    const attId = "att-other-owner";
    await seedAttachment(db, dir, "sess-other", "user-2", attId, "secret.txt");

    const cookie1 = `cc_session=${await auth.issueAccessToken("user-1")}`;

    // user-1 cannot read user-2's attachment.
    const response = await fetch(`${url}/api/attachments/${attId}`, {
      headers: { Origin: origin, Cookie: cookie1 },
    });
    expect(response.status).toBe(404);
  });

  test("404 when the file is missing from disk", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, cookie } = await start(dir);
    await seedSession(db, "sess-missing");

    // Insert a DB record whose storage_path does not exist on disk.
    const attId = "att-missing-disk";
    db.query(
      "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      attId,
      "sess-missing",
      "user-1",
      "gone.png",
      "image/png",
      5,
      join(dir, "does-not-exist"),
      Date.now(),
    );

    const response = await fetch(`${url}/api/attachments/${attId}`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/runner/attachments/:id", () => {
  test("a valid runner token downloads the file", async () => {
    const dir = makeAttachmentsDir();
    const { db, url, credential } = await start(dir);
    // Session pinned to runner-a.
    await seedSession(db, "sess-r1", "user-1", "runner-a");
    const id = await seedAttachment(db, dir, "sess-r1", "user-1", "att-runner-1");

    const response = await fetch(`${url}/api/runner/attachments/${id}`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("file-bytes");
  });

  test("an invalid runner token is rejected with 401", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/runner/attachments/anything`, {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(response.status).toBe(401);
  });

  test("missing Authorization header is 401", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/runner/attachments/anything`);
    expect(response.status).toBe(401);
  });

  test("a runner that does not own the session is 404", async () => {
    const dir = makeAttachmentsDir();
    const { db, url } = await start(dir);
    // Session pinned to runner-b.
    db.query(
      "INSERT INTO runners (id, owner_id, revoked_at, created_at) VALUES ('runner-b', 'user-1', NULL, ?)",
    ).run(Date.now());
    await seedSession(db, "sess-r2", "user-1", "runner-b");
    const id = await seedAttachment(db, dir, "sess-r2", "user-1", "att-runner-other");

    // runner-a's credential.
    const { credential: credA } = startRunnerCredential(db, "runner-a-2");

    const response = await fetch(`${url}/api/runner/attachments/${id}`, {
      headers: { Authorization: `Bearer ${credA}` },
    });
    expect(response.status).toBe(404);
  });

  test("404 for an unknown attachment id", async () => {
    const { url, credential } = await start();
    const response = await fetch(`${url}/api/runner/attachments/nonexistent`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(404);
  });
});

function startRunnerCredential(db: Database, runnerId: string) {
  return issueRunnerCredential(db, { id: runnerId, ownerId: "user-1" });
}
