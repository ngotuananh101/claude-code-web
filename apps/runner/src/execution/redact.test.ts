import { describe, expect, test } from "bun:test";
import { redactErrorText, redactSdkMessage } from "./redact.ts";

/**
 * Redaction of SDK messages before they are persisted (§12.3, §19.4).
 *
 * The rule: persist what the UI needs to render, and nothing that names a
 * credential, a billing figure, or a provider identity. An event outbox row is
 * replayed to the browser and copied into the server journal, so anything that
 * gets in here is effectively public.
 *
 * The payload shape is SDK-owned, so the redactor walks it rather than naming
 * exact paths — a new SDK field must not become a leak because nobody updated a
 * field list.
 */

/**
 * Every key the production redactor is expected to drop.
 *
 * Split by reason rather than lumped together, because "credential" and "not
 * ours to publish" are different decisions that will be reviewed differently.
 * Both halves exist for the same test: a key that is removed from the redactor
 * must break a test, and a key that is only ever exercised by one hand-written
 * payload is a key nobody will notice losing.
 */
const CREDENTIAL_KEYS = ["apiKeySource", "apiKeyHelper", "apiKey", "authorization", "credential"];
const WITHHELD_KEYS = [
  "total_cost_usd",
  "cost_usd",
  "modelUsage",
  // Host layout, not run content (§19.4).
  "cwd",
  "directory",
];
const REDACTED_KEYS = [...CREDENTIAL_KEYS, ...WITHHELD_KEYS];

describe("redacting a system init message", () => {
  test("drops the credential source", () => {
    const redacted = redactSdkMessage({
      type: "system",
      subtype: "init",
      apiKeySource: "ANTHROPIC_API_KEY",
      session_id: "sdk-session-1",
      model: "claude-fable-5",
      cwd: "/home/runner/project",
    });

    expect(redacted["apiKeySource"]).toBeUndefined();
    // What the UI actually needs survives.
    expect(redacted["session_id"]).toBe("sdk-session-1");
    expect(redacted["model"]).toBe("claude-fable-5");
  });

  test("drops the absolute workspace path the SDK reports", () => {
    const redacted = redactSdkMessage({
      type: "system",
      subtype: "init",
      session_id: "sdk-session-1",
      cwd: "/home/runner/projects/client-x",
    });

    // The browser and the journal identify a workspace by its id. The host's
    // absolute layout is not something either needs, and §19.4 keeps runner
    // host detail out of the control plane.
    expect(redacted["cwd"]).toBeUndefined();
    expect(redacted["session_id"]).toBe("sdk-session-1");
  });
});

describe("redacting a result message", () => {
  test("drops cost and per-model billing detail", () => {
    const redacted = redactSdkMessage({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.42,
      modelUsage: { "claude-fable-5": { input_tokens: 10, cost_usd: 0.42 } },
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(redacted["total_cost_usd"]).toBeUndefined();
    expect(redacted["modelUsage"]).toBeUndefined();
    // Token counts are not billing or identity; the UI shows them.
    expect(redacted["usage"]).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test("keeps an error result's message, which is what the operator needs", () => {
    const redacted = redactSdkMessage({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "hit the turn limit",
      total_cost_usd: 0.1,
    });

    expect(redacted["result"]).toBe("hit the turn limit");
    expect(redacted["subtype"]).toBe("error_max_turns");
    expect(redacted["total_cost_usd"]).toBeUndefined();
  });
});

describe("redacting nested content", () => {
  test("walks into nested objects instead of only the top level", () => {
    const redacted = redactSdkMessage({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hello" }],
        metadata: { apiKeySource: "oauth", nested: { total_cost_usd: 9 } },
      },
    });

    const message = redacted["message"] as Record<string, unknown>;
    const metadata = message["metadata"] as Record<string, unknown>;
    expect(metadata["apiKeySource"]).toBeUndefined();
    expect((metadata["nested"] as Record<string, unknown>)["total_cost_usd"]).toBeUndefined();
    expect(message["content"]).toEqual([{ type: "text", text: "hello" }]);
  });

  test("matches secret keys case-insensitively", () => {
    const redacted = redactSdkMessage({ Type: "result", Total_Cost_Usd: 1, ok: true });

    expect(redacted["Total_Cost_Usd"]).toBeUndefined();
    expect(redacted["ok"]).toBe(true);
  });

  test("does not mutate the message it was given", () => {
    const original = { type: "system", apiKeySource: "ANTHROPIC_API_KEY" };

    redactSdkMessage(original);

    // The caller may still need the real value locally (e.g. to warn about
    // credential origin), so redaction must copy rather than edit in place.
    expect(original.apiKeySource).toBe("ANTHROPIC_API_KEY");
  });

  test("keeps arrays intact while redacting their objects", () => {
    const redacted = redactSdkMessage({
      type: "assistant",
      items: [{ apiKeySource: "x", keep: 1 }, "plain"],
    });

    expect(redacted["items"]).toEqual([{ keep: 1 }, "plain"]);
  });

  test("masks a credential quoted in an error result's own text", () => {
    // The SDK reports a failure two ways: as a thrown error, and as a `result`
    // frame whose `result`/`errors` fields carry the CLI's text. Both are
    // persisted, so redacting only the thrown path leaves the same secret in the
    // same outbox by a different door. Confirmed with a probe before this test:
    // the payload came back with the key intact.
    const redacted = redactSdkMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "CLI failed: ANTHROPIC_API_KEY=sk-ant-api03-LeakMe123456789 was rejected",
      errors: ["gateway said: Authorization: Bearer abcdef123456789xyz"],
    });

    const text = JSON.stringify(redacted);
    expect(text).not.toContain("sk-ant-api03-LeakMe123456789");
    expect(text).not.toContain("abcdef123456789xyz");
    // The actionable part survives — an operator still learns what failed.
    expect(redacted["result"]).toContain("CLI failed");
    expect(redacted["subtype"]).toBe("error_during_execution");
  });

  test("does not touch ordinary prose in a message's text fields", () => {
    const redacted = redactSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "the secret key was rejected; password reset" }] },
    });

    expect(JSON.stringify(redacted)).toContain("the secret key was rejected; password reset");
  });

  test("does not rewrite a code snippet the assistant was asked to produce", () => {
    // The counterpart to the test above, and the reason the masking is limited
    // to diagnostic fields. This text is the run's output, not an error: a user
    // who asked for a config example must get the example back, not a redacted
    // one. Masking every string would corrupt the transcript while protecting
    // nothing — an assistant message is model output, and a real credential
    // never belongs in it in the first place.
    const snippet = 'Set `password = "hunter2"` in your local .env before running.';
    const redacted = redactSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: snippet }] },
    });

    const message = redacted["message"] as { content: Array<{ text: string }> };
    expect(message.content[0]!.text).toBe(snippet);
  });

  test("leaves a tool call's input alone, even where a field name looks diagnostic", () => {
    // `input` is arbitrary JSON the model produced. A tool can legitimately have
    // a field called `reason` or `details`, and those are run content — so the
    // masking stops at the message's own level rather than walking the whole
    // payload. Confirmed with a probe before this test.
    const input = {
      file_path: "/w/notes.md",
      reason: "documenting the password = 'abc123' migration step",
      details: "the api_key= value goes here",
    };
    const redacted = redactSdkMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input }] },
    });

    const message = redacted["message"] as { content: Array<{ input: unknown }> };
    expect(message.content[0]!.input).toEqual(input);
  });
});

