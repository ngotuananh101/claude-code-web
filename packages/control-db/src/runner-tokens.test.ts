import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { verifyRunnerCredential } from "./runner-credentials.ts";
import { createRunnerToken, listRunners } from "./runner-tokens.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("createRunnerToken", () => {
  test("mints a runner id and a UUID connector token", () => {
    const db = freshDb();
    const { runnerId, token } = createRunnerToken(db, { ownerId: "owner-1" });

    expect(runnerId).toMatch(UUID);
    expect(token).toMatch(UUID);
    expect(runnerId).not.toBe(token);
  });

  test("token is stored only as a hash", () => {
    const db = freshDb();
    const { token } = createRunnerToken(db, { ownerId: "owner-1" });

    const serialized = JSON.stringify(db.prepare("SELECT * FROM runner_credentials").all());
    expect(serialized).not.toContain(token);
  });

  test("the minted token verifies as the runner's credential", () => {
    const db = freshDb();
    const { runnerId, token } = createRunnerToken(db, { ownerId: "owner-1" });

    expect(verifyRunnerCredential(db, token)).toEqual({
      ok: true,
      runnerId,
      ownerId: "owner-1",
    });
  });

  test("an unrelated UUID does not verify", () => {
    const db = freshDb();
    createRunnerToken(db, { ownerId: "owner-1" });

    expect(verifyRunnerCredential(db, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("re-minting for the same runner rotates the token", () => {
    const db = freshDb();
    const first = createRunnerToken(db, { ownerId: "owner-1" });
    const second = createRunnerToken(db, { ownerId: "owner-1", runnerId: first.runnerId });

    expect(verifyRunnerCredential(db, first.token)).toEqual({ ok: false, reason: "revoked" });
    expect(verifyRunnerCredential(db, second.token).ok).toBe(true);
    expect(second.token).not.toBe(first.token);
  });
});

describe("listRunners", () => {
  test("lists runners without any secret material", () => {
    const db = freshDb();
    const { runnerId, token } = createRunnerToken(db, { ownerId: "owner-1" });

    const runners = listRunners(db, "owner-1");
    expect(runners.length).toBe(1);
    expect(runners[0]).toEqual({
      runnerId,
      createdAt: expect.any(Number),
      revokedAt: null,
    });

    const serialized = JSON.stringify(runners);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("secret");
  });

  test("answers only the owner's own runners", () => {
    // §17 says the list is "danh sách runner của owner". A runner id is not a
    // secret, but a registry that leaks another owner's topology is still
    // wrong: every sibling listing in this package is owner-scoped.
    const db = freshDb();
    const mine = createRunnerToken(db, { ownerId: "owner-1" });
    createRunnerToken(db, { ownerId: "owner-2" });

    const runners = listRunners(db, "owner-1");
    expect(runners.map((r) => r.runnerId)).toEqual([mine.runnerId]);
  });
});
