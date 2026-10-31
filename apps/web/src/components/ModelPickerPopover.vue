<script setup lang="ts">
import type { EffortLevel, ProfileSummary, RunnerModel } from "@cc-web/protocol";
import { Check, ChevronDown, ChevronRight, Cpu, Sparkles, Zap } from "@lucide/vue";
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveModelLabel } from "@/features/composer/composer-logic.ts";
import {
  EFFORT_LABELS,
  effortAt,
  effortLabel,
  effortLevelsFor,
  effortPosition,
  formatModelDescription,
  formatModelDisplayName,
  modelFor,
  modelLabel,
  pickerModels,
  stepEffort,
} from "@/features/composer/model-picker.ts";
import { shortRunnerId } from "@/features/sessions/folder-tree.ts";

/**
 * The model & effort picker (§5.2).
 *
 * The model rows are the runner's own Claude Code lineup — what the host
 * advertised in its hello, custom names included — falling back to the
 * protocol's list when the runner said nothing. Effort is per-run and rides
 * next to the model; ultracode is a separate standing mode, so it has its own
 * row rather than a sixth tick on the effort track.
 */
const props = defineProps<{
  /** Whose models these are; shown in the header, empty before a runner is chosen. */
  runnerId: string;
  /** What that runner advertised; empty means "unknown, use the fallback". */
  advertised: readonly RunnerModel[];
  /** The chosen model value; "default" means "let Claude Code choose". */
  model: string;
  /** The chosen effort, or null for the SDK's own default. */
  effort: EffortLevel | null;
  /** The standing ultracode mode. */
  ultracode: boolean;
  /** The selected profile id, or null/undefined for the runner-host default. */
  profileId: string | null | undefined;
  /** Profiles the operator can pick from; empty means the profile selector is hidden. */
  profiles: readonly ProfileSummary[];
  disabled?: boolean;
  /** Whether the popover starts opened (useful in previews / deep links). */
  defaultOpen?: boolean;
}>();

const emit = defineEmits<{
  "update:model": [value: string];
  "update:effort": [value: EffortLevel | null];
  "update:ultracode": [value: boolean];
  "update:profileId": [value: string | null];
}>();

const open = ref(props.defaultOpen ?? false);
/** Compact rows by default (name only); the chevron unfolds descriptions. */
const showDescriptions = ref(false);

const models = computed(() => pickerModels(props.advertised));
const selected = computed(() => modelFor(models.value, props.model));
const levels = computed(() => effortLevelsFor(selected.value));
const triggerLabel = computed(() => {
  const base = modelLabel(models.value, props.model);
  // When a profile remaps this model's role, surface the upstream name on the
  // closed trigger too (e.g. "Sonnet (prime)") so the chip stays accurate.
  const mapped = profileMapping.value[props.model as keyof typeof profileMapping.value];
  if (typeof mapped === "string" && mapped.trim() !== "") {
    return resolveModelLabel({
      model: props.model,
      profile: { modelMapping: profileMapping.value as Record<string, string> },
    });
  }
  return base;
});
const knobPosition = computed(() => effortPosition(levels.value, props.effort));

/** The active profile object (if any), looked up by id from the saved list. */
const activeProfile = computed<ProfileSummary | undefined>(() => {
  if (!props.profileId) return undefined;
  return props.profiles.find((p) => p.profileId === props.profileId);
});

/** The model-mapping overlay for the active profile; empty when none selected. */
const profileMapping = computed(() => activeProfile.value?.modelMapping ?? {});

/** Whether the profile selector should be shown (only when profiles exist). */
const showProfileSelector = computed(() => props.profiles.length > 0);

function selectProfile(value: string | null): void {
  emit("update:profileId", value);
}
const activeIndex = computed(() =>
  props.effort === null ? -1 : levels.value.indexOf(props.effort),
);
const effortText = computed(() => effortLabel(props.effort));

/** A level has been chosen beyond model choice — worth a marker on the trigger. */
const tuned = computed(() => props.effort !== null || props.ultracode);

/** Decorative sparkles on the gradient, stable across renders. */
const sparkles = [
  { left: "9%", top: "24%", size: 2 },
  { left: "27%", top: "74%", size: 3 },
  { left: "48%", top: "18%", size: 2 },
  { left: "63%", top: "78%", size: 2 },
  { left: "82%", top: "30%", size: 3 },
  { left: "94%", top: "66%", size: 2 },
];

function chooseModel(value: string): void {
  emit("update:model", value);
  // §5.2: an effort the new model cannot honour is cleared, not carried — the
  // run would otherwise report a depth the model never applied.
  if (
    props.effort !== null &&
    !effortLevelsFor(modelFor(models.value, value)).includes(props.effort)
  ) {
    emit("update:effort", null);
  }
}

