import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  deleteSessionAttachments,
  getSessionAttachment,
  insertSessionAttachment,
  listSessionAttachments,
  type SessionAttachmentRecord,
} from "./attachments.ts";
import { migrate } from "./db.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function makeRecord(overrides: Partial<SessionAttachmentRecord> = {}): SessionAttachmentRecord {
  return {
    id: overrides.id ?? "att-1",
    sessionId: overrides.sessionId ?? "session-1",
    ownerId: overrides.ownerId ?? "user-1",
    name: overrides.name ?? "example.png",
    mimeType: overrides.mimeType ?? "image/png",
    size: overrides.size ?? 1024,
    storagePath: overrides.storagePath ?? "/var/lib/cc-web/attachments/att-1",
    createdAt: overrides.createdAt ?? 1000,
  };
}

describe("session attachments", () => {
  test("insertSessionAttachment stores a record that getSessionAttachment reads back", () => {
    const db = setup();
    const record = makeRecord();

    insertSessionAttachment(db, record);

    const fetched = getSessionAttachment(db, record.id, record.ownerId);
    expect(fetched).toEqual(record);
  });

  test("getSessionAttachment returns undefined for unknown id", () => {
    const db = setup();

    expect(getSessionAttachment(db, "nobody", "user-1")).toBeUndefined();
  });

  test("getSessionAttachment refuses when ownerId does not match", () => {
    const db = setup();
    const record = makeRecord();
    insertSessionAttachment(db, record);

    expect(getSessionAttachment(db, record.id, "other-user")).toBeUndefined();
  });

  test("listSessionAttachments returns only this session's attachments for the owner", () => {
    const db = setup();

    insertSessionAttachment(
      db,
      makeRecord({ id: "att-1", sessionId: "session-1", ownerId: "user-1", name: "a.png" }),
    );
    insertSessionAttachment(
      db,
      makeRecord({ id: "att-2", sessionId: "session-1", ownerId: "user-1", name: "b.png" }),
    );
    insertSessionAttachment(
      db,
      makeRecord({ id: "att-3", sessionId: "session-2", ownerId: "user-1", name: "c.png" }),
    );
    insertSessionAttachment(
      db,
      makeRecord({ id: "att-4", sessionId: "session-1", ownerId: "user-2", name: "d.png" }),
    );

    const list = listSessionAttachments(db, "session-1", "user-1");
    const names = list.map((r) => r.name).sort();

    expect(names).toEqual(["a.png", "b.png"]);
    expect(list).toHaveLength(2);
  });

  test("listSessionAttachments returns [] for a session with no attachments", () => {
    const db = setup();

    expect(listSessionAttachments(db, "session-1", "user-1")).toEqual([]);
  });

  test("deleteSessionAttachments removes all attachments for the session and returns their storagePaths", () => {
    const db = setup();

    insertSessionAttachment(
      db,
      makeRecord({
        id: "att-1",
        sessionId: "session-1",
        ownerId: "user-1",
        storagePath: "/disk/att-1",
      }),
    );
    insertSessionAttachment(
      db,
      makeRecord({
        id: "att-2",
        sessionId: "session-1",
        ownerId: "user-1",
        storagePath: "/disk/att-2",
      }),
    );
    insertSessionAttachment(
      db,
      makeRecord({
        id: "att-3",
        sessionId: "session-2",
        ownerId: "user-1",
        storagePath: "/disk/att-3",
      }),
    );

    const paths = deleteSessionAttachments(db, "session-1", "user-1");

    expect(paths.sort()).toEqual(["/disk/att-1", "/disk/att-2"]);
    expect(listSessionAttachments(db, "session-1", "user-1")).toEqual([]);
    // session-2's attachments are untouched.
    expect(listSessionAttachments(db, "session-2", "user-1")).toHaveLength(1);
  });

  test("deleteSessionAttachments does not touch other owners' attachments", () => {
    const db = setup();

    insertSessionAttachment(
      db,
      makeRecord({
        id: "att-1",
        sessionId: "session-1",
        ownerId: "user-1",
        storagePath: "/disk/att-1",
      }),
    );
    insertSessionAttachment(
      db,
      makeRecord({
        id: "att-2",
        sessionId: "session-1",
        ownerId: "user-2",
        storagePath: "/disk/att-2",
      }),
    );

    const paths = deleteSessionAttachments(db, "session-1", "user-1");

    expect(paths).toEqual(["/disk/att-1"]);
    expect(getSessionAttachment(db, "att-1", "user-1")).toBeUndefined();
    // user-2's row survives.
    expect(getSessionAttachment(db, "att-2", "user-2")).toBeDefined();
  });
});
