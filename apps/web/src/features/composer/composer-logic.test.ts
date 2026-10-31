import { describe, expect, test } from "bun:test";
import { buildRunRequest, type RunPayloadInputs, resolveModelLabel } from "./composer-logic.ts";

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
  profileId: null,
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

  // --- Task 7: Profile selection (§4.5.3) ---
  test("includes profileId in StartRunRequest when a profile is selected", () => {
    const req = buildRunRequest({
      ...base(),
      prompt: "hello",
      permission: "default",
      model: "sonnet",
      effort: null,
      ultracode: false,
      profileId: "prof_123",
    });
    expect(req.profileId).toBe("prof_123");
  });

  test("omits profileId (field absent) when no profile is selected", () => {
    const req = buildRunRequest(base());
    expect(req).not.toHaveProperty("profileId");
  });

  test("omits profileId when profileId is undefined", () => {
    const req = buildRunRequest({ ...base(), profileId: undefined });
    expect(req).not.toHaveProperty("profileId");
  });
});

describe("resolveModelLabel", () => {
  test("appends the mapped upstream name when a mapping exists (§7.4)", () => {
    const label = resolveModelLabel({
      model: "sonnet",
      profile: { modelMapping: { sonnet: "prime" } },
    });
    expect(label).toBe("Sonnet (prime)");
  });

  test("falls back to the plain label when no mapping is present", () => {
    const label = resolveModelLabel({ model: "sonnet", profile: { modelMapping: {} } });
    expect(label).toBe("Sonnet");
  });

  test("falls back to the plain label when model is unmapped in a partial mapping", () => {
    const label = resolveModelLabel({
      model: "opus",
      profile: { modelMapping: { sonnet: "prime" } },
    });
    expect(label).toBe("Opus");
  });

  test("falls back to the plain label when the profile is absent", () => {
    const label = resolveModelLabel({ model: "haiku" });
    expect(label).toBe("Haiku");
  });
});
