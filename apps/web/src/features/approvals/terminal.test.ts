import { describe, expect, test } from "bun:test";
import { mapApprovalTerminals } from "./terminal.ts";

/** The journal row shape EventJournal feeds in (type + raw payload). */
function row(type: string, payload: unknown): { type: string; payload: unknown } {
  return { type, payload };
}

describe("mapApprovalTerminals", () => {
  test("an approval.resolved with decision allow maps to allowed", () => {
    const terminals = mapApprovalTerminals([
      row("approval.resolved", { approvalId: "a1", decision: "allow", source: "user" }),
    ]);
    expect(terminals.get("a1")).toEqual({ decision: "allow" });
  });

  test("an approval.resolved with decision deny maps to denied", () => {
    const terminals = mapApprovalTerminals([
      row("approval.resolved", { approvalId: "a1", decision: "deny", source: "user" }),
    ]);
    expect(terminals.get("a1")).toEqual({ decision: "deny" });
  });

  test("a resolved payload with a garbled decision contributes nothing", () => {
    // The runner only ever emits "allow"|"deny"; anything else must not be
    // displayed as allowed (that is the F4 finding).
    for (const decision of ["true", "", 1, null, undefined]) {
      const terminals = mapApprovalTerminals([
        row("approval.resolved", { approvalId: "a1", decision }),
      ]);
      expect(terminals.has("a1")).toBe(false);
    }
  });

  test("a resolved payload without an approvalId is ignored", () => {
    const terminals = mapApprovalTerminals([row("approval.resolved", { decision: "allow" })]);
    expect(terminals.size).toBe(0);
  });

  test("an approval.expired with reason timeout maps to expired", () => {
    const terminals = mapApprovalTerminals([
      row("approval.expired", { approvalId: "a1", reason: "timeout" }),
    ]);
    expect(terminals.get("a1")).toEqual({ reason: "timeout" });
  });

  test("an approval.expired with a missing or empty reason maps to an empty terminal", () => {
    const missing = mapApprovalTerminals([row("approval.expired", { approvalId: "a1" })]);
    expect(missing.get("a1")).toEqual({});
    const empty = mapApprovalTerminals([row("approval.expired", { approvalId: "a1", reason: "" })]);
    expect(empty.get("a1")).toEqual({});
    const garbled = mapApprovalTerminals([
      row("approval.expired", { approvalId: "a1", reason: 42 }),
    ]);
    expect(garbled.get("a1")).toEqual({});
  });

  test("event types other than approval terminals are ignored", () => {
    const terminals = mapApprovalTerminals([
      row("approval.requested", { approvalId: "a1" }),
      row("run.started", { approvalId: "a1" }),
    ]);
    expect(terminals.size).toBe(0);
  });

  test("a null payload is tolerated", () => {
    const terminals = mapApprovalTerminals([row("approval.resolved", null)]);
    expect(terminals.size).toBe(0);
  });

  test("a later event for the same id overwrites the earlier one", () => {
    const terminals = mapApprovalTerminals([
      row("approval.resolved", { approvalId: "a1", decision: "allow" }),
      row("approval.expired", { approvalId: "a1", reason: "timeout" }),
    ]);
    expect(terminals.get("a1")).toEqual({ reason: "timeout" });
  });
});
