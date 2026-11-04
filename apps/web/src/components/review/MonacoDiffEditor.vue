<script setup lang="ts">
import type * as monaco from "monaco-editor";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { monacoLanguageForPath } from "@/features/monaco/monaco-languages";
import { initMonaco } from "@/features/monaco/monaco-setup";
import { monacoThemeForResolvedTheme } from "@/features/monaco/monaco-theme";
import { type LineChangeSummary, summariseLineChanges } from "@/features/review/diff-stats";
import { useTheme } from "@/lib/theme";

const props = withDefaults(
  defineProps<{
    original: string;
    modified: string;
    path?: string;
    renderSideBySide?: boolean;
    minimap?: boolean;
  }>(),
  {
    renderSideBySide: true,
    minimap: true,
  },
);

const emit = defineEmits<{
  "update:modified": [value: string];
  stats: [value: LineChangeSummary];
}>();

const { resolvedTheme } = useTheme();
const containerRef = ref<HTMLDivElement | null>(null);
let monacoRef: typeof monaco | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let statsDisposable: monaco.IDisposable | null = null;
// `setValue` below also fires `onDidChangeContent`; without this flag the
// editor would echo the parent's own content back as a user edit.
let applyingExternal = false;

onMounted(() => {
  if (!containerRef.value) return;

  const monacoInstance = initMonaco();
  monacoRef = monacoInstance;
  const language = props.path ? monacoLanguageForPath(props.path) : "plaintext";

  originalModel = monacoInstance.editor.createModel(props.original, language);
  modifiedModel = monacoInstance.editor.createModel(props.modified, language);

  diffEditor = monacoInstance.editor.createDiffEditor(containerRef.value, {
    theme: monacoThemeForResolvedTheme(resolvedTheme.value),
    automaticLayout: true,
    renderSideBySide: props.renderSideBySide,
    minimap: { enabled: props.minimap },
  });

  // The header pill mirrors Monaco's own hunks, so it always agrees with what
  // the operator sees (and follows edits, saves and reverts as they re-diff).
  statsDisposable = diffEditor.onDidUpdateDiff(() => {
    emit("stats", summariseLineChanges(diffEditor?.getLineChanges() ?? []));
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

watch(resolvedTheme, (next) => {
  monacoRef?.editor.setTheme(monacoThemeForResolvedTheme(next));
});

watch(
  () => props.renderSideBySide,
  (newValue) => {
    if (diffEditor) {
      diffEditor.updateOptions({ renderSideBySide: newValue });
    }
  },
);

watch(
  () => props.minimap,
  (enabled) => {
    diffEditor?.updateOptions({ minimap: { enabled } });
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
  statsDisposable?.dispose();
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
	min-height: 240px;
}

@media (min-width: 640px) {
	.monaco-diff-editor {
		min-height: 400px;
	}
}
</style>
