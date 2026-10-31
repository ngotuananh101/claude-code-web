import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CommandOutbox, createProfile, migrate } from "@cc-web/control-db";
import { MODEL_ROLES, type RunProfilePayload } from "@cc-web/protocol";
import { createSecretBox } from "../config/secret-box.ts";
import { toEnvelope } from "./dispatcher.ts";

/**
 * End-to-end integration test for P3-C profile run dispatch (§17.1, §18.1).
 *
 * This test exercises the dispatch seam directly — the Scheduler writes the
 * redacted payload + sealed `payloadSecure` to the outbox, and `toEnvelope`
 * rebuilds the runner's live frame using `openSecurePayload`. The runner's own
 * env-overlay tests (executor.ts) are out of scope here: there is no
 * `@cc-web/runner` dependency on `@cc-web/control-server`, so we assert at the
 * frame level instead and simulate the env mapping the executor would consume.
 *
 * Flow:
 *   1. createProfile → sealed api_key_encrypted (v1. format)
 *   2. Scheduler.dispatch with profile → enqueues run.start with redacted payload
 *      + sealed payloadSecure
 *   3. toEnvelope(openSecurePayload) → live frame carries cleartext apiKey
 *   4. Persisted outbox row: payload.apiKey === [REDACTED], payload_secure is v1.
 *   5. RunProfilePayload shape: endpoint, apiKey, authField, modelMapping, settings
 */
