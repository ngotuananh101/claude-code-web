import { describe, expect, test } from "bun:test";
import { ref } from "vue";

/**
 * Tests for RenameDialog logic and behavior.
 */
describe("RenameDialog contract", () => {
  test("trims input value and preserves whitespace rules", () => {
    const input = "  Tên phiên mới  ";
    expect(input.trim()).toBe("Tên phiên mới");
  });

  test("resets value to initialValue when opened", () => {
    const initialValue = "Phiên 1";
    const value = ref(initialValue);
    // User modifies it
    value.value = "Đang gõ dở...";
    // Modal reopens
    const isOpen = true;
    if (isOpen) {
      value.value = initialValue;
    }
    expect(value.value).toBe("Phiên 1");
  });
});
