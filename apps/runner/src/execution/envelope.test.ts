import { describe, expect, test } from "bun:test";
import { asCommandEnvelope } from "./envelope.ts";

/**
 * Parsing an unknown frame into a command envelope (§9.1, §9.3).
 *
 * Everything arriving on the socket is untrusted. This is the single place a
 * frame becomes a typed envelope, so the answer to "what does a malformed
 * command look like downstream" has exactly one definition.
 *
 * Optional fields are copied only when they are the expected type. A malformed
 * value becomes "absent" rather than a value the inbox would store and later
 * trust.
 */

const valid = {
  protocolVersion: 1,
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start",
  issuedAt: "2026-10-23T00:00:00.000Z",
  payload: { prompt: "hi" },
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  expiresAt: "2026-10-24T00:00:00.000Z",
  assignmentEpoch: 3,
};

describe("a well-formed command", () => {
  test("keeps every field, including the optional ones", () => {
    const parsed = asCommandEnvelope(valid);

    expect(parsed).toEqual({
      protocolVersion: 1,
      commandId: "cmd-1",
      runnerId: "runner-a",
      kind: "run.start",
      issuedAt: "2026-10-23T00:00:00.000Z",
      payload: { prompt: "hi" },
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      expiresAt: "2026-10-24T00:00:00.000Z",
      assignmentEpoch: 3,
    });
  });

  test("does not require the optional fields", () => {
    const parsed = asCommandEnvelope({
      protocolVersion: 1,
      commandId: "cmd-1",
      runnerId: "runner-a",
      kind: "run.start",
      issuedAt: "2026-10-23T00:00:00.000Z",
      payload: null,
    });

    expect(parsed?.commandId).toBe("cmd-1");
    expect(parsed?.sessionId).toBeUndefined();
  });
});

describe("a command that cannot be trusted", () => {
  test("is rejected when a required field is missing", () => {
    for (const key of ["commandId", "runnerId", "kind", "issuedAt", "protocolVersion"]) {
      const broken: Record<string, unknown> = { ...valid };
      delete broken[key];
      expect(asCommandEnvelope(broken)).toBeUndefined();
    }
  });

  test("is rejected when a required field has the wrong type", () => {
    expect(asCommandEnvelope({ ...valid, protocolVersion: "1" })).toBeUndefined();
    expect(asCommandEnvelope({ ...valid, commandId: 42 })).toBeUndefined();
    expect(asCommandEnvelope({ ...valid, kind: "" })).toBeUndefined();
  });

  test("drops an optional field of the wrong type instead of storing it", () => {
    const parsed = asCommandEnvelope({ ...valid, attemptId: 7, assignmentEpoch: "3" });

    // "Absent" is a state the inbox understands; a number where an id belongs
    // is not, and storing it would make a later comparison silently false.
    expect(parsed?.attemptId).toBeUndefined();
    expect(parsed?.assignmentEpoch).toBeUndefined();
    expect(parsed?.commandId).toBe("cmd-1");
  });

  test("rejects a non-object", () => {
    expect(asCommandEnvelope(null)).toBeUndefined();
    expect(asCommandEnvelope("cmd-1")).toBeUndefined();
    expect(asCommandEnvelope(undefined)).toBeUndefined();
  });
});
