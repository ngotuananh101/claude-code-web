<script setup lang="ts">
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { computed } from "vue";
import ApprovalCard from "@/components/ApprovalCard.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { mapApprovalTerminals } from "@/features/approvals/terminal.ts";
import { deriveHistoryRows, hasProse } from "@/features/journal/history-messages.ts";
import { assistantTextOf, proseClasses, renderMarkdown } from "@/features/journal/markdown.ts";
import { deriveJournalRows } from "@/features/journal/streaming-messages.ts";

const props = defineProps<{
  events: BrowserReplayEvent[];
  /** Preloaded historical messages when resuming an existing session (§16.1, Task 13). */
  historicalMessages?: SessionMessage[];
  needsResync: boolean;
  sessionLive: boolean;
}>();

// Replayed conversation history for a resumed session (§16.1, Task 13). The
// messages come preloaded from the runner; the extraction lives in
// history-messages.ts so it is unit-tested independently of the SFC. Empty by
// default so a fresh session renders only its live transcript.
const historyRows = computed(() => deriveHistoryRows(props.historicalMessages ?? []));

// Run-grouped rows with the streaming messages and tool calls coalesced in
// (§12.3): deltas never render as rows — each open message is one growing row
// at the position of its last delta, closed by the message.completed that
// carries its id — and a tool's started/completed pair collapses into one row
// per call that settles when the tool returns. The derivation is pure and
// tested in features/journal/streaming-messages.ts.
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

// The prose inside a completed assistant message; "" means the payload is not
// the assistant shape the executor writes, and the row falls back to raw JSON
// so an unexpected shape stays visible (markdown.ts owns the extraction).
function proseOf(event: BrowserReplayEvent): string {
  return event.type === "message.completed" ? assistantTextOf(event.payload) : "";
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

    <!-- Historical conversation replayed from the Claude Code transcript (§16.1,
         Task 13): rendered chronologically above the live run events, with a
         section header so the operator knows these were replayed, not live. -->
    <template v-if="historyRows.length > 0">
      <div class="mt-4.5 mb-3 ml-5 flex items-center gap-2.5 text-xs text-muted-foreground">
        <span class="h-px w-8 bg-border" aria-hidden="true" />
        <span class="font-mono">Lịch sử hội thoại</span>
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div
        v-for="row in historyRows"
        :key="row.key"
        class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50"
      >
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
          :title="row.uuid"
        >
          {{ row.type }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">{{ row.uuid }}</span>
          <!-- v-html is safe here the same way the live prose is: markdown.ts
               disables raw HTML and scheme-validates links, pinned by tests. -->
          <div
            v-if="hasProse(row)"
            :class="proseClasses"
            v-html="renderMarkdown(row.text)"
          ></div>
          <pre
            v-else
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground"
            >{{ row.rendered }}</pre>
        </div>
      </div>
    </template>

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
          <!-- v-html is safe here by construction: markdown.ts renders with
               raw HTML disabled and scheme-validated links, pinned by tests. -->
          <div
            v-else-if="proseOf(row.event) !== ''"
            :class="proseClasses"
            v-html="renderMarkdown(proseOf(row.event))"
          ></div>
          <pre
            v-else
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground">{{
            JSON.stringify(row.event.payload, null, 2)
          }}</pre>
        </div>
      </div>
      <div v-else-if="row.kind === 'tool'" class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50">
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
          :title="row.lastOccurredAt"
        >
          {{ row.lastSequence }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">
            tool · {{ row.toolName ?? "…" }}
            <template v-if="row.state === 'running'">· đang chạy</template>
            <template v-else-if="row.state === 'error'">
              <span class="text-destructive">· lỗi</span>
            </template>
            <template v-else-if="row.state === 'interrupted'">· bị dừng giữa chừng</template>
          </span>
          <pre
            v-if="row.inputSummary"
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-muted-foreground">{{ row.inputSummary }}</pre>
          <pre
            v-if="row.outputSummary"
            class="mt-0.5 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-muted-foreground">{{ row.outputSummary }}</pre>
        </div>
      </div>
      <div v-else class="grid grid-cols-[76px_1fr] py-1.75 hover:bg-muted/50">
        <span
          class="pr-4.5 text-right text-xs leading-[1.9] font-mono text-muted-foreground select-all"
          :title="row.lastOccurredAt"
        >
          {{ row.lastSequence }}
        </span>
        <div>
          <span class="font-mono text-xs text-muted-foreground">
            message.delta <template v-if="row.interrupted">· bị dừng giữa chừng</template>
          </span>
          <div
            :class="[proseClasses, row.interrupted ? 'text-muted-foreground' : 'text-foreground']"
            v-html="renderMarkdown(row.text)"
          ></div>
        </div>
      </div>
    </template>
    </div>
  </ScrollArea>
</template>
