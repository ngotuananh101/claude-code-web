<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { computed } from "vue";
import ApprovalCard from "@/components/ApprovalCard.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { mapApprovalTerminals } from "@/features/approvals/terminal.ts";
import { deriveJournalRows } from "@/features/journal/streaming-messages.ts";

const props = defineProps<{
  events: BrowserReplayEvent[];
  needsResync: boolean;
  sessionLive: boolean;
}>();

// Run-grouped rows with the streaming messages coalesced in (§12.3): deltas
// never render as rows — each open message is one growing row at the position
// of its last delta, closed by the message.completed that carries its id. The
// derivation is pure and tested in features/journal/streaming-messages.ts.
const rows = computed(() => deriveJournalRows(props.events));

// The journal is the authority on an approval's outcome (§13.2): a card is
// read-only once a later `approval.resolved`/`approval.expired` with the same
// id is in the transcript. Parsing lives in features/approvals/terminal.ts
// where it is unit-testable (F4).
const approvalTerminals = computed(() =>
  mapApprovalTerminals(props.events.map((event) => ({ type: event.type, payload: event.payload }))),
);

function terminalFor(event: BrowserReplayEvent) {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const approvalId = payload["approvalId"];
  return typeof approvalId === "string" ? approvalTerminals.value.get(approvalId) : undefined;
}

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
      <div v-else-if="row.kind === 'event'" class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50">
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
          :title="row.event.occurredAt"
        >
          {{ row.event.sessionSequence }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">{{ row.event.type }}</span>
          <ApprovalCard
            v-if="row.event.type === 'approval.requested'"
            :event="row.event"
            :terminal="terminalFor(row.event)"
          />
          <pre
            v-else
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground">{{
            JSON.stringify(row.event.payload, null, 2)
          }}</pre>
        </div>
      </div>
      <div v-else class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50">
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
        >
          {{ row.lastSequence }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">
            message.delta <template v-if="row.interrupted">· bị dừng giữa chừng</template>
          </span>
          <pre
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap"
            :class="row.interrupted ? 'text-muted-foreground' : 'text-foreground'"
          >{{ row.text }}</pre>
        </div>
      </div>
    </template>
    </div>
  </ScrollArea>
</template>