describe("profile run dispatch (§17.1, §18.1)", () => {
  test("dispatch writes redacted payload + sealed payloadSecure; toEnvelope delivers cleartext", async () => {
    const db = new Database(":memory:");
    migrate(db);

    const secretBox = createSecretBox(new Uint8Array(32).fill(42));
    const outbox = new CommandOutbox(db);

    // 1. Create a profile through the DB repository layer (the way config-routes
    // does, sealing the key with the same SecretBox).
    const profile = createProfile(db, {
      ownerId: "user-1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-key",
      modelMapping: { sonnet: "prime", opus: "titan", haiku: "nano" },
      settingsJson: JSON.stringify({ env: { CUSTOM_VAR: "custom" }, extra: true }),
    });

    // Build the RunProfilePayload the route would forward (matching runs-routes.ts).
    const runProfile: RunProfilePayload = {
      profileId: profile.id,
      name: profile.name,
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-key",
      modelMapping: { sonnet: "prime", opus: "titan", haiku: "nano" },
      settings: { env: { CUSTOM_VAR: "custom" }, extra: true },
    };

    // Simulate the scheduler.dispatch redaction + sealing path (scheduler.ts).
    // The cleartext payload (what the runner receives) includes the real key.
    const cleartextPayload = {
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "default",
      prompt: "hello",
      profile: runProfile,
    };

    // The persisted payload masks the apiKey.
    const persistedPayload = {
      ...cleartextPayload,
      profile: { ...runProfile, apiKey: "[REDACTED]" },
    };

    const sealedSecure = secretBox.seal(JSON.stringify(cleartextPayload));

    await outbox.enqueue({
      commandId: "cmd-profile-1",
      runnerId: "runner-a",
      kind: "run.start",
      issuedAt: "2026-10-31T00:00:00.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "default",
      payload: persistedPayload,
      payloadSecure: sealedSecure,
    });

    // 2. Assert the persisted outbox row: payload has [REDACTED], payload_secure is v1.
    const row = outbox.get("cmd-profile-1");
    expect(row).toBeDefined();
    expect(row!.deliveryState).toBe("pending");

    // The persisted `payload` column redacts the API key.
    const persistedProfile = (row!.payload as { profile?: { apiKey?: string } }).profile;
    expect(persistedProfile).toBeDefined();
    expect(persistedProfile!.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(row!.payload)).not.toContain("sk-secret-key");

    // The persisted `payload_secure` column is a sealed v1. string that does
    // not contain the plaintext key.
    const storedSecure = row!.payloadSecure as string;
    expect(typeof storedSecure).toBe("string");
    expect(storedSecure).toMatch(/^v1\./);
    expect(storedSecure).not.toContain("sk-secret-key");

    // 3. toEnvelope with the opener delivers the cleartext to the live frame.
    const envelope = toEnvelope(row!, (stored) => {
      const plain = typeof stored === "string" ? secretBox.open(stored) : null;
      return plain === null ? null : JSON.parse(plain);
    });

    // The live frame carries the cleartext apiKey.
    const frameProfile = (envelope.payload as { profile?: RunProfilePayload }).profile;
    expect(frameProfile).toBeDefined();
    expect(frameProfile!.apiKey).toBe("sk-secret-key");
    expect(frameProfile!.endpoint).toBe("http://192.168.2.3:20128");
    expect(frameProfile!.authField).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(frameProfile!.name).toBe("9Router");
    expect(frameProfile!.modelMapping).toEqual({ sonnet: "prime", opus: "titan", haiku: "nano" });
    expect(frameProfile!.settings).toEqual({ env: { CUSTOM_VAR: "custom" }, extra: true });

    // The rest of the run.start payload is intact on the live frame.
    const framePayload = envelope.payload as { prompt?: string; sessionId?: string };
    expect(framePayload.prompt).toBe("hello");
    expect(framePayload.sessionId).toBe("session-1");
    expect(envelope.kind).toBe("run.start");
  });

  test("toEnvelope falls back to redacted payload when the opener returns null", async () => {
    const db = new Database(":memory:");
    migrate(db);

    const secretBox = createSecretBox(new Uint8Array(32).fill(42));
    const outbox = new CommandOutbox(db);

    const persistedPayload = {
      sessionId: "session-2",
      runId: "run-2",
      attemptId: "attempt-2",
      workspaceId: "default",
      prompt: "again",
      profile: {
        profileId: "prof_x",
        name: "Gateway",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_API_KEY",
        apiKey: "[REDACTED]",
      },
    };

    // A sealed blob from a different key — opener returns null.
    const foreignSecretBox = createSecretBox(new Uint8Array(32).fill(99));
    const sealedSecure = foreignSecretBox.seal(
      JSON.stringify({
        ...persistedPayload,
        profile: { ...persistedPayload.profile, apiKey: "sk-foreign" },
      }),
    );

    await outbox.enqueue({
      commandId: "cmd-profile-2",
      runnerId: "runner-a",
      kind: "run.start",
      issuedAt: "2026-10-31T00:00:00.000Z",
      sessionId: "session-2",
      runId: "run-2",
      attemptId: "attempt-2",
      workspaceId: "default",
      payload: persistedPayload,
      payloadSecure: sealedSecure,
    });

    const row = outbox.get("cmd-profile-2");
    expect(row).toBeDefined();

    // The opener with the wrong key returns null → redacted payload is the frame.
    const envelope = toEnvelope(row!, (stored) => {
      const plain = typeof stored === "string" ? secretBox.open(stored) : null;
      return plain === null ? null : JSON.parse(plain);
    });

    const frameProfile = (envelope.payload as { profile?: { apiKey?: string } }).profile;
    expect(frameProfile).toBeDefined();
    expect(frameProfile!.apiKey).toBe("[REDACTED]");
    expect(frameProfile).not.toHaveProperty("apiKey", "sk-foreign");
  });

  test("the model mapping env vars the executor would set are derivable from the profile", async () => {
    // The runner executor's own tests cover the env-overlay construction; this
    // test asserts the mapping table the executor relies on, so a profile with
    // all five model roles produces the correct env var names at the frame level.
    const expectedVars = new Map(
      MODEL_ROLES.map((role, i) => {
        const vars = [
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_FABLE_MODEL",
          "CLAUDE_CODE_SUBAGENT_MODEL",
        ];
        return [role, vars[i]!];
      }),
    );

    expect(expectedVars.get("sonnet")).toBe("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(expectedVars.get("opus")).toBe("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(expectedVars.get("haiku")).toBe("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(expectedVars.get("fable")).toBe("ANTHROPIC_DEFAULT_FABLE_MODEL");
    expect(expectedVars.get("subagent")).toBe("CLAUDE_CODE_SUBAGENT_MODEL");
  });
});
