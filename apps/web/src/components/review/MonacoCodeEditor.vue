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
    minimap?: boolean;
    options?: monaco.editor.IStandaloneEditorConstructionOptions;
  }>(),
  {
    readOnly: false,
    minimap: true,
  },
);

const emit = defineEmits<{
  "update:content": [value: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
// `setValue` below also fires `onDidChangeContent`; without this flag the
// editor would echo the parent's own content back as a user edit.
let applyingExternal = false;

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
    minimap: { enabled: props.minimap },
    ...props.options,
  });

  model = editor.getModel();

  if (model) {
    model.onDidChangeContent(() => {
      if (model && !applyingExternal) {
        emit("update:content", model.getValue());
      }
    });
  }
});

watch(
  () => props.content,
  (newContent) => {
    if (model && model.getValue() !== newContent) {
      applyingExternal = true;
      model.setValue(newContent);
      applyingExternal = false;
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

watch(
  () => props.minimap,
  (newMinimap) => {
    editor?.updateOptions({ minimap: { enabled: newMinimap } });
  },
);

watch(
  () => props.options,
  (newOptions) => {
    if (editor && newOptions) {
      editor.updateOptions(newOptions);
    }
  },
  { deep: true },
);

onUnmounted(() => {
  editor?.dispose();
  model?.dispose();
});
</script>

<template>
	<div ref="containerRef" class="monaco-code-editor" />
</template>

<style scoped>
.monaco-code-editor {
	width: 100%;
	height: 100%;
	min-height: 240px;
}

@media (min-width: 640px) {
	.monaco-code-editor {
		min-height: 400px;
	}
}
</style>
