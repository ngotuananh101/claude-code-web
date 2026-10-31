<script setup lang="ts">
import { defaultKeymap } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
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
const view = shallowRef<MergeView | null>(null);
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

async function applyLanguage(path: string | undefined): Promise<void> {
  const id = path ? languageForPath(path) : null;
  if (id === null) {
    view.value?.b.dispatch({ effects: languageCompartment.reconfigure([]) });
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
  view.value.b.dispatch({ effects: languageCompartment.reconfigure(ext) });
}

function buildView(): MergeView | null {
  if (host.value === null) {
    return null;
  }
  return new MergeView({
    a: {
      doc: props.original,
      extensions: [
        lineNumbers(),
        ...reviewBaseExtensions,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    },
    b: {
      doc: props.modified,
      extensions: [
        lineNumbers(),
        keymap.of(defaultKeymap),
        ...reviewBaseExtensions,
        languageCompartment.of([]),
        readOnlyCompartment.of(readOnlyExtensions(!props.editable)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            emit("update:modified", u.state.doc.toString());
          }
        }),
      ],
    },
    parent: host.value,
    revertControls: "b-to-a",
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
    orientation: "a-b",
  });
}

onMounted(() => {
  view.value = buildView();
  if (view.value !== null) {
    void applyLanguage(props.path);
  }
});

watch(
  () => props.modified,
  (value) => {
    const current = view.value;
    if (current !== null && value !== current.b.state.doc.toString()) {
      current.b.dispatch({
        changes: {
          from: 0,
          to: current.b.state.doc.length,
          insert: value,
        },
      });
    }
  },
);

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
  () => props.editable,
  (editable) => {
    view.value?.b.dispatch({
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
    class="h-80 overflow-auto rounded-md border border-border/60 bg-background/60"
  />
</template>

<style scoped>
  :deep(.cm-mergeView) {
    height: 100%;
  }
</style>
