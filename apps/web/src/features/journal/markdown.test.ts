import { describe, expect, test } from "bun:test";
import { redactSdkMessage } from "../../../../runner/src/execution/redact.ts";
import { assistantTextOf, renderMarkdown } from "./markdown.ts";

/**
 * The rendered string reaches `v-html` — every test here is a security or
 * contract pin, not formatting trivia. The renderer configuration (html
 * disabled, no linkify) is what makes the output safe; these tests keep a
 * future option flip from silently reopening the XSS surface.
 */
describe("renderMarkdown", () => {
  test("renders emphasis and paragraphs", () => {
    const html = renderMarkdown("**bold** and _italic_\n\nsecond paragraph");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("</p>");
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
  });

  test("renders fenced code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre><code");
    expect(html).not.toContain("<script");
  });

  test("escapes raw HTML — a script tag never survives as markup", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
  });

  test("escapes raw HTML with event handler attributes", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<img(?![^>]*&)/);
  });

  test("javascript: URLs never become a live link", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    // markdown-it drops the link and keeps the source text; the scheme may
    // appear as visible text (harmless) but must not reach an href.
    expect(html).not.toMatch(/href="[^"]*javascript:/);
    expect(html).not.toContain("<a ");
  });

  test("data:text/html URLs never become a live link", () => {
    const html = renderMarkdown("[x](data:text/html,<b>hi</b>)");
    expect(html).not.toMatch(/href="[^"]*data:/);
    expect(html).not.toContain("<a ");
  });

  test("normal https links keep their href", () => {
    const html = renderMarkdown("[docs](https://example.com/a)");
    expect(html).toContain('href="https://example.com/a"');
  });

  test("a tab smuggled into the scheme cannot reassemble javascript:", () => {
    // mdurl percent-encodes the control character, and browsers only strip
    // literal tab/newline from URLs — %09 is inert.
    const html = renderMarkdown("[x](<java\tscript:alert(1)>)");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  test("a newline smuggled into the scheme produces no link at all", () => {
    const html = renderMarkdown("[x](<java\nscript:alert(1)>)");
    expect(html).not.toContain("<a ");
  });

  test("uppercase scheme is still rejected (inline, autolink, reference)", () => {
    expect(renderMarkdown("[x](JAVASCRIPT:alert(1))")).not.toContain("<a ");
    expect(renderMarkdown("<javascript:alert(1)>")).not.toMatch(/href="[^"]*javascript:/i);
    const html = renderMarkdown("[x][a]\n\n[a]: javascript:alert(1)");
    expect(html).not.toMatch(/href="[^"]*javascript:/i);
  });

  test("empty and whitespace-only input render an empty string", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n\t ")).toBe("");
  });
});

describe("assistantTextOf", () => {
  function assistantPayload(content: unknown): unknown {
    return { type: "assistant", message: { id: "msg_1", content } };
  }

  test("joins text blocks with a blank line", () => {
    const text = assistantTextOf(
      assistantPayload([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    );
    expect(text).toBe("first\n\nsecond");
  });

  test("skips tool_use blocks the tool rows already represent", () => {
    const text = assistantTextOf(
      assistantPayload([
        { type: "text", text: "running it" },
        { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
      ]),
    );
    expect(text).toBe("running it");
  });

  test("non-matching shapes yield an empty string", () => {
    expect(assistantTextOf(null)).toBe("");
    expect(assistantTextOf({})).toBe("");
    expect(assistantTextOf({ type: "assistant" })).toBe("");
    expect(assistantTextOf({ type: "assistant", message: {} })).toBe("");
    expect(assistantTextOf({ type: "assistant", message: { content: "plain" } })).toBe("");
    expect(assistantTextOf({ type: "assistant", message: { content: [] } })).toBe("");
    expect(
      assistantTextOf({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" }] } }),
    ).toBe("");
  });

  test("the extracted text renders through the markdown renderer", () => {
    const text = assistantTextOf(assistantPayload([{ type: "text", text: "**done**" }]));
    expect(renderMarkdown(text)).toContain("<strong>done</strong>");
  });

  test("the redaction seam: real redactSdkMessage output still carries the text", () => {
    // The walker lives in apps/web, the redactor in apps/runner — this is the
    // one test that joins them. If redaction ever strips a key the walker
    // needs (message/content/type/text), every completed message in the
    // journal silently blanks; this is the tripwire.
    const frame = {
      type: "assistant",
      apiKey: "sk-ant-should-vanish",
      message: {
        id: "msg_1",
        cwd: "/home/runner/project",
        content: [
          { type: "text", text: "the answer is **42**" },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    const text = assistantTextOf(redactSdkMessage(frame));
    expect(text).toBe("the answer is **42**");
  });
});
