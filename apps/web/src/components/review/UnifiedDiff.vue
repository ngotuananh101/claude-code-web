<script setup lang="ts">
import { defaultKeymap } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { languageForPath, loadLanguage } from "@/features/review/languages.ts";
import { reviewBaseExtensions } from "@/features/review/theme.ts";

const props = defineProps<{
  original: string;
  modified: string;
  editable: boolean;
  path?: string;
}>();
const emit = defineEmits<{
  "update:modified": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

async function applyLanguage(path: string | undefined): Promise<void> {
  const id = path ? languageForPath(path) : null;
  if (id === null) {
    view.value?.dispatch({ effects: languageCompartment.reconfigure([]) });
    return;
  }
  const ext = await loadLanguage(id);
  // Skip if the view was torn down while we waited, or if the path changed
  // to one that maps to a different language.
  if (view.value === null) {
    return;
  }
  if (props.path !== path) {
    return;
  }
  const currentId = props.path ? languageForPath(props.path) : null;
  if (currentId !== id) {
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
      unifiedMergeView({
        original: props.original,
        mergeControls: props.editable,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
        syntaxHighlightDeletions: false,
      }),
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
    if (current !== null && value !== current.state.doc.toString()) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      });
    }
  },
);

watch(
  () => props.editable,
  (editable) => {
    view.value?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtensions(!editable)),
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
