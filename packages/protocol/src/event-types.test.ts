import { describe, expect, test } from "bun:test";
import { EVENT_TYPES, type EventType } from "./index.ts";

/**
 * The event type registry.
 *
 * The union and the runtime list are held together by a compile-time check
 * (`_EventTypesAreComplete`), which catches an edit that reaches only one of
 * them. What it cannot catch is a member that reaches neither, or one that
 * reaches both but is never accepted on the wire — those need a runtime pin.
 */

describe("event types", () => {
  test("spool.warning is a known event type", () => {
    // §12.6's offline-spool signal is runner → server like every other event,
    // so it has to pass the same validation every other type passes. A member
    // the runner can emit but the server refuses would be a warning the
    // operator never sees.
    expect(EVENT_TYPES).toContain("spool.warning" as EventType);
  });

  test("the list has no duplicates and stays a set of distinct names", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
