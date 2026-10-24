<script setup lang="ts">
import type { UsageStats } from "@cc-web/protocol";
import { ArrowDownLeft, ArrowUpRight, Database, Layers } from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import { formatTokens } from "../lib/format-tokens.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { sessions } from "../stores/sessions.ts";

/**
 * The landing page (§17.1's usage read): what the journal cost in tokens,
 * what it holds, and where to jump next. Every number is server-aggregated
 * from `message.completed` usage — cost figures never leave the runner.
 */

const stats = ref<UsageStats | null>(null);
const runnersEnrolled = ref<number | null>(null);

async function load(): Promise<void> {
  const response = await fetch("/api/stats/usage");
  if (!response.ok) {
    toast.error(await response.text());
    return;
  }
  stats.value = (await response.json()) as UsageStats;
}

async function loadRunners(): Promise<void> {
  const response = await fetch("/api/runners");
  if (!response.ok) return; // the runners console shows the error properly
  const body = (await response.json()) as { runners: unknown[] };
  runnersEnrolled.value = body.runners.length;
}

onMounted(() => {
  void load();
  void loadRunners();
});

type Kpi = {
  label: string;
  value: number;
  icon: Component;
  tone: string;
};

const kpis = computed<Kpi[]>(() => {
  const totals = stats.value?.totals;
  return [
    {
      label: "Tokens in",
      value: totals?.inputTokens ?? 0,
      icon: ArrowDownLeft,
      tone: "text-chart-1",
    },
    {
      label: "Cache read",
      value: totals?.cacheReadTokens ?? 0,
      icon: Database,
      tone: "text-chart-2",
    },
    {
      label: "Cache creation",
      value: totals?.cacheCreationTokens ?? 0,
      icon: Layers,
      tone: "text-chart-3",
    },
    {
      label: "Tokens out",
      value: totals?.outputTokens ?? 0,
      icon: ArrowUpRight,
      tone: "text-chart-4",
    },
  ];
});

const today = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

// The chart: stacked bars, one per day, in the journal's four token colors.
// Hand-rolled SVG on purpose — the series is four rectangles per day, and a
// charting dependency would outweigh the data.
const CHART = { width: 560, height: 150, step: 40, bar: 22 } as const;

type Bar = {
  x: number;
  segments: Array<{ y: number; height: number; fill: string; label: string }>;
};

const bars = computed<Bar[]>(() => {
  const daily = stats.value?.daily ?? [];
  const max = daily.reduce((peak, day) => {
    const total =
      day.inputTokens + day.cacheReadTokens + day.cacheCreationTokens + day.outputTokens;
    return Math.max(peak, total);
  }, 0);
  const scale = (tokens: number): number =>
    max === 0 ? 0 : Math.max(tokens > 0 ? 1.5 : 0, (tokens / max) * (CHART.height - 6));
  const fills: Array<[keyof DayTokens, string, string]> = [
    ["inputTokens", "fill-chart-1", "in"],
    ["cacheReadTokens", "fill-chart-2", "cache read"],
    ["cacheCreationTokens", "fill-chart-3", "cache creation"],
    ["outputTokens", "fill-chart-4", "out"],
  ];
  return daily.map((day, index) => {
    let top = CHART.height;
    const segments = fills.map(([key, fill, label]) => {
      const height = scale(day[key]);
      top -= height;
      return { y: top, height, fill, label: `${label} ${formatTokens(day[key])}` };
    });
    return { x: index * CHART.step + (CHART.step - CHART.bar) / 2, segments };
  });
});

type DayTokens = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
};

const legend: Array<{ label: string; swatch: string }> = [
  { label: "in", swatch: "bg-chart-1" },
  { label: "cache read", swatch: "bg-chart-2" },
  { label: "cache creation", swatch: "bg-chart-3" },
  { label: "out", swatch: "bg-chart-4" },
];

const hasUsage = computed(
  () =>
    (stats.value?.totals.inputTokens ?? 0) +
      (stats.value?.totals.cacheReadTokens ?? 0) +
      (stats.value?.totals.cacheCreationTokens ?? 0) +
      (stats.value?.totals.outputTokens ?? 0) >
    0,
);

