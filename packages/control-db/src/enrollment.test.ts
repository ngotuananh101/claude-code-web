import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { consumeEnrollment, createEnrollment } from "./enrollment.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("enrollment token", () => {
  test("creates a token whose plaintext is never stored", () => {
    const db = freshDb();
    const { token } = createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });

    // The token must appear nowhere in the database, including in the row that
    // represents it. Storing it would let a DB read escalate to runner enrollment.
    const rows = db.prepare("SELECT * FROM enrollments").all() as Record<string, unknown>[];
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["token_hash"]).toBeString();
  });

  test("generates a distinct token per call", () => {
    const db = freshDb();
    const a = createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });
    const b = createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  test("consumes once and refuses the second attempt", () => {
    const db = freshDb();
    const { token, id } = createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });
    const now = Date.now();

    const first = consumeEnrollment(db, { token, now });
    expect(first).toEqual({ ok: true, enrollment: { id, ownerId: "owner-1" } });

    const second = consumeEnrollment(db, { token, now });
    expect(second).toEqual({ ok: false, reason: "consumed" });
  });

  test("rejects a token past its TTL", () => {
    const db = freshDb();
    const issuedAt = 1_000_000;
    const { token } = createEnrollment(db, {
      ownerId: "owner-1",
      ttlMs: 60_000,
      now: issuedAt,
    });

    const justInTime = consumeEnrollment(db, { token, now: issuedAt + 59_999 });
    expect(justInTime.ok).toBe(true);

    const db2 = freshDb();
    const second = createEnrollment(db2, { ownerId: "owner-1", ttlMs: 60_000, now: issuedAt });
    const tooLate = consumeEnrollment(db2, { token: second.token, now: issuedAt + 60_001 });
    expect(tooLate).toEqual({ ok: false, reason: "expired" });
  });

  test("rejects an unknown token", () => {
    const db = freshDb();
    createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });
    const result = consumeEnrollment(db, {
      token: "ccr_this_token_was_never_issued",
      now: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  test("two concurrent consumes of the same token yield exactly one success", () => {
    const db = freshDb();
    const { token } = createEnrollment(db, { ownerId: "owner-1", ttlMs: 60_000 });
    const now = Date.now();

    // Sequential but interleaved logic: the second must observe the first's write.
    // A read-then-write implementation passes this and fails the real race; the
    // SQLite-level guarantee is the conditional UPDATE, tested here as a
    // behavioural contract.
    const results = [consumeEnrollment(db, { token, now }), consumeEnrollment(db, { token, now })];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
