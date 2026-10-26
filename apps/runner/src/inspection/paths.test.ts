import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRefusedCredentialBasename, resolveInsideWorkspace } from "./paths.ts";

/**
 * Path containment (§15.2, Ruling 7).
 *
 * The one entry point every inspect op routes its `path` through. The tests
 * pin the *order* of the refusals as much as the refusals themselves: a `..`
 * that also names a credential must be reported as traversal, because a caller
 * that got `CREDENTIAL_FILE_REFUSED` would learn the resolver looked past the
 * workspace boundary before it decided.
 */

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-paths-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveInsideWorkspace", () => {
  test("resolves a plain relative path inside the root", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "a.txt"), "hello\n");
    await mkdir(join(root, "sub"));
    const realRoot = await realpath(root);

    expect(await resolveInsideWorkspace(root, "a.txt")).toEqual({
      ok: true,
      absolutePath: join(realRoot, "a.txt"),
    });
    expect(await resolveInsideWorkspace(root, "sub")).toEqual({
      ok: true,
      absolutePath: join(realRoot, "sub"),
    });
    // An empty path is the root itself; the op decides whether a directory is
    // an acceptable answer, not the resolver (Ruling 8: listing a root is
    // legal, reading it is not).
    expect(await resolveInsideWorkspace(root, "")).toEqual({ ok: true, absolutePath: realRoot });
  });

  test("refuses a parent traversal", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "a.txt"), "hello\n");

    expect(await resolveInsideWorkspace(root, "../outside.txt")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
    expect(await resolveInsideWorkspace(root, "a/../../outside.txt")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
    // A traversal naming a credential is traversal, not a credential refusal:
    // the boundary is tested first, so the refusal order cannot be read as
    // evidence about what lies outside the workspace.
    expect(await resolveInsideWorkspace(root, "../id_rsa")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  test("refuses an absolute path", async () => {
    const root = await makeRoot();

    expect(await resolveInsideWorkspace(root, "/etc/passwd")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  test("refuses a symlink that points outside the root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "not yours\n");
    await symlink(outside, join(root, "escape"));

    expect(await resolveInsideWorkspace(root, "escape/secret.txt")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  test("allows a symlink that stays inside the root", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "a.txt"), "hello\n");
    await symlink(join(root, "a.txt"), join(root, "inside"));

    expect((await resolveInsideWorkspace(root, "inside")).ok).toBe(true);
  });

  test("refuses a credential basename", async () => {
    const root = await makeRoot();
    const names = [
      ".env",
      ".env.local",
      "id_rsa",
      "id_ed25519.pub",
      ".credentials.json",
      "server.pem",
      "tls.key",
      ".netrc",
    ];
    for (const name of names) {
      await writeFile(join(root, name), "credential\n");
    }

    for (const name of names) {
      expect(await resolveInsideWorkspace(root, name)).toEqual({
        ok: false,
        code: "CREDENTIAL_FILE_REFUSED",
      });
    }
  });

  test("refuses a credential basename case-insensitively", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "SERVER.PEM"), "credential\n");
    await writeFile(join(root, "ID_RSA"), "credential\n");
    await writeFile(join(root, ".ENV"), "credential\n");

    for (const name of ["SERVER.PEM", "ID_RSA", ".ENV"]) {
      expect(await resolveInsideWorkspace(root, name)).toEqual({
        ok: false,
        code: "CREDENTIAL_FILE_REFUSED",
      });
    }
  });

  test("does not mistake a benign name for a credential", async () => {
    for (const name of [
      "environment.ts",
      "keyboard.md",
      "pem.ts",
      "env.example.txt",
      "keychain.json",
      "id",
    ]) {
      expect(isRefusedCredentialBasename(name)).toBe(false);
    }
  });

  test("reports a missing path as FILE_NOT_FOUND", async () => {
    const root = await makeRoot();

    expect(await resolveInsideWorkspace(root, "nope.txt")).toEqual({
      ok: false,
      code: "FILE_NOT_FOUND",
    });
  });

  test("reports a missing root as FILE_NOT_FOUND rather than resolving anything", async () => {
    const root = await makeRoot();
    await rm(root, { recursive: true, force: true });

    expect(await resolveInsideWorkspace(root, "a.txt")).toEqual({
      ok: false,
      code: "FILE_NOT_FOUND",
    });
  });

  test("does not read a sibling root whose name shares the prefix", async () => {
    // `/tmp/x` must not be treated as containing `/tmp/xyz`, which is the bug a
    // bare `startsWith` containment check ships.
    const root = await makeRoot();
    const sibling = `${root}-sibling`;
    await mkdir(sibling, { recursive: true });
    roots.push(sibling);
    await writeFile(join(sibling, "leak.txt"), "no\n");
    await symlink(sibling, join(root, "escape"));

    expect(await resolveInsideWorkspace(root, "escape/leak.txt")).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  describe("allowMissing", () => {
    test("resolves a deleted leaf inside the root", async () => {
      const root = await makeRoot();
      await mkdir(join(root, "src"));
      const realRoot = await realpath(root);

      expect(await resolveInsideWorkspace(root, "src/gone.ts", {}, { allowMissing: true })).toEqual(
        {
          ok: true,
          absolutePath: join(realRoot, "src", "gone.ts"),
        },
      );
    });

    test("still refuses traversal, absolute paths and credential names", async () => {
      const root = await makeRoot();

      expect(await resolveInsideWorkspace(root, "../gone.ts", {}, { allowMissing: true })).toEqual({
        ok: false,
        code: "PATH_OUTSIDE_WORKSPACE",
      });
      expect(await resolveInsideWorkspace(root, "/etc/gone", {}, { allowMissing: true })).toEqual({
        ok: false,
        code: "PATH_OUTSIDE_WORKSPACE",
      });
      expect(await resolveInsideWorkspace(root, "gone/.env", {}, { allowMissing: true })).toEqual({
        ok: false,
        code: "CREDENTIAL_FILE_REFUSED",
      });
    });

    test("still refuses a missing leaf under a symlink that leaves the root", async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      await symlink(outside, join(root, "escape"));

      expect(
        await resolveInsideWorkspace(root, "escape/gone.ts", {}, { allowMissing: true }),
      ).toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
    });
  });
});
