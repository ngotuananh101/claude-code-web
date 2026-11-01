import { describe, expect, test } from "bun:test";
import { parseDiagnostics } from "./typecheck-vue.ts";

/**
 * The SFC gate's contract: every diagnostic vue-tsgo reports is either kept
 * (the build must fail) or dropped because it lands in a shadcn-vue generated
 * file this repo must never edit. The parser is the whole gate, so it is
 * tested without spawning the compiler.
 */

const SAMPLE = `src/components/InspectPanel.vue:690:31 - error TS2339: Property 'content' does not exist on type 'FileWriteResult'.
src/components/ui/input/Input.vue:16:58 - error TS2769: No overload matches this call.
src/views/SessionView.vue:164:9 - error TS18048: 'active.value' is possibly 'undefined'.
  Type 'string | null' is not assignable to type 'string'.
src/components/ui/textarea/Textarea.vue:16:58 - error TS2769: No overload matches this call.

Found 4 errors in 4 files.

Errors  Files
     1  src/components/InspectPanel.vue:690
     2  src/components/ui/input/Input.vue:16
     1  src/views/SessionView.vue:164
`;

describe("parseDiagnostics", () => {
  test("keeps app diagnostics and drops generated ui ones", () => {
    const { kept, ignored } = parseDiagnostics(SAMPLE);

    expect(kept.map((d) => `${d.file}:${d.line}:${d.col}:${d.code}`)).toEqual([
      "src/components/InspectPanel.vue:690:31:2339",
      "src/views/SessionView.vue:164:9:18048",
    ]);
    expect(ignored.map((d) => d.file)).toEqual([
      "src/components/ui/input/Input.vue",
      "src/components/ui/textarea/Textarea.vue",
    ]);
  });

  test("ignores the summary block so a clean run parses to nothing", () => {
    const clean = parseDiagnostics("Found 0 errors in 0 files.\n");
    expect(clean.kept).toEqual([]);
    expect(clean.ignored).toEqual([]);
  });

  test("parses diagnostics that arrive with ANSI colour codes", () => {
    const coloured =
      "\u001b[31msrc/components/Composer.vue:393:28 - error TS2379: Argument of type '{ previewUrl: string | undefined; }' is not assignable.\u001b[0m\n";
    const { kept } = parseDiagnostics(coloured);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.file).toBe("src/components/Composer.vue");
    expect(kept[0]?.message).toContain("previewUrl");
  });
});
