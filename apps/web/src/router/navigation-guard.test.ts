import { describe, expect, test } from "bun:test";
import { evaluateNavigation } from "./navigation-guard.ts";

describe("evaluateNavigation", () => {
  test("redirects to /setup when setup is required, disconnecting socket", () => {
    expect(evaluateNavigation({ toPath: "/", isAuthorized: false, isSetupRequired: true })).toEqual(
      { redirect: "/setup", allow: false, socketAction: "disconnect" },
    );
    expect(
      evaluateNavigation({ toPath: "/login", isAuthorized: false, isSetupRequired: true }),
    ).toEqual({ redirect: "/setup", allow: false, socketAction: "disconnect" });
    expect(
      evaluateNavigation({ toPath: "/setup", isAuthorized: false, isSetupRequired: true }),
    ).toEqual({ allow: true, socketAction: "disconnect" });
  });

  test("redirects /setup to /login when setup is not required and unauthorized", () => {
    expect(
      evaluateNavigation({ toPath: "/setup", isAuthorized: false, isSetupRequired: false }),
    ).toEqual({ redirect: "/login", allow: false, socketAction: "disconnect" });
  });

  test("allows /login when unauthorized and setup is not required", () => {
    expect(
      evaluateNavigation({ toPath: "/login", isAuthorized: false, isSetupRequired: false }),
    ).toEqual({ allow: true, socketAction: "disconnect" });
  });

  test("redirects protected route to /login when unauthorized and setup is not required", () => {
    expect(
      evaluateNavigation({ toPath: "/runners", isAuthorized: false, isSetupRequired: false }),
    ).toEqual({ redirect: "/login", allow: false, socketAction: "disconnect" });
  });

  test("connects socket and allows protected routes when authorized", () => {
    expect(evaluateNavigation({ toPath: "/", isAuthorized: true, isSetupRequired: false })).toEqual(
      { allow: true, socketAction: "connect" },
    );
    expect(
      evaluateNavigation({ toPath: "/login", isAuthorized: true, isSetupRequired: false }),
    ).toEqual({ redirect: "/", allow: false, socketAction: "connect" });
  });
});
