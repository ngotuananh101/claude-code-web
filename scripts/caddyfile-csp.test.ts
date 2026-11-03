import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The production SPA ships a Google Fonts `@import` in the generated theme
 * (`apps/web/src/styles/index.css`, which shadcn-vue owns and this repo never
 * hand-edits) plus the same face bundled locally through
 * `@fontsource-variable/figtree`. The Caddyfile's CSP therefore has to allow
 * both hosts: `fonts.googleapis.com` for the stylesheet and
 * `fonts.gstatic.com` for the woff2 files. Without either one the browser
 * blocks the request and the app silently renders in a fallback font.
 *
 * This guards the header text itself: the Caddyfile is not exercised by any
 * server test (Caddy runs only inside the container image), so a tightened
 * `style-src`/`font-src` would otherwise break fonts in production with every
 * gate green.
 */
const CADDYFILE = new URL("../infra/docker/Caddyfile", import.meta.url).pathname;

function cspDirectives(): Map<string, string[]> {
  const header = readFileSync(CADDYFILE, "utf8");
  const match = header.match(/Content-Security-Policy "([^"]+)"/);
  expect(match).not.toBeNull();
  const directives = new Map<string, string[]>();
  for (const part of match![1]!.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [name, ...values] = trimmed.split(/\s+/);
    directives.set(name!, values);
  }
  return directives;
}

describe("Caddyfile content security policy", () => {
  test("allows the Google Fonts stylesheet and font files the SPA imports", () => {
    const directives = cspDirectives();
    expect(directives.get("style-src")).toContain("https://fonts.googleapis.com");
    expect(directives.get("font-src")).toContain("https://fonts.gstatic.com");
  });

  test("declares the policy once, so both SPA routes cannot drift apart", () => {
    const source = readFileSync(CADDYFILE, "utf8");
    // One literal policy in the snippet, imported by @assets and the SPA
    // fallback handle. A second literal copy is how the two routes diverge.
    expect(source.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(source.match(/^\t\timport csp$/gm)).toHaveLength(2);
  });
});
