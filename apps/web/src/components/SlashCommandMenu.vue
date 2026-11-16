<template>
  <div
    v-if="visible"
    ref="rootEl"
    class="slash-command-menu absolute z-[1000] w-[calc(100vw-2rem)] max-w-[26rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
    role="listbox"
    :aria-label="t('composer.slashCommandsAria')"
  >
    <ScrollArea
      class="[&>[data-slot=scroll-area-viewport]]:max-h-[min(17rem,40dvh)] [&>[data-slot=scroll-area-viewport]]:overscroll-contain"
    >
      <div class="min-w-0 p-1">
        <button
          v-for="(command, index) in filteredCommands"
          :key="`${command.category}:${command.name}`"
          type="button"
          role="option"
          :aria-selected="index === selectedIndex"
          :data-active="index === selectedIndex"
          :class="[
            'flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors sm:min-h-0 sm:py-1.5',
            index === selectedIndex ? 'bg-accent' : 'hover:bg-accent/60',
          ]"
          @click="selectCommand(command)"
        >
          <span class="shrink-0 font-mono text-xs font-medium text-foreground">
            /{{ command.name }}
          </span>
          <span
            class="shrink-0 rounded border border-border px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {{ categoryLabel(command.category) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {{ command.description }}
          </span>
        </button>
        <p
          v-if="filteredCommands.length === 0"
          class="px-2.5 py-6 text-center text-xs text-muted-foreground"
        >
          {{ t("composer.slashCommandsEmpty") }}
        </p>
      </div>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/lib/i18n";
import type { SlashCommandItem } from "../features/composer/slash-commands";
import { filterCommands, SLASH_CATEGORY_LABEL_KEY } from "../features/composer/slash-commands";

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

const { t } = useI18n();

/** The badge says which surface the command comes from; the runner decides it. */
function categoryLabel(category: SlashCommandItem["category"]): string {
  return t(SLASH_CATEGORY_LABEL_KEY[category]);
}

const rootEl = ref<HTMLElement | null>(null);
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

/**
 * Keep the highlighted row inside the viewport. The list can be longer than the
 * menu, so arrow keys would otherwise walk the selection off-screen.
 */
async function revealSelected(): Promise<void> {
  await nextTick();
  rootEl.value
    ?.querySelector<HTMLElement>('[data-active="true"]')
    ?.scrollIntoView({ block: "nearest" });
}

function selectCommand(command: SlashCommandItem) {
  emit("select", command);
}

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible) return;

  switch (event.key) {
    case "ArrowUp":
      event.preventDefault();
      selectedIndex.value = Math.max(0, selectedIndex.value - 1);
      void revealSelected();
      break;
    case "ArrowDown":
      event.preventDefault();
      if (filteredCommands.value.length > 0) {
        selectedIndex.value = Math.min(filteredCommands.value.length - 1, selectedIndex.value + 1);
        void revealSelected();
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
