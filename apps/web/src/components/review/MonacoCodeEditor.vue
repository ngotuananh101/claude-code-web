<script setup lang="ts">
import type * as monaco from "monaco-editor";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { monacoLanguageForPath } from "@/features/monaco/monaco-languages";
import { initMonaco } from "@/features/monaco/monaco-setup";

const props = withDefaults(
  defineProps<{
    content: string;
    path?: string;
    readOnly?: boolean;
  }>(),
  {
    readOnly: false,
  },
);

const emit = defineEmits<{
  "update:content": [value: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;

onMounted(() => {
  if (!containerRef.value) return;

  const monacoInstance = initMonaco();
  const language = props.path ? monacoLanguageForPath(props.path) : "plaintext";

  editor = monacoInstance.editor.create(containerRef.value, {
    value: props.content,
    language,
    theme: "cc-web-dark",
    automaticLayout: true,
    readOnly: props.readOnly,
  });

  model = editor.getModel();

  if (model) {
    model.onDidChangeContent(() => {
      if (model) {
        emit("update:content", model.getValue());
      }
    });
  }
});

watch(
  () => props.content,
  (newContent) => {
    if (model && model.getValue() !== newContent) {
      model.setValue(newContent);
    }
  },
);

watch(
  () => props.readOnly,
  (newReadOnly) => {
    if (editor) {
      editor.updateOptions({ readOnly: newReadOnly });
    }
  },
);

onUnmounted(() => {
  model?.dispose();
  editor?.dispose();
});
</script>

<template>
	<div ref="containerRef" class="monaco-code-editor" />
</template>

<style scoped>
.monaco-code-editor {
	width: 100%;
	height: 100%;
	min-height: 400px;
}
</style>