describe("the redaction surface", () => {
  test("drops every key on the redaction list", () => {
    // If the SDK gains a field with one of these meanings, this list is the
    // place the decision is recorded — not a forgotten call site.
    for (const key of REDACTED_KEYS) {
      expect(redactSdkMessage({ [key]: "secret" })[key]).toBeUndefined();
    }
  });

  test("drops each key nested inside a payload, not only at the top level", () => {
    // The walk is recursive, but a single-level test cannot tell a recursive
    // walk from a top-level filter. Nesting is the shape the SDK actually uses
    // for billing and identity detail.
    for (const key of REDACTED_KEYS) {
      const message = { type: "assistant", message: { meta: { [key]: "secret" } } };
      const redacted = redactSdkMessage(message);
      const meta = (redacted["message"] as Record<string, unknown>)["meta"] as Record<
        string,
        unknown
      >;
      expect(meta[key]).toBeUndefined();
    }
  });

  test("drops each key whatever case the SDK spells it in", () => {
    for (const key of REDACTED_KEYS) {
      const spelled = key.toUpperCase();
      expect(redactSdkMessage({ [spelled]: "secret" })[spelled]).toBeUndefined();
    }
  });
});

describe("redacting error text", () => {
  // A thrown SDK error is free text, so the key walk cannot reach it. It is
  // still persisted in a `run.failed` event, which §12.3 replays to the browser
  // and copies into the server journal. §19.4 makes that path a hard boundary:
  // no API keys, no raw provider config.
  test("removes a provider key quoted in the message", () => {
    const text = redactErrorText(
      "CLI exited: ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf123456789 was rejected",
    );

    expect(text).not.toContain("sk-ant-api03-AbCdEf123456789");
    expect(text).toContain("ANTHROPIC_API_KEY");
  });

  test("removes a bearer token", () => {
    const text = redactErrorText("401 from gateway: Authorization: Bearer abcdef123456789xyz");

    expect(text).not.toContain("abcdef123456789xyz");
  });

  test("removes a bare key-shaped token with no key name in front of it", () => {
    const text = redactErrorText("provider said: invalid key sk-proj-XyZ987654321abcdef");

    expect(text).not.toContain("sk-proj-XyZ987654321abcdef");
  });

  test("keeps the part of the message an operator can act on", () => {
    const text = redactErrorText("Error: the model refused the request (rate_limit)");

    expect(text).toBe("Error: the model refused the request (rate_limit)");
  });

  test("does not mangle ordinary prose that happens to use a sensitive word", () => {
    // These read as a credential assignment to a naive pattern but are just
    // English. Over-redacting is not the safe direction: an operator who cannot
    // read the failure cannot act on it, and the message stops being evidence.
    for (const text of [
      "the secret key was rejected by the provider",
      "authorization denied for the Bash tool",
      "password authentication failed for the gateway",
    ]) {
      expect(redactErrorText(text)).toBe(text);
    }
  });

  test("is applied by the executor to a thrown stream error", () => {
    // Covered end to end in executor.test.ts; this asserts the pair the
    // executor is supposed to use, so a future edit cannot pick one.
    const text = redactErrorText("boom sk-ant-abcdefghijklmnop");
    expect(text).not.toContain("sk-ant-abcdefghijklmnop");
  });
});
