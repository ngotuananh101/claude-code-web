import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import {
  issueRunnerCredential,
  revokeRunner,
  verifyRunnerCredential,
} from "./runner-credentials.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const runner = { id: "runner-a", ownerId: "owner-1" };

describe("runner credential", () => {
  test("plaintext credential is never stored", () => {
    const db = freshDb();
    const { credential } = issueRunnerCredential(db, runner);

    const serialized = JSON.stringify(db.prepare("SELECT * FROM runner_credentials").all());
    expect(serialized).not.toContain(credential);
  });

  test("verifies a credential it issued", () => {
    const db = freshDb();
    const { credential } = issueRunnerCredential(db, runner);
    expect(verifyRunnerCredential(db, credential)).toEqual({
      ok: true,
      runnerId: "runner-a",
      ownerId: "owner-1",
    });
  });

  test("rejects an unknown credential", () => {
    const db = freshDb();
    expect(verifyRunnerCredential(db, "cck_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  test("rejects a credential after revoke", () => {
    const db = freshDb();
    const { credential } = issueRunnerCredential(db, runner);
    expect(verifyRunnerCredential(db, credential).ok).toBe(true);

    revokeRunner(db, { runnerId: "runner-a", ownerId: "owner-1" });

    expect(verifyRunnerCredential(db, credential)).toEqual({ ok: false, reason: "revoked" });
  });

  test("rotation invalidates the previous credential", () => {
    const db = freshDb();
    const first = issueRunnerCredential(db, runner);
    const second = issueRunnerCredential(db, runner);

    expect(verifyRunnerCredential(db, first.credential)).toEqual({ ok: false, reason: "revoked" });
    expect(verifyRunnerCredential(db, second.credential).ok).toBe(true);
  });

  test("a runner cannot be revoked by a different owner", () => {
    const db = freshDb();
    const { credential } = issueRunnerCredential(db, runner);

    const result = revokeRunner(db, { runnerId: "runner-a", ownerId: "owner-impostor" });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(verifyRunnerCredential(db, credential).ok).toBe(true);
  });
});
