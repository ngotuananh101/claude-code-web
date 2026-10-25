import { describe, expect, test } from "bun:test";
import { defaultWorkspaceResolver } from "./workspaces.ts";

/**
 * The MVP bridge between §11.1's "the user picks a workspace already bound to
 * the runner" and a runner that has no registration flow yet: the operator
 * names one directory in the environment, and the server's default dispatches
 * ("default") land there. Any other workspace id stays unknown, which the run
 * controller refuses honestly rather than guessing a path.
 */

describe("default workspace resolver", () => {
  test("an unset or blank environment value maps nothing", () => {
    expect(defaultWorkspaceResolver(undefined)("default")).toBeUndefined();
    expect(defaultWorkspaceResolver("   ")("default")).toBeUndefined();
  });

  test("the environment value answers exactly the default workspace", () => {
    const resolve = defaultWorkspaceResolver("/srv/project");
    expect(resolve("default")).toBe("/srv/project");
  });

  test("other workspace ids stay unknown — no path is invented", () => {
    const resolve = defaultWorkspaceResolver("/srv/project");
    expect(resolve("other")).toBeUndefined();
    expect(resolve("")).toBeUndefined();
  });

  test("a value with surrounding whitespace is used trimmed", () => {
    expect(defaultWorkspaceResolver("  /srv/project  ")("default")).toBe("/srv/project");
  });
});
