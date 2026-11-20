import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FileReadResult, FileWriteResult } from "@cc-web/protocol";
import ts from "typescript5";
import { ref } from "vue";
import { isDirty, isEditableRead, viewerAfterSave } from "../features/inspect/edit.ts";
import type { InspectOutcome } from "../services/inspect-api.ts";

// Execute the SFC's save handlers, not a parallel implementation of them. Only
// the RPC boundary is held back; Vue refs and the baseline helpers stay real.
const source = readFileSync(new URL("./InspectPanel.vue", import.meta.url), "utf8");
const script = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
const ast = ts.createSourceFile("InspectPanel.ts", script, ts.ScriptTarget.Latest, true);
const names = new Set(["saveFile", "overwriteConflict", "isDraftDirty"]);
const handlers = ast.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""))
  .map((node) => node.getText(ast))
  .join("\n");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(handlers);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function editor() {
  let disk: FileReadResult = {
    op: "file.read",
    path: "a.ts",
    content: "original",
    binary: false,
    truncated: false,
    hash: "h1",
    size: 8,
  };
  const viewer = ref<FileReadResult | null>({ ...disk });
  const draft = ref<string | null>("submitted A");
  const saving = ref(false);
  const saveError = ref<string | null>(null);
  const conflictIncoming = ref<FileReadResult | null>(null);
  let started = deferred<void>();
  let response = deferred<InspectOutcome<FileWriteResult>>();
  let writes = 0;
  const scope = {
    workspace: ref("runner/workspace"),
    viewer,
    draft,
    saving,
    saveError,
    conflictIncoming,
    directory: ref(""),
    isDirty,
    isEditableRead,
    viewerAfterSave,
    readFile: async () => ({ ok: true as const, value: { ...disk } }),
    writeFile: async (_id: string, path: string, content: string, hash: string) => {
      if (path !== disk.path || hash !== disk.hash) {
        return { ok: false as const, code: "FILE_CONFLICT", message: "File changed" };
      }
      started.resolve();
      const outcome = await response.promise;
      if (outcome.ok) disk = { ...disk, content, hash: outcome.value.hash, size: content.length };
      return outcome;
    },
    loadFiles: async () => {},
  };
  const create = new Function(
    "scope",
    `const { ${Object.keys(scope).join(", ")} } = scope;
     let epoch = 0;
     ${compiled}
     return { saveFile, overwriteConflict, isDraftDirty, navigate: () => { epoch++; } };`,
  ) as (bindings: typeof scope) => {
    saveFile: () => Promise<void>;
    overwriteConflict: () => Promise<void>;
    isDraftDirty: () => boolean;
    navigate: () => void;
  };
  return {
    ...scope,
    ...create(scope),
    disk: () => disk,
    started: () => started.promise,
    finish: (failure = false) => {
      writes++;
      response.resolve(
        failure
          ? { ok: false, code: "UNREACHABLE", message: "Runner offline" }
          : {
              ok: true,
              value: { op: "file.write", path: "a.ts", hash: `h${writes + 1}`, size: 11 },
            },
      );
    },
    nextWrite: () => {
      started = deferred<void>();
      response = deferred<InspectOutcome<FileWriteResult>>();
    },
  };
}

for (const method of ["saveFile", "overwriteConflict"] as const) {
  describe(`InspectPanel ${method}`, () => {
    test("typing during a write remains dirty against the submitted bytes and fresh hash", async () => {
      const state = editor();
      const pending = state[method]();
      await state.started();
      state.draft.value = "unsaved B";
      state.finish();
      await pending;

      expect(state.disk().content).toBe("submitted A");
      expect(state.viewer.value?.content).toBe("submitted A");
      expect(state.viewer.value?.hash).toBe("h2");
      expect(state.draft.value).toBe("unsaved B");
      expect(state.isDraftDirty()).toBe(true);

      // The next save must use h2 and persist B, rather than be suppressed as clean.
      state.nextWrite();
      const next = state[method]();
      await state.started();
      state.finish();
      await next;
      expect(state.disk().content).toBe("unsaved B");
      expect(state.viewer.value?.hash).toBe("h3");
      expect(state.isDraftDirty()).toBe(false);
    });

    test("a failed write preserves the original baseline and newer draft", async () => {
      const state = editor();
      const pending = state[method]();
      await state.started();
      state.draft.value = "unsaved B";
      state.finish(true);
      await pending;

      expect(state.disk().content).toBe("original");
      expect(state.viewer.value?.hash).toBe("h1");
      expect(state.draft.value).toBe("unsaved B");
      expect(state.isDraftDirty()).toBe(true);
      expect(state.saveError.value).toBe("Runner offline");
    });

    test("a late write response cannot update a different open file", async () => {
      const state = editor();
      const pending = state[method]();
      await state.started();
      state.navigate();
      state.viewer.value = { ...state.disk(), path: "b.ts", content: "other file", hash: "other" };
      state.draft.value = "other draft";
      state.finish();
      await pending;

      expect(state.disk().content).toBe("submitted A");
      expect(state.viewer.value?.path).toBe("b.ts");
      expect(state.viewer.value?.hash).toBe("other");
      expect(state.draft.value).toBe("other draft");
    });
  });
}
