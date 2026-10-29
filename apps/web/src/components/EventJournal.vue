<script setup lang="ts">
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { computed } from "vue";
import AgentChatTurn from "@/components/chat/AgentChatTurn.vue";
import UserChatBubble from "@/components/chat/UserChatBubble.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApprovalTerminal } from "@/features/approvals/terminal.ts";
import { mapApprovalTerminals } from "@/features/approvals/terminal.ts";
import { deriveChatTurns } from "@/features/journal/chat-turns.ts";

const props = defineProps<{
  events: BrowserReplayEvent[];
  /** Preloaded historical messages when resuming an existing session (§16.1, Task 13). */
  historicalMessages?: SessionMessage[];
  needsResync: boolean;
  sessionLive: boolean;
}>();

// Chat turns fuse the resumed session's historical `SessionMessage`s with the
// live `BrowserReplayEvent` stream into a single chronological feed (§16.1).
// The derivation is pure and deterministic so a resubscribed client's view is
// identical to a live one — see the unit tests in chat-turns.test.ts.
const turns = computed(() => deriveChatTurns(props.historicalMessages ?? [], props.events));

// The journal is the authority on an approval's outcome (§13.2): a card is
// read-only once a later `approval.resolved`/`approval.expired` with the same
// id is in the transcript. Parsing lives in features/approvals/terminal.ts
// where it is unit-testable (F4).
const approvalTerminals = computed(() =>
  mapApprovalTerminals(props.events.map((event) => ({ type: event.type, payload: event.payload }))),
);

function terminalFor(event: BrowserReplayEvent): ApprovalTerminal | undefined {
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
    <div class="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <p
        v-if="needsResync"
        class="border-l-2 border-destructive bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive"
      >
        Journal đang được sửa chữa. Retention đã xoá phần lịch sử mà view này
        đang giữ, bản ghi sẽ bắt đầu lại từ sự kiện còn sót sớm nhất.
      </p>

      <p v-else-if="turns.length === 0" class="text-sm text-muted-foreground">
        {{ emptyCopy }}
      </p>

      <template v-else>
        <template v-for="turn in turns" :key="turn.key">
          <UserChatBubble v-if="turn.kind === 'user'" :turn="turn" />
          <AgentChatTurn
            v-else-if="turn.kind === 'agent'"
            :turn="turn"
            :terminal-for="terminalFor"
          />
        </template>
      </template>
    </div>
  </ScrollArea>
</template>
