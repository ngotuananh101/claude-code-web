<script setup lang="ts">
/**
 * A free-text model input with gateway-catalogue suggestions.
 *
 * The operator can type any upstream model id (aliases a gateway accepts but
 * does not list), while focus/typing opens a filtered list of the models the
 * gateway reported. Selection fills the input; nothing forces a choice.
 */

import { ChevronDown } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { filterModelChoices } from "@/features/profiles/profiles-logic.ts";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    /** The gateway catalogue; may be empty when the lookup failed. */
    models?: string[];
    loading?: boolean;
    placeholder?: string;
    id?: string;
  }>(),
  { modelValue: "", models: () => [], loading: false, placeholder: "—" },
);

const emit = defineEmits<(e: "update:modelValue", value: string) => void>();

/** Whether the suggestion popover is open. */
const open = ref(false);
/** The text the operator sees; mirrors `modelValue` unless they are typing. */
const text = ref(props.modelValue);
/** Highlighted suggestion index; -1 means "keep what was typed". */
const activeIndex = ref(-1);
const listRef = ref<HTMLElement | null>(null);

watch(
  () => props.modelValue,
  (value) => {
    if (value !== text.value) text.value = value;
  },
);

const filtered = computed(() => filterModelChoices(props.models, text.value));

/** Open the list as soon as there is something to show. */
function showSuggestions(): void {
  if (props.loading || props.models.length > 0) open.value = true;
}

function onInput(value: string | number): void {
  text.value = String(value ?? "");
  activeIndex.value = -1;
  emit("update:modelValue", text.value);
  showSuggestions();
}

function select(model: string): void {
  text.value = model;
  activeIndex.value = -1;
  open.value = false;
  emit("update:modelValue", model);
}

async function moveActive(delta: number): Promise<void> {
  if (filtered.value.length === 0) return;
  open.value = true;
  const next = activeIndex.value + delta;
  activeIndex.value = Math.max(0, Math.min(next, filtered.value.length - 1));
  await nextTick();
  listRef.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
    block: "nearest",
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    void moveActive(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    void moveActive(-1);
  } else if (event.key === "Enter") {
    if (open.value && activeIndex.value >= 0) {
      const model = filtered.value[activeIndex.value];
      if (model !== undefined) {
        event.preventDefault();
        select(model);
      }
    } else {
      open.value = false;
    }
  } else if (event.key === "Escape") {
    open.value = false;
  }
}

/** Close when focus leaves the input for somewhere that is not the list. */
function onBlur(): void {
  window.setTimeout(() => {
    if (!listRef.value?.contains(document.activeElement)) open.value = false;
  }, 0);
}
</script>

<template>
  <Popover :open="open" @update:open="open = $event">
    <PopoverAnchor as-child>
      <div class="relative w-full">
        <Input
          :id="id"
          :model-value="text"
          :placeholder="placeholder"
          class="pr-8 font-mono text-sm"
          role="combobox"
          :aria-expanded="open"
          autocomplete="off"
          @update:model-value="onInput"
          @focus="showSuggestions"
          @click="showSuggestions"
          @keydown="onKeydown"
          @blur="onBlur"
        />
        <ChevronDown
          :size="14"
          class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    </PopoverAnchor>

    <PopoverContent
      align="start"
      :side-offset="4"
      class="w-[var(--reka-popper-anchor-width)] gap-0 p-1"
      @open-auto-focus.prevent
    >
      <div
        v-if="loading && models.length === 0"
        class="px-2 py-1.5 text-xs text-muted-foreground"
      >
        Đang tải danh sách model…
      </div>
      <div
        v-else-if="models.length === 0"
        class="px-2 py-1.5 text-xs text-muted-foreground"
      >
        Chưa có danh sách model — bấm nút tải lại để thử.
      </div>
      <div v-else-if="filtered.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
        Không có model nào khớp — vẫn có thể gõ tay tên model.
      </div>
      <div v-else ref="listRef" class="max-h-56 overflow-y-auto">
        <button
          v-for="(model, index) in filtered"
          :key="model"
          type="button"
          :data-active="index === activeIndex"
          class="flex w-full items-center rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors"
          :class="
            index === activeIndex
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          "
          @mousedown.prevent
          @click="select(model)"
          @mouseenter="activeIndex = index"
        >
          <span class="truncate" :title="model">{{ model }}</span>
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
