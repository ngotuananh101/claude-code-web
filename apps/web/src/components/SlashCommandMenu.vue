<template>
  <div
    v-if="visible"
    class="slash-command-menu absolute z-[1000] max-h-[min(300px,40dvh)] w-[calc(100vw-2rem)] max-w-[400px] overflow-y-auto rounded-md border bg-background shadow-md"
    role="listbox"
  >
    <div
      v-for="(command, index) in filteredCommands"
      :key="`${command.category}:${command.name}`"
      role="option"
      :aria-selected="index === selectedIndex"
      :class="[
        'command-item flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2.5 sm:min-h-0 sm:py-2',
        index === selectedIndex ? 'bg-accent' : 'hover:bg-accent',
      ]"
      @click="selectCommand(command)"
    >
      <span class="command-name shrink-0 font-bold text-foreground">/{{ command.name }}</span>
      <span
        class="command-badge shrink-0 rounded px-1.5 py-0.5 text-xs font-bold"
        :class="{
          'bg-primary/10 text-primary': command.category === 'skill',
          'bg-secondary text-secondary-foreground': command.category === 'builtin',
          'bg-muted text-muted-foreground': command.category === 'plugin',
          'bg-accent text-accent-foreground': command.category === 'agent',
        }"
      >
        {{ command.category === 'builtin' ? 'Built-in' : command.category.charAt(0).toUpperCase() + command.category.slice(1) }}
      </span>
      <span class="command-description min-w-0 truncate text-sm text-muted-foreground">{{ command.description }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SlashCommandItem } from "../features/composer/slash-commands";
import { filterCommands } from "../features/composer/slash-commands";

interface Props {
  commands: SlashCommandItem[];
  query: string;
  visible: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "select", command: SlashCommandItem): void;
  (e: "close"): void;
}>();

const selectedIndex = ref(0);

const filteredCommands = computed(() => filterCommands(props.commands, props.query));

watch(
  () => props.visible,
  (newVal) => {
    if (newVal) {
      selectedIndex.value = 0;
    }
  },
);

watch(
  () => filteredCommands.value,
  (newCommands) => {
    if (newCommands.length > 0) {
      selectedIndex.value = 0;
    }
  },
);

function selectCommand(command: SlashCommandItem) {
  emit("select", command);
}

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible) return;

  switch (event.key) {
    case "ArrowUp":
      event.preventDefault();
      selectedIndex.value = Math.max(0, selectedIndex.value - 1);
      break;
    case "ArrowDown":
      event.preventDefault();
      if (filteredCommands.value.length > 0) {
        selectedIndex.value = Math.min(filteredCommands.value.length - 1, selectedIndex.value + 1);
      }
      break;
    case "Enter":
    case "Tab":
      if (
        filteredCommands.value.length > 0 &&
        selectedIndex.value >= 0 &&
        selectedIndex.value < filteredCommands.value.length
      ) {
        event.preventDefault();
        selectCommand(filteredCommands.value[selectedIndex.value]!);
      }
      break;
    case "Escape":
      event.preventDefault();
      emit("close");
      break;
  }
}

// Expose handleKeyDown to parent component
defineExpose({ handleKeyDown });
</script>