import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { type BetterAuthInstance, createBetterAuth, signUpOwner } from "./better-auth.ts";

const BASE_URL = "http://control.test";

function freshAuth() {
  const db = new Database(":memory:");
  migrate(db);
  const auth = createBetterAuth(db, {
    baseURL: BASE_URL,
    trustedOrigins: ["http://web.test"],
  });
  return { db, auth };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return "";
  // "better-auth.session_token=…; Path=/; …" — the pair before the first
  // semicolon is what a cookie jar echoes back.
  return setCookie.split(";")[0] ?? "";
}

async function signIn(auth: BetterAuthInstance, body: unknown) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://web.test" },
      body: JSON.stringify(body),
    }),
  );
}

describe("createBetterAuth", () => {
  test("signUpOwner creates a username/password owner", async () => {
    const { db, auth } = freshAuth();
    const result = await signUpOwner(auth, { username: "owner", password: "dev-password" });

    expect(result.user.username).toBe("owner");
    const row = db.query("SELECT username FROM user WHERE id = ?").get(result.user.id) as {
      username: string;
    } | null;
    expect(row?.username).toBe("owner");
  });

  test("username sign-in sets a session cookie the server can resolve", async () => {
    const { auth } = freshAuth();
    await signUpOwner(auth, { username: "owner", password: "dev-password" });

    const response = await signIn(auth, { username: "owner", password: "dev-password" });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    expect(cookie).not.toBe("");

    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    // The plugin augments the user with `username` at runtime; the wrapper's
    // ReturnType erase keeps it out of the static type.
    expect((session?.user as { username?: string } | undefined)?.username).toBe("owner");
  });

  test("wrong password is refused without a session cookie", async () => {
    const { auth } = freshAuth();
    await signUpOwner(auth, { username: "owner", password: "dev-password" });

    const response = await signIn(auth, { username: "owner", password: "wrong" });
    expect(response.status).toBe(401);
    expect(cookieFrom(response)).toBe("");

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieFrom(response) }),
    });
    expect(session).toBeNull();
  });

  // No foreign-origin test here on purpose: better-auth force-disables its
  // origin check under test runners (`isTest()`), so this contract is
  // untestable at the library level. The Origin allowlist for /api/auth/*
  // is enforced — and tested — at the server's own route gate (server.test.ts).
});