function chooseEffort(level: EffortLevel | null): void {
  if (level !== null) emit("update:effort", level);
}

function onTrackClick(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (rect.width === 0) return;
  chooseEffort(effortAt(levels.value, (event.clientX - rect.left) / rect.width));
}

function onTrackKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    event.preventDefault();
    emit("update:effort", stepEffort(levels.value, props.effort, 1));
  } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    event.preventDefault();
    emit("update:effort", stepEffort(levels.value, props.effort, -1));
  } else if (event.key === "Home") {
    event.preventDefault();
    emit("update:effort", levels.value[0] ?? null);
  } else if (event.key === "End") {
    event.preventDefault();
    emit("update:effort", levels.value[levels.value.length - 1] ?? null);
  }
}

function percent(index: number): string {
  if (levels.value.length <= 1) return "0%";
  return `${(index / (levels.value.length - 1)) * 100}%`;
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        :disabled="disabled"
        class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        aria-label="Chọn model, mức nỗ lực và profile"
        :title="`Model: ${triggerLabel}${activeProfile.value ? ` · ${activeProfile.value.name}` : ''}${effort ? ` · nỗ lực ${effortText}` : ''}${ultracode ? ' · ultracode' : ''}`"
      >
        <Cpu :size="13" class="shrink-0" />
        <span class="max-w-[110px] truncate">{{ triggerLabel }}</span>
        <span
          v-if="tuned"
          class="size-1.5 shrink-0 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
        />
        <ChevronDown :size="11" class="shrink-0 opacity-60" />
      </Button>
    </PopoverTrigger>

    <PopoverContent
      side="top"
      align="end"
      :side-offset="8"
      class="w-[336px] max-w-[calc(100vw-2rem)] gap-0 rounded-xl p-2.5"
    >
      <!-- Provider header: whose lineup this is, with the API badge the image
           shows and a chevron that unfolds the rows' descriptions. -->
      <div class="flex items-center gap-2 px-1 pb-2">
        <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <Sparkles :size="14" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-semibold leading-tight">Claude Code</span>
          <span class="block truncate font-mono text-[10px] text-muted-foreground">
            {{ runnerId === "" ? "chưa chọn runner" : shortRunnerId(runnerId) }}
          </span>
        </span>
        <span
          class="shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          API
        </span>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :aria-label="showDescriptions ? 'Ẩn mô tả model' : 'Hiện mô tả model'"
          :aria-expanded="showDescriptions"
          @click="showDescriptions = !showDescriptions"
        >
          <ChevronRight
            :size="14"
            class="transition-transform"
            :class="showDescriptions && 'rotate-90'"
          />
        </button>
      </div>

      <!-- Profile selector (§4.5.3): runner-host default first (null), then saved profiles.
           When a profile with a model mapping is active, the rows below re-label
           the model roles with their upstream names (e.g. "Sonnet (prime)"). -->
      <div v-if="showProfileSelector" class="border-b border-border pb-1.5">
        <div class="flex items-center justify-between px-1 pb-1">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Provider profile
          </span>
          <button
            v-if="profileId"
            type="button"
            class="cursor-pointer rounded px-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            title="Bỏ chọn profile — dùng cấu hình mặc định của runner"
            @click="selectProfile(null)"
          >
            Bỏ
          </button>
        </div>
        <button
          type="button"
          role="radio"
          :aria-checked="profileId == null"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
          :class="profileId == null && 'bg-accent/60'"
          @click="selectProfile(null)"
        >
          <span class="min-w-0 flex-1 truncate text-[13px]">Mặc định (Runner Host)</span>
          <Check v-if="profileId == null" :size="14" class="shrink-0 text-primary" />
        </button>
        <button
          v-for="profile in profiles"
          :key="profile.profileId"
          type="button"
          role="radio"
          :aria-checked="profile.profileId === profileId"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
          :class="profile.profileId === profileId && 'bg-accent/60'"
          @click="selectProfile(profile.profileId)"
        >
          <span class="min-w-0 flex-1">
            <span
              class="block truncate text-[13px]"
              :class="
                profile.profileId === profileId
                  ? 'font-medium text-foreground'
                  : 'text-foreground/90'
              "
            >
              {{ profile.name }}</span>
            <span class="block truncate font-mono text-[10px] text-muted-foreground">
              {{ profile.endpoint }}</span>
          </span>
          <Check v-if="profile.profileId === profileId" :size="14" class="shrink-0 text-primary" />
        </button>
      </div>

      <!-- Models: one row per model the runner offers, check on the chosen one. -->
      <div class="grid gap-0.5" role="radiogroup" aria-label="Model">
        <button
          v-for="entry in models"
          :key="entry.value"
          type="button"
          role="radio"
          :aria-checked="entry.value === model"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
          :class="entry.value === model && 'bg-accent/60'"
          @click="chooseModel(entry.value)"
        >
          <span class="min-w-0 flex-1">
            <span
              class="block truncate text-[13px]"
              :class="entry.value === model ? 'font-medium text-foreground' : 'text-foreground/90'"
            >
              {{ profileMapping[entry.value as keyof typeof profileMapping] ? resolveModelLabel({ model: entry.value, profile: { modelMapping: profileMapping as Record<string, string> } }) : formatModelDisplayName(entry) }}
            </span>
            <span
              v-if="showDescriptions && formatModelDescription(entry) !== ''"
              class="block truncate text-[11px] text-muted-foreground"
            >
              {{ formatModelDescription(entry) }}
            </span>
            <span
              v-else-if="showDescriptions"
              class="block truncate font-mono text-[11px] text-muted-foreground"
            >
              {{ entry.value }}
            </span>
          </span>
          <Check v-if="entry.value === model" :size="14" class="shrink-0 text-primary" />
        </button>
      </div>

      <!-- Effort: the gradient track — green at low, blue at max, white knob.
           Hidden entirely when the chosen model has no effort parameter. -->
      <div v-if="levels.length > 0" class="mt-1 border-t border-border pt-2.5">
        <div class="flex items-center justify-between px-1">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Mức nỗ lực
          </span>
          <button
            type="button"
            class="cursor-pointer rounded px-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="Bấm để trả về mặc định của Claude Code"
            @click="emit('update:effort', null)"
          >
            {{ effortText }}
          </button>
        </div>

        <div
          class="relative mt-3 h-7 cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          role="slider"
          tabindex="0"
          aria-label="Mức nỗ lực"
          aria-orientation="horizontal"
          :aria-valuemin="0"
          :aria-valuemax="levels.length - 1"
          :aria-valuenow="activeIndex < 0 ? 0 : activeIndex"
          :aria-valuetext="effortText"
          @click="onTrackClick"
          @keydown="onTrackKeydown"
        >
          <!-- The track itself: green → cyan → blue, glowing, with sparkles. -->
          <div
            class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500 shadow-[0_0_14px_-2px] shadow-cyan-400/70"
          />
          <span
            v-for="(sparkle, index) in sparkles"
            :key="`spark-${index}`"
            class="pointer-events-none absolute size-[3px] rounded-full bg-white/80"
            :style="{ left: sparkle.left, top: sparkle.top, width: `${sparkle.size}px`, height: `${sparkle.size}px` }"
          />
          <!-- Tick marks, one per level, lit up to and including the choice. -->
          <span
            v-for="(level, index) in levels"
            :key="level"
            class="pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors"
            :class="activeIndex >= index && activeIndex >= 0 ? 'bg-white/90' : 'bg-white/45'"
            :style="{ left: percent(index) }"
          />
          <!-- The knob. Dimmed while the choice is "tự động". -->
          <span
            class="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-white shadow-md ring-1 ring-black/10 transition-all"
            :class="effort === null && 'opacity-65'"
            :style="{ left: `${knobPosition * 100}%` }"
          />
        </div>

        <div class="mt-0.5 flex justify-between px-0.5 font-mono text-[10px] text-muted-foreground/80">
          <span v-for="level in levels" :key="`label-${level}`">{{ EFFORT_LABELS[level] ?? level }}</span>
        </div>
      </div>

      <!-- Ultracode: a standing mode, independent of the effort tick. -->
      <div class="mt-1 border-t border-border pt-1.5">
        <button
          type="button"
          role="switch"
          :aria-checked="ultracode"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
          @click="emit('update:ultracode', !ultracode)"
        >
          <Zap :size="13" class="shrink-0" :class="ultracode ? 'text-amber-400' : 'text-muted-foreground'" />
          <span class="flex-1 text-left">
            <span class="block text-[13px] leading-tight">Ultracode</span>
            <span class="block text-[11px] text-muted-foreground">
              Điều phối workflow động suốt phiên, ở mọi mức effort
            </span>
          </span>
          <span
            class="flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors"
            :class="ultracode ? 'bg-primary' : 'bg-muted'"
          >
            <span
              class="block size-3 rounded-full bg-background shadow-sm transition-transform"
              :class="ultracode && 'translate-x-3'"
            />
          </span>
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
