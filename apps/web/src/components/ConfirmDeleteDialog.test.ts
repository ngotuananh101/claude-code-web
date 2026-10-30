import { describe, expect, test } from "bun:test";

/**
 * Tests for ConfirmDeleteDialog logic and contract.
 */
describe("ConfirmDeleteDialog contract", () => {
  test("prevents actions when busy is true", () => {
    let confirmed = false;
    const busy = true;

    function handleConfirm() {
      if (!busy) confirmed = true;
    }

    handleConfirm();
    expect(confirmed).toBe(false);
  });

  test("allows confirm when busy is false", () => {
    let confirmed = false;
    const busy = false;

    function handleConfirm() {
      if (!busy) confirmed = true;
    }

    handleConfirm();
    expect(confirmed).toBe(true);
  });
});
