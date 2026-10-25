/**
 * Redaction of SDK messages before persistence (§12.3, §19.4).
 *
 * An event that reaches the runner's outbox is replayed to the browser and
 * copied into the server journal, so it is effectively public. What must never
 * be in it: where the provider credential came from, and what the run cost.
 *
 * The redactor walks the payload and matches key names rather than listing
 * exact paths. The SDK's message shapes are its own to change, and a field list
 * that has to be updated in lockstep is a list that will eventually be missed.
 */

/** Key names that name a credential, a credential origin, or a billing figure. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "apikeysource",
  "apikeyhelper",
  "apikey",
  "authorization",
  "credential",
  "total_cost_usd",
  "modelusage",
  "cost_usd",
  // Host layout, not run content. The browser and the journal address a
  // workspace by id; the absolute path adds nothing they can use and tells them
  // how the runner's filesystem is arranged (§19.4).
  "cwd",
  "directory",
]);

export function redactSdkMessage(message: unknown): Record<string, unknown> {
  const redacted = redactValue(message);
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

/**
 * Patterns for credential material inside free text (§19.4).
 *
 * A thrown SDK or CLI error is a string, so the key walk above never sees it —
 * and that error is persisted in `run.failed`, which is replayed to the browser.
 * The rule from §19.4 is that API keys and raw provider config never reach the
 * control plane, so the key itself is masked while the fact that a key was
 * rejected stays readable.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // `Authorization: Bearer <token>` — the token is one word further along than
  // the `NAME: value` rule below assumes, so it is handled first.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // `NAME=value` or `NAME: value` where NAME names a credential.
  //
  // The separator is required, and whitespace is not one: `secret` and
  // `authorization` are ordinary words in an error message, and redacting
  // "the secret key was rejected" leaves an operator with nothing to read. A
  // value assigned to a credential name is the shape that actually leaks.
  [
    /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)(\s*[:=]\s*)(\S+)/gi,
    "$1$2[REDACTED]",
  ],
  // A key-shaped token with no name in front of it. Masked on shape, because a
  // leaked secret does not promise to be labelled.
  [/\b(sk|pk|rk|ant|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]"],
];

/**
 * Strip credential material out of free text before it is persisted.
 *
 * Truncation is not redaction: an error message quoting an environment variable
 * or a request header would otherwise land in the journal verbatim.
 */
export function redactErrorText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The one-line view of a tool call that travels with `approval.requested`
 * (§13.1). The full input never leaves the runner — the journal carries this
 * summary, so it gets the same secret masking as error text and a hard size
 * cap that keeps one huge `Write` input from bloating the event payload.
 */
export function summarizeToolInput(input: unknown): string {
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? null);
  return redactErrorText(raw).slice(0, 2000);
}

/**
 * Fields whose value is diagnostic text rather than run content.
 *
 * The SDK reports a failure two ways: as a thrown error, and as a `result`
 * frame whose `result`/`errors` fields quote the CLI's own output. The second
 * path reaches the outbox through the ordinary message loop, so it needs the
 * same masking as the first — a probe showed the key arriving intact.
 *
 * Two limits keep this from rewriting the transcript, because over-redaction is
 * a failure too:
 *
 *  - only fields at the message's own level, not fields deep inside it. A tool
 *    call's `input` is arbitrary JSON the model produced, and a real tool can
 *    legitimately have a field named `reason` or `details`.
 *  - only these names. An assistant message that shows a code snippet
 *    containing `password = "..."` is output the user asked for, not a leak.
 */
const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set([
  "result",
  "errors",
  "error",
  "reason",
  "details",
  "stderr",
]);

function redactValue(value: unknown, key?: string, depth = 0): unknown {
  // Arrays do not add a level: `errors: ["…"]` is a message-level field whose
  // entries are that field's text.
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key, depth));
  if (typeof value !== "object" || value === null) {
    if (typeof value !== "string") return value;
    return depth === 1 && key !== undefined && DIAGNOSTIC_KEYS.has(key.toLowerCase())
      ? redactErrorText(value)
      : value;
  }

  // A new object every time: the caller may still need the real values locally,
  // and editing in place would silently change the SDK's own message.
  const out: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(entryKey.toLowerCase())) continue;
    out[entryKey] = redactValue(entry, entryKey, depth + 1);
  }
  return out;
}
