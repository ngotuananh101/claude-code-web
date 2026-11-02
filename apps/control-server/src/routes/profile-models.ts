/**
 * Model catalogue lookup for the profile editor.
 *
 * Anthropic-compatible gateways expose a `GET {endpoint}/models` catalogue
 * behind the same credential a profile already stores. The browser never holds
 * that credential (the API only returns a mask), so the lookup runs here: the
 * handler resolves the key from the typed form value or from the sealed stored
 * secret, calls the gateway, and returns just the model ids. Keeping the call
 * server-side also sidesteps CORS on a gateway the operator runs on a LAN.
 *
 * The endpoint is operator-supplied and already trusted as a run target, so the
 * outbound request adds no reach the dispatcher does not already have.
 */

import type { Database } from "bun:sqlite";
import { getProfileWithSecret } from "@cc-web/control-db";
import type { ProfileAuthField } from "@cc-web/protocol";
import type { SecretBox } from "../config/secret-box.ts";

type AuthorizedUser = { userId: string; username?: string };

/** Injectable fetch, so the handler's HTTP behaviour is testable without a socket. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ProfileModelsOptions = {
  db: Database;
  secretBox: SecretBox;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Outbound timeout in milliseconds; defaults to 10 s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Validate an endpoint: must be a valid http/https URL. */
function validateEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-empty string among the given keys of a model entry. */
function entryId(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (!isRecord(entry)) return undefined;
  for (const key of ["id", "name", "model", "display_name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Read a model catalogue from the shapes gateways return: an OpenAI/Anthropic
 * `{ data: [...] }`, a `{ models: [...] }`, or a bare array. Entries may be
 * strings or objects carrying `id` / `name` / `model` / `display_name`.
 * Duplicates collapse and blank entries drop, so the editor gets a clean list.
 */
export function parseModelList(body: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(body)) {
    entries = body;
  } else if (isRecord(body)) {
    if (Array.isArray(body["data"])) entries = body["data"];
    else if (Array.isArray(body["models"])) entries = body["models"];
  }

  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of entries) {
    const id = entryId(entry);
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      models.push(id);
    }
  }
  return models;
}

/** The credential headers a gateway expects for the profile's auth field. */
function authHeaders(authField: ProfileAuthField, apiKey: string): Record<string, string> {
  if (authField === "ANTHROPIC_API_KEY") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

/**
 * `POST /api/config/profiles/models`
 *
 * Body: `{ endpoint?, authField?, apiKey?, profileId? }`. A `profileId` fills
 * any field the body leaves out (endpoint, auth field, sealed key), so the
 * edit form can ask with a bare id. A typed `apiKey` always wins over the
 * stored one, since the operator may be replacing it before saving.
 */
export async function handleListProfileModels(
  request: Request,
  options: ProfileModelsOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("METHOD_NOT_ALLOWED", "Dùng POST cho endpoint này.", 405);
  }

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (!isRecord(parsed)) throw new Error("not an object");
    record = parsed;
  } catch {
    return jsonError("BAD_REQUEST", "Body phải là một đối tượng JSON.", 400);
  }

  const profileId =
    typeof record["profileId"] === "string" && record["profileId"] !== ""
      ? record["profileId"]
      : undefined;
  const stored =
    profileId !== undefined ? getProfileWithSecret(options.db, profileId, authorized.userId) : null;
  if (profileId !== undefined && stored === null) {
    return jsonError("NOT_FOUND", "Profile không tồn tại.", 404);
  }

  const endpoint = validateEndpoint(
    typeof record["endpoint"] === "string" && record["endpoint"].trim() !== ""
      ? record["endpoint"]
      : stored?.endpoint,
  );
  if (endpoint === undefined) {
    return jsonError("BAD_REQUEST", "Endpoint không hợp lệ.", 400);
  }

  const authField: ProfileAuthField =
    record["authField"] === "ANTHROPIC_API_KEY" || record["authField"] === "ANTHROPIC_AUTH_TOKEN"
      ? record["authField"]
      : (stored?.authField ?? "ANTHROPIC_AUTH_TOKEN");

  let apiKey: string | undefined;
  if (typeof record["apiKey"] === "string" && record["apiKey"].trim() !== "") {
    apiKey = record["apiKey"].trim();
  } else if (stored?.apiKey !== undefined) {
    apiKey = options.secretBox.open(stored.apiKey) ?? undefined;
  }
  if (apiKey === undefined) {
    return jsonError("BAD_REQUEST", "Cần API key để lấy danh sách model.", 400);
  }

  const url = `${endpoint.trim().replace(/\/+$/, "")}/models`;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = (field: ProfileAuthField): Promise<Response> =>
    fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders(field, apiKey!) },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response: Response;
  try {
    response = await call(authField);
    // Gateways are split between bearer tokens and Anthropic's x-api-key.
    // A rejected credential is worth one retry under the other convention
    // before reporting the profile as unauthenticated.
    if (response.status === 401 || response.status === 403) {
      const alternate: ProfileAuthField =
        authField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
      response = await call(alternate);
    }
  } catch {
    return jsonError("UPSTREAM_UNREACHABLE", "Không kết nối được tới gateway.", 502);
  }

  if (!response.ok) {
    return jsonError(
      "UPSTREAM_ERROR",
      `Gateway trả về HTTP ${response.status} khi lấy danh sách model.`,
      502,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return jsonError("UPSTREAM_ERROR", "Gateway trả về dữ liệu không phải JSON.", 502);
  }

  return json({ models: parseModelList(body) });
}
