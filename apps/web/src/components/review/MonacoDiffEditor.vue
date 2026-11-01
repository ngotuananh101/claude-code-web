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
    if (modifiedModel) {
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

onUnmounted(() => {
  originalModel?.dispose();
  modifiedModel?.dispose();
  diffEditor?.dispose();
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
