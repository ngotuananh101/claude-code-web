<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { computed } from "vue";

const props = defineProps<{
  events: BrowserReplayEvent[];
  needsResync: boolean;
  sessionLive: boolean;
}>();

// Run-grouped rows: a header whenever the transcript crosses into a new
// run, then the events. Sequence numbers stay in the gutter — the replay
// coordinate system the operator thinks in (§12.5).
type Row =
  | { kind: "run"; runId: string; key: string }
  | { kind: "event"; event: BrowserReplayEvent };

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  let lastRun: string | null = null;
  for (const event of props.events) {
    if (event.runId !== lastRun) {
      out.push({ kind: "run", runId: event.runId, key: `run-${event.runId}` });
      lastRun = event.runId;
    }
    out.push({ kind: "event", event });
  }
  return out;
});

const emptyCopy = computed(() =>
  props.sessionLive ? "Waiting for the first event." : "Nothing journaled for this session.",
);
</script>

<template>
  <div class="journal">
    <p v-if="needsResync" class="repair">
      The journal is being repaired. Retention removed history this view
      trusted, so the transcript is restarting from the earliest surviving
      event.
    </p>

    <p v-else-if="events.length === 0" class="empty">{{ emptyCopy }}</p>

    <template v-for="row in rows" :key="row.kind === 'event' ? row.event.sessionSequence : row.key">
      <div v-if="row.kind === 'run'" class="run-row">
        <span class="mono">{{ row.runId }}</span>
      </div>
      <div v-else class="event-row">
        <span class="seq mono" :title="row.event.occurredAt">{{ row.event.sessionSequence }}</span>
        <div class="event-body">
          <span class="event-type mono">{{ row.event.type }}</span>
          <pre class="payload mono">{{ JSON.stringify(row.event.payload, null, 2) }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.journal {
  flex: 1;
  overflow-y: auto;
  padding: 10px 28px 24px 0;
}

.repair {
  margin: 18px 0 0 28px;
  padding: 10px 14px;
  background: var(--amber-wash);
  border-left: 2px solid var(--amber);
  color: var(--amber);
  font-size: 13px;
}

.empty {
  margin: 44px 28px;
  color: var(--mute);
  font-size: 14px;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 22px 0 6px 28px;
  font-size: 12px;
  color: var(--mute);
}

.run-row::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}

.event-row {
  display: grid;
  grid-template-columns: 76px 1fr;
  padding: 7px 0;
}

.event-row:hover {
  background: #f4f5f1;
}

.seq {
  text-align: right;
  padding-right: 18px;
  color: var(--mute);
  font-size: 12px;
  line-height: 1.9;
  user-select: all;
}

.event-type {
  font-size: 12px;
  color: var(--mute);
}

.payload {
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--ink);
}
</style>
