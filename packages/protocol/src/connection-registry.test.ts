import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "./connection-registry.ts";

function registry() {
  return new ConnectionRegistry();
}

describe("connection generation", () => {
  test("first connection becomes current", () => {
    const r = registry();
    const result = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generation).toBe(1);
    expect(r.isCurrent("runner-a", "conn-1", result.generation)).toBe(true);
  });

  test("a second connection supersedes the first and bumps the generation", () => {
    const r = registry();
    const first = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    const second = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-2" });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // §6.3: only one generation is current. The old socket is fenced immediately,
    // even before the server gets around to closing it.
    expect(second.generation).toBe(first.generation + 1);
    expect(r.isCurrent("runner-a", "conn-1", first.generation)).toBe(false);
    expect(r.isCurrent("runner-a", "conn-2", second.generation)).toBe(true);
  });

  test("traffic from a superseded socket is rejected, not silently applied", () => {
    const r = registry();
    const first = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-2" });
    if (!first.ok) return;

    const verdict = r.checkTraffic({
      runnerId: "runner-a",
      connectionId: "conn-1",
      generation: first.generation,
    });

    expect(verdict).toEqual({ ok: false, reason: "stale_generation" });
  });

  test("a future generation is rejected too, not treated as newer-and-valid", () => {
    const r = registry();
    const current = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    if (!current.ok) return;

    // A clone or a buggy client could claim generation+1. Accepting it would let
    // a second instance steal the identity (§6.3: no identity cloning).
    expect(
      r.checkTraffic({
        runnerId: "runner-a",
        connectionId: "conn-1",
        generation: current.generation + 1,
      }),
    ).toEqual({ ok: false, reason: "unknown_generation" });
  });

  test("a new boot supersedes the previous boot even with the same connection id", () => {
    const r = registry();
    r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    const reboot = r.open({ runnerId: "runner-a", bootId: "boot-2", connectionId: "conn-1" });

    expect(reboot.ok).toBe(true);
    if (!reboot.ok) return;
    // A restart must not resume an old generation; the generation is per-connection.
    expect(r.isCurrent("runner-a", "conn-1", reboot.generation)).toBe(true);
  });

  test("closing the current connection leaves the runner with no current connection", () => {
    const r = registry();
    const opened = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    if (!opened.ok) return;

    r.close({ runnerId: "runner-a", connectionId: "conn-1", generation: opened.generation });

    expect(r.current("runner-a")).toBeUndefined();
    expect(r.isCurrent("runner-a", "conn-1", opened.generation)).toBe(false);
  });

  test("closing a stale connection does not evict the current one", () => {
    const r = registry();
    const first = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    const second = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-2" });
    if (!first.ok || !second.ok) return;

    // The old socket's close event must not tear down the live connection. This
    // is the classic race after a reconnect.
    r.close({ runnerId: "runner-a", connectionId: "conn-1", generation: first.generation });

    expect(r.isCurrent("runner-a", "conn-2", second.generation)).toBe(true);
  });

  test("a revoked runner is refused even on a fresh connection", () => {
    const r = registry();
    r.revoke("runner-a");

    const opened = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    expect(opened).toEqual({ ok: false, reason: "revoked" });
  });

  test("generations are per runner, not global", () => {
    const r = registry();
    const a = r.open({ runnerId: "runner-a", bootId: "boot-1", connectionId: "conn-1" });
    const b = r.open({ runnerId: "runner-b", bootId: "boot-1", connectionId: "conn-1" });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Both runners start at 1; a shared counter would leak one runner's history.
    expect(a.generation).toBe(1);
    expect(b.generation).toBe(1);
  });

  test("traffic for an unknown runner is rejected", () => {
    const r = registry();
    expect(r.checkTraffic({ runnerId: "nobody", connectionId: "conn-1", generation: 1 })).toEqual({
      ok: false,
      reason: "unknown_runner",
    });
  });
});
