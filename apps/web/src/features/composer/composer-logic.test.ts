import { describe, expect, test } from "bun:test";
import { buildRunRequest, type RunPayloadInputs } from "./composer-logic.ts";

/**
 * Testable surface of the Composer's send() (Task 12).
 *
 * `buildRunRequest` folds the component's conditional rules into one pure
 * function so the payload shape can be asserted without mounting the SFC.
 */

const BASE_INPUTS: RunPayloadInputs = {
  prompt: "do something",
  permission: "default",
  model: "default",
  effort: null,
  ultracode: false,
  workspaceId: undefined,
  projectRunnerId: undefined,
  runnerId: "",
  selectedSession: "new",
  isNewSessionPage: true,
};

function base(overrides: Partial<RunPayloadInputs> = {}): RunPayloadInputs {
  return { ...BASE_INPUTS, ...overrides };
}

describe("buildRunRequest", () => {
  test("omits attachmentIds when none are supplied", () => {
    const body = buildRunRequest(base());
    expect(body).not.toHaveProperty("attachmentIds");
    expect(body.prompt).toBe("do something");
  });

  test("includes attachmentIds when files were picked on the new-session page", () => {
    const body = buildRunRequest(
      base({ attachmentIds: ["att-1", "att-2"], workspaceId: "w-1", projectRunnerId: "r-1" }),
    );
    expect(body.attachmentIds).toEqual(["att-1", "att-2"]);
  });

  test("includes attachmentIds on an existing session page even without a folder", () => {
    const body = buildRunRequest(
      base({ attachmentIds: ["att-1"], isNewSessionPage: false, selectedSession: "sess-1" }),
    );
    expect(body.attachmentIds).toEqual(["att-1"]);
    expect(body.resumeSessionId).toBe("sess-1");
  });

  test("does not set attachmentIds when the array is empty", () => {
    const body = buildRunRequest(base({ attachmentIds: [] }));
    expect(body).not.toHaveProperty("attachmentIds");
  });
});