const liveCount = computed(() => sessions.sessions.filter((s) => s.live).length);
const recent = computed(() => sessions.sessions.slice(0, 6));
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto grid w-full max-w-[900px] gap-5 px-7 py-7">
      <header>
        <p class="font-mono text-[13px] text-primary">cc-web / overview</p>
        <h1 class="mt-3 mb-1 text-[26px] font-medium tracking-tight">Overview.</h1>
        <p class="text-sm text-muted-foreground">
          Token usage and journal activity — {{ today }}.
        </p>
      </header>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div
          v-for="kpi in kpis"
          :key="kpi.label"
          class="rounded-xl border border-border bg-card p-4"
        >
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <component :is="kpi.icon" :size="13" :class="kpi.tone" />
            {{ kpi.label }}
          </div>
          <p class="mt-2 text-[22px] leading-tight font-medium tabular-nums">
            {{ formatTokens(kpi.value) }}
          </p>
          <p class="mt-0.5 text-[11px] text-muted-foreground">all time</p>
        </div>
      </div>

      <section class="rounded-xl border border-border bg-card p-4.5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-medium">Usage — last 14 days</h2>
          <div class="flex items-center gap-3.5">
            <span
              v-for="item in legend"
              :key="item.label"
              class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <i class="size-[7px] rounded-full" :class="item.swatch" />
              {{ item.label }}
            </span>
          </div>
        </div>
        <p v-if="stats !== null && !hasUsage" class="py-10 text-center text-sm text-muted-foreground">
          No usage journaled yet — it lands here as runs complete.
        </p>
        <svg
          v-else
          class="w-full"
          :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
          role="img"
          aria-label="Daily token usage"
        >
          <g v-for="(bar, i) in bars" :key="i">
            <rect
              v-for="(segment, j) in bar.segments.filter((s) => s.height > 0)"
              :key="j"
              :x="bar.x"
              :y="segment.y"
              :width="CHART.bar"
              :height="segment.height"
              :class="segment.fill"
              rx="1"
            >
              <title>{{ stats?.daily[i]?.day }} — {{ bar.segments.filter((s) => s.height > 0).map((s) => s.label).join(", ") }}</title>
            </rect>
          </g>
        </svg>
        <div
          v-if="stats !== null"
          class="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground"
        >
          <span>{{ stats.daily[0]?.day }}</span>
          <span>{{ stats.daily.at(-1)?.day }}</span>
        </div>
      </section>

      <div class="grid gap-3 lg:grid-cols-2">
        <section class="rounded-xl border border-border bg-card p-4.5">
          <h2 class="mb-3 text-sm font-medium">Journal</h2>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
            <div>
              <dt class="text-xs text-muted-foreground">Sessions</dt>
              <dd class="mt-0.5 font-medium tabular-nums">{{ stats?.sessions ?? "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Runs</dt>
              <dd class="mt-0.5 font-medium tabular-nums">{{ stats?.runs ?? "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Events</dt>
              <dd class="mt-0.5 font-medium tabular-nums">{{ stats?.events ?? "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Runners enrolled</dt>
              <dd class="mt-0.5 font-medium tabular-nums">{{ runnersEnrolled ?? "—" }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Live now</dt>
              <dd class="mt-0.5 flex items-center gap-1.5 font-medium tabular-nums">
                {{ liveCount }}
                <i
                  v-if="liveCount > 0"
                  class="size-[7px] animate-pulse rounded-full bg-primary"
                />
              </dd>
            </div>
          </dl>
        </section>

        <section class="rounded-xl border border-border bg-card p-4.5">
          <h2 class="mb-3 text-sm font-medium">Recent sessions</h2>
          <p v-if="recent.length === 0" class="text-sm text-muted-foreground">
            No sessions yet — enroll a runner and dispatch a run.
          </p>
          <ul v-else class="grid content-start gap-0.5">
            <li v-for="s in recent" :key="s.sessionId">
              <RouterLink
                :to="`/sessions/${s.sessionId}`"
                class="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted/60"
              >
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ s.sessionId }}</span>
                <span class="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                  {{ s.eventCount }} events · {{ relativeTime(s.lastIngestedAt) }}
                  <i
                    v-if="s.live"
                    class="size-[7px] animate-pulse rounded-full bg-primary"
                    title="A run is in flight"
                  />
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>
