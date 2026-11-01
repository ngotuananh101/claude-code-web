<script setup lang="ts">
import type * as monaco from "monaco-editor";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { monacoLanguageForPath } from "@/features/monaco/monaco-languages";
import { initMonaco } from "@/features/monaco/monaco-setup";

const props = withDefaults(
  defineProps<{
    original: string;
    modified: string;
    path?: string;
    renderSideBySide?: boolean;
  }>(),
  {
    renderSideBySide: true,
  },
);

const emit = defineEmits<{
  "update:modified": [value: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
// `setValue` below also fires `onDidChangeContent`; without this flag the
// editor would echo the parent's own content back as a user edit.
let applyingExternal = false;

onMounted(() => {
  if (!containerRef.value) return;

  const monacoInstance = initMonaco();
  const language = props.path ? monacoLanguageForPath(props.path) : "plaintext";

  originalModel = monacoInstance.editor.createModel(props.original, language);
  modifiedModel = monacoInstance.editor.createModel(props.modified, language);

  diffEditor = monacoInstance.editor.createDiffEditor(containerRef.value, {
    theme: "cc-web-dark",
    automaticLayout: true,
    renderSideBySide: props.renderSideBySide,
  });

  diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel,
  });

  modifiedModel.onDidChangeContent(() => {
    if (modifiedModel && !applyingExternal) {
      emit("update:modified", modifiedModel.getValue());
    }
  });
});

watch(
  () => props.renderSideBySide,
  (newValue) => {
    if (diffEditor) {
      diffEditor.updateOptions({ renderSideBySide: newValue });
    }
  },
);

// The parent can replace either side without remounting (the dialog keys the
// editor by path): a revert, a save refresh, or an adopted conflict. The
// models must follow, or the next keystroke echoes stale content into Save.
watch(
  () => props.original,
  (newValue) => {
    if (originalModel && originalModel.getValue() !== newValue) {
      applyingExternal = true;
      originalModel.setValue(newValue);
      applyingExternal = false;
    }
  },
);

watch(
  () => props.modified,
  (newValue) => {
    if (modifiedModel && modifiedModel.getValue() !== newValue) {
      applyingExternal = true;
      modifiedModel.setValue(newValue);
      applyingExternal = false;
    }
  },
);

onUnmounted(() => {
  diffEditor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
});
</script>

<template>
	<div ref="containerRef" class="monaco-diff-editor" />
</template>

<style scoped>
.monaco-diff-editor {
	width: 100%;
	height: 100%;
	min-height: 400px;
}
</style>
