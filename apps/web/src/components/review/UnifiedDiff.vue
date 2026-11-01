<script setup lang="ts">
import { defaultKeymap } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { languageForPath, loadLanguage } from "@/features/review/languages.ts";
import { lineSeparatorFor } from "@/features/review/review-state.ts";
import { reviewBaseExtensions } from "@/features/review/theme.ts";

const props = defineProps<{
  original: string;
  modified: string;
  editable: boolean;
  // Explicit `undefined` is allowed: the caller binds `diffPath ?? undefined`
  // under `exactOptionalPropertyTypes`.
  path?: string | undefined;
}>();
const emit = defineEmits<{
  "update:modified": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const lineSeparatorCompartment = new Compartment();
const mergeControlsCompartment = new Compartment();
let activeLineSeparator = lineSeparatorFor(props.modified);

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

function lineSeparatorExtensions(separator: "\r\n" | null): Extension[] {
  return separator === null ? [] : [EditorState.lineSeparator.of(separator)];
}

function mergeViewExtensions(editable: boolean): Extension {
  return unifiedMergeView({
    original: props.original,
    mergeControls: editable,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
    syntaxHighlightDeletions: false,
  });
}

async function applyLanguage(path: string | undefined): Promise<void> {
  const id = path ? languageForPath(path) : null;
  if (id === null) {
    view.value?.dispatch({ effects: languageCompartment.reconfigure([]) });
    return;
  }
  const ext = await loadLanguage(id);
  // Skip if the view was torn down while we waited, or if the path drifted to
  // a different file (whose own load will apply its language).
  if (view.value === null) {
    return;
  }
  if (props.path !== path) {
    return;
  }
  view.value.dispatch({ effects: languageCompartment.reconfigure(ext) });
}

function buildView(): EditorView | null {
  if (host.value === null) {
    return null;
  }
  return new EditorView({
    doc: props.modified,
    extensions: [
      lineNumbers(),
      keymap.of(defaultKeymap),
      ...reviewBaseExtensions,
      mergeControlsCompartment.of(mergeViewExtensions(props.editable)),
      lineSeparatorCompartment.of(lineSeparatorExtensions(activeLineSeparator)),
      readOnlyCompartment.of(readOnlyExtensions(!props.editable)),
      languageCompartment.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          emit("update:modified", u.state.doc.toString());
        }
      }),
    ],
    parent: host.value,
  });
}

onMounted(() => {
  view.value = buildView();
  void applyLanguage(props.path);
});

watch(
  () => props.original,
  () => {
    view.value?.destroy();
    // The rebuilt document follows the modified side's line endings; the
    // original is handled by the merge view itself.
    activeLineSeparator = lineSeparatorFor(props.modified);
    view.value = buildView();
    if (view.value !== null) {
      void applyLanguage(props.path);
    }
  },
);

watch(
  () => props.modified,
  (value) => {
    const current = view.value;
    if (current === null) return;
    // Keep CRLF documents CRLF across external replacements.
    const separator = lineSeparatorFor(value);
    if (separator !== activeLineSeparator) {
      activeLineSeparator = separator;
      current.dispatch({
        effects: lineSeparatorCompartment.reconfigure(lineSeparatorExtensions(separator)),
      });
    }
    if (value !== current.state.doc.toString()) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      });
    }
  },
);

watch(
  () => props.editable,
  (editable) => {
    // The accept/reject controls are part of the merge-view extension, so the
    // whole extension is reconfigured when editability flips — not only the
    // read-only compartment.
    view.value?.dispatch({
      effects: [
        readOnlyCompartment.reconfigure(readOnlyExtensions(!editable)),
        mergeControlsCompartment.reconfigure(mergeViewExtensions(editable)),
      ],
    });
  },
);

watch(
  () => props.path,
  (path) => {
    void applyLanguage(path);
  },
);

onBeforeUnmount(() => {
  view.value?.destroy();
  view.value = null;
});
</script>

<template>
  <div
    ref="host"
    class="max-h-80 overflow-auto rounded-md border border-border/60 bg-background/60"
  />
</template>

<style scoped>
  .cm-editor {
    max-height: inherit;
  }
</style>
