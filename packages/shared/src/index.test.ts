import { describe, expect, test } from "bun:test";
import { canonicalize } from "./index.ts";

describe("canonicalize", () => {
  test("sorts object keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("is stable for nested structures", () => {
    const left = { run: { prompt: "hi", model: "x" }, kind: "run.start" };
    const right = { kind: "run.start", run: { model: "x", prompt: "hi" } };
    expect(canonicalize(left)).toBe(canonicalize(right));
  });

  test("preserves array order, since order is semantic", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test("drops undefined values so an omitted optional field matches", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  test("distinguishes null from a missing field", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  test("distinguishes null from zero and empty string", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({ a: 0 }));
    expect(canonicalize({ a: null })).not.toBe(canonicalize({ a: "" }));
  });
});
