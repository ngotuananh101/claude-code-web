<script setup lang="ts">
import { defaultKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { languageForPath, loadLanguage } from "@/features/review/languages.ts";
import { reviewBaseExtensions } from "@/features/review/theme.ts";

const props = defineProps<{
  modelValue: string;
  path?: string;
  readOnly?: boolean;
  minHeight?: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
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

onMounted(() => {
  if (host.value === null) {
    return;
  }
  view.value = new EditorView({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      keymap.of(defaultKeymap),
      ...reviewBaseExtensions,
      languageCompartment.of([]),
      readOnlyCompartment.of(readOnlyExtensions(!!props.readOnly)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          emit("update:modelValue", u.state.doc.toString());
        }
      }),
    ],
    parent: host.value,
  });
  void applyLanguage(props.path);
});

watch(
  () => props.modelValue,
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
  () => props.readOnly,
  (readOnly) => {
    view.value?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtensions(!!readOnly)),
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
    :class="minHeight ? undefined : 'min-h-[12rem]'"
    :style="minHeight ? { minHeight } : undefined"
    class="overflow-auto rounded-md border border-border/60 bg-background/60"
  />
</template>
