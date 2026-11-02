<template>
  <div v-if="visible" class="slash-command-menu">
    <div
      v-for="(command, index) in filteredCommands"
      :key="command.name"
      :class="{ 'active': index === selectedIndex }"
      @click="selectCommand(command)"
      class="command-item"
    >
      <span class="command-name">/{{ command.name }}</span>
      <span class="command-badge" :class="command.category">
        {{ command.category.charAt(0).toUpperCase() + command.category.slice(1) }}
      </span>
      <span class="command-description">{{ command.description }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { SlashCommandItem } from '../features/composer/slash-commands';

interface Props {
  commands: SlashCommandItem[];
  query: string;
  visible: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits(['select']);

const selectedIndex = ref(0);

const filteredCommands = computed(() => {
  if (!props.query) return props.commands;

  const normalizedQuery = props.query.toLowerCase().replace(/^\//, '');

  return props.commands.filter((cmd) => {
    const nameMatch = cmd.name.toLowerCase().includes(normalizedQuery);
    const displayMatch = cmd.displayName.toLowerCase().includes(normalizedQuery);
    const descriptionMatch = cmd.description.toLowerCase().includes(normalizedQuery);

    return nameMatch || displayMatch || descriptionMatch;
  });
});

watch(() => props.visible, (newVal) => {
  if (newVal) {
    selectedIndex.value = 0;
  }
});

watch(() => filteredCommands.value, (newCommands) => {
  if (newCommands.length > 0) {
    selectedIndex.value = 0;
  }
});

function selectCommand(command: SlashCommandItem) {
  emit('select', command);
}

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible) return;

  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault();
      selectedIndex.value = Math.max(0, selectedIndex.value - 1);
      break;
    case 'ArrowDown':
      event.preventDefault();
      selectedIndex.value = Math.min(
        filteredCommands.value.length - 1,
        selectedIndex.value + 1
      );
      break;
    case 'Enter':
    case 'Tab':
      event.preventDefault();
      if (filteredCommands.value.length > 0) {
        selectCommand(filteredCommands.value[selectedIndex.value]);
      }
      break;
    case 'Escape':
      event.preventDefault();
      emit('select', null);
      break;
  }
}

// Expose handleKeyDown to parent component
defineExpose({ handleKeyDown });
</script>

<style scoped>
.slash-command-menu {
  position: absolute;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  z-index: 1000;
  max-height: 300px;
  overflow-y: auto;
  width: 400px;
}

.command-item {
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.command-item:hover, .command-item.active {
  background-color: var(--accent);
}

.command-name {
  font-weight: bold;
  color: var(--foreground);
}

.command-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: bold;
  text-transform: capitalize;
}

.command-badge.skill {
  background-color: var(--skill-bg);
  color: var(--skill-text);
}

.command-badge.builtin {
  background-color: var(--builtin-bg);
  color: var(--builtin-text);
}

.command-badge.plugin {
  background-color: var(--plugin-bg);
  color: var(--plugin-text);
}

.command-badge.agent {
  background-color: var(--agent-bg);
  color: var(--agent-text);
}

.command-description {
  color: var(--muted-foreground);
  font-size: 14px;
}
</style>
