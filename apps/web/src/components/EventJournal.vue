<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { computed } from "vue";
import { ScrollArea } from "@/components/ui/scroll-area";

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
  props.sessionLive ? "Đang chờ sự kiện đầu tiên." : "Phiên này chưa có gì trong journal.",
);
</script>

<template>
  <ScrollArea class="min-h-0 flex-1">
    <div class="pt-2.5 pr-7 pb-6">
    <p
      v-if="needsResync"
      class="mt-4.5 ml-5 border-l-2 border-destructive bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive"
    >
      Journal đang được sửa chữa. Retention đã xoá phần lịch sử mà view này
      đang giữ, bản ghi sẽ bắt đầu lại từ sự kiện còn sót sớm nhất.
    </p>

    <p v-else-if="events.length === 0" class="mt-11 ml-5 mb-11 text-sm text-muted-foreground">
      {{ emptyCopy }}
    </p>

    <template v-for="row in rows" :key="row.kind === 'event' ? row.event.sessionSequence : row.key">
      <div
        v-if="row.kind === 'run'"
        class="mt-5.5 mb-1.5 ml-5 flex items-center gap-3.5 text-xs text-muted-foreground"
      >
        <span class="font-mono">{{ row.runId }}</span>
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div v-else class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50">
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
          :title="row.event.occurredAt"
        >
          {{ row.event.sessionSequence }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">{{ row.event.type }}</span>
          <pre class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground">{{
            JSON.stringify(row.event.payload, null, 2)
          }}</pre>
        </div>
      </div>
    </template>
    </div>
  </ScrollArea>
</template>
