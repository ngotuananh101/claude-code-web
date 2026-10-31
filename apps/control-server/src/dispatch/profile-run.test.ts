import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  createProfile,
  getProfileWithSecret,
  migrate,
  Scheduler,
} from "@cc-web/control-db";
import type { RunProfilePayload } from "@cc-web/protocol";
import { createSecretBox } from "../config/secret-box.ts";
import { openSealedPayload, toEnvelope } from "./dispatcher.ts";

/**
 * End-to-end test for profile run dispatch (§17.1, §18.1).
 *
 * The seam under test is the real one: `Scheduler.dispatch` writes the outbox
 * row (redacted `payload`, sealed `payload_secure`), and `toEnvelope` rebuilds
 * the runner's live frame through `openSealedPayload` — the same opener the
 * server wires in `server.ts`. Nothing here re-implements the redaction or the
 * sealing; a regression in either producer surfaces as a failing assertion.
 *
 * The runner's own env-overlay tests (executor.ts) are out of scope: the
 * control-server has no `@cc-web/runner` dependency, so this test stops at the
 * frame the runner receives.
 */

const capacity = {
  runnerId: "runner-a",
  state: "ready" as const,
  maxConcurrentRuns: 1,
  activeRuns: 0,
};

/** Seal/redact exactly the way the server wires the Scheduler. */
function makeScheduler(db: Database, secretBox: ReturnType<typeof createSecretBox>): Scheduler {
  return new Scheduler(db, {
    sealSecurePayload: (value) => secretBox.seal(JSON.stringify(value)),
  });
}

/**
 * Create a profile with a sealed key and rebuild the `RunProfilePayload` the
 * run route would dispatch (runs-routes.ts opens the seal, then maps the row).
 */
function makeProfilePayload(
  db: Database,
  secretBox: ReturnType<typeof createSecretBox>,
): RunProfilePayload {
  const created = createProfile(db, {
    ownerId: "user-1",
    name: "9Router",
    endpoint: "http://192.168.2.3:20128",
    authField: "ANTHROPIC_AUTH_TOKEN",
    apiKey: secretBox.seal("sk-secret-key"),
    modelMapping: { sonnet: "prime", opus: "titan", haiku: "nano" },
    settingsJson: JSON.stringify({ env: { CUSTOM_VAR: "custom" }, extra: true }),
  });

  const row = getProfileWithSecret(db, created.id, "user-1");
  expect(row).not.toBeNull();
  const plainKey = secretBox.open(row!.apiKey!);
  expect(plainKey).toBe("sk-secret-key");

  return {
    profileId: row!.id,
    name: row!.name,
    endpoint: row!.endpoint,
    authField: row!.authField,
    apiKey: plainKey!,
    modelMapping: row!.modelMapping,
    settings: row!.settings,
  };
}

describe("profile run dispatch (§17.1, §18.1)", () => {
  test("dispatch persists a redacted payload; toEnvelope delivers the cleartext profile", async () => {
    const db = new Database(":memory:");
    migrate(db);

    const secretBox = createSecretBox(new Uint8Array(32).fill(42));
    const scheduler = makeScheduler(db, secretBox);
    const outbox = new CommandOutbox(db);
    const profile = makeProfilePayload(db, secretBox);

    const decision = await scheduler.dispatch(
      {
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "attempt-1",
        workspaceId: "default",
        prompt: "hello",
        ownerId: "user-1",
        profile,
      },
      capacity,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("dispatch refused");

    // The persisted row: redacted `payload`, sealed `payload_secure`.
    const row = outbox.get(decision.commandId);
    expect(row).toBeDefined();
    expect(row!.deliveryState).toBe("pending");

    const persistedProfile = (row!.payload as { profile?: RunProfilePayload }).profile;
    expect(persistedProfile).toBeDefined();
    expect(persistedProfile!.apiKey).toBe("[REDACTED]");
    // I5: every settings.env string is redacted on disk too — a credential the
    // operator put in the settings JSON instead of the apiKey field never
    // reaches `SELECT payload FROM command_outbox`.
    expect(persistedProfile!.settings).toEqual({
      env: { CUSTOM_VAR: "[REDACTED]" },
      extra: true,
    });
    expect(JSON.stringify(row!.payload)).not.toContain("sk-secret-key");
    expect(JSON.stringify(row!.payload)).not.toContain("custom");

    const storedSecure = row!.payloadSecure;
    expect(typeof storedSecure).toBe("string");
    expect(storedSecure as string).toMatch(/^v1\./);
    expect(storedSecure as string).not.toContain("sk-secret-key");

    // The live frame — rebuilt through the server's own opener — carries the
    // cleartext profile the runner's executor consumes.
    const envelope = toEnvelope(row!, (stored) =>
      openSealedPayload(stored, (sealed) => secretBox.open(sealed)),
    );

    const frameProfile = (envelope.payload as { profile?: RunProfilePayload }).profile;
    expect(frameProfile).toBeDefined();
    expect(frameProfile!.apiKey).toBe("sk-secret-key");
    expect(frameProfile!.profileId).toBe(profile.profileId);
    expect(frameProfile!.name).toBe("9Router");
    expect(frameProfile!.endpoint).toBe("http://192.168.2.3:20128");
    expect(frameProfile!.authField).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(frameProfile!.modelMapping).toEqual({ sonnet: "prime", opus: "titan", haiku: "nano" });
    expect(frameProfile!.settings).toEqual({ env: { CUSTOM_VAR: "custom" }, extra: true });

    // The rest of the run.start payload rides the live frame unchanged.
    const framePayload = envelope.payload as { prompt?: string; sessionId?: string };
    expect(framePayload.prompt).toBe("hello");
    expect(framePayload.sessionId).toBe("session-1");
    expect(envelope.kind).toBe("run.start");
  });

  test("toEnvelope falls back to the redacted payload when the seal cannot be opened", async () => {
    const db = new Database(":memory:");
    migrate(db);

    const secretBox = createSecretBox(new Uint8Array(32).fill(42));
    const scheduler = makeScheduler(db, secretBox);
    const outbox = new CommandOutbox(db);
    const profile = makeProfilePayload(db, secretBox);

    const decision = await scheduler.dispatch(
      {
        sessionId: "session-2",
        runId: "run-2",
        attemptId: "attempt-2",
        workspaceId: "default",
        prompt: "again",
        ownerId: "user-1",
        profile,
      },
      capacity,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("dispatch refused");

    const row = outbox.get(decision.commandId);
    expect(row).toBeDefined();

    // A rotated server secret: the opener cannot decrypt the row. The frame
    // must degrade to the redacted payload, never throw and never leak.
    const foreignSecretBox = createSecretBox(new Uint8Array(32).fill(99));
    const envelope = toEnvelope(row!, (stored) =>
      openSealedPayload(stored, (sealed) => foreignSecretBox.open(sealed)),
    );

    const frameProfile = (envelope.payload as { profile?: RunProfilePayload }).profile;
    expect(frameProfile).toBeDefined();
    expect(frameProfile!.apiKey).toBe("[REDACTED]");
    expect(frameProfile!.settings).toEqual({ env: { CUSTOM_VAR: "[REDACTED]" }, extra: true });
    expect(JSON.stringify(envelope.payload)).not.toContain("sk-secret-key");
  });
});
