<script setup lang="ts">
import type { AttachmentInfo, BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { ArrowDown } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AgentChatTurn from "@/components/chat/AgentChatTurn.vue";
import UserChatBubble from "@/components/chat/UserChatBubble.vue";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApprovalTerminal } from "@/features/approvals/terminal.ts";
import { mapApprovalTerminals } from "@/features/approvals/terminal.ts";
import { deriveChatTurns } from "@/features/journal/chat-turns.ts";
import { computeScrollAnchorOffset, isNearBottom, isNearTop } from "@/features/journal/scroll.ts";

const props = defineProps<{
  events: BrowserReplayEvent[];
  /** Preloaded historical messages when resuming an existing session (§16.1, Task 13). */
  historicalMessages?: SessionMessage[];
  needsResync: boolean;
  sessionLive: boolean;
  pendingRun?: { runId: string; prompt: string; attachments?: AttachmentInfo[] };
}>();

// Chat turns fuse the resumed session's historical `SessionMessage`s with the
// live `BrowserReplayEvent` stream into a single chronological feed (§16.1).
// The derivation is pure and deterministic so a resubscribed client's view is
// identical to a live one — see the unit tests in chat-turns.test.ts.
const turns = computed(() =>
  deriveChatTurns(props.historicalMessages ?? [], props.events, props.pendingRun),
);

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

/**
 * Reverse pagination (§16.1): the first paint carries only the newest page, so
 * a long session does not mount hundreds of turns at once. Scrolling near the
 * top prepends the previous page and anchors the viewport so the reader stays
 * on the same line.
 *
 * `pinnedStart` freezes the window's first index once the reader scrolls up:
 * turns appended live must extend the bottom without dropping a turn off the
 * top, which would shift what they are reading. While it is null the window
 * follows the tail — the state the feed mounts in.
 */
const DEFAULT_PAGE_SIZE = 20;
const pinnedStart = ref<number | null>(null);

const startIndex = computed(() => {
  if (pinnedStart.value !== null) return Math.min(pinnedStart.value, turns.value.length);
  return Math.max(0, turns.value.length - DEFAULT_PAGE_SIZE);
});
const displayedTurns = computed(() => turns.value.slice(startIndex.value));
const remainingEarlier = computed(() => startIndex.value);
const hasEarlierTurns = computed(() => remainingEarlier.value > 0);

const scrollAreaRef = ref<{ $el?: HTMLElement } | null>(null);
const contentRef = ref<HTMLElement | null>(null);

/** Whether the operator has scrolled up to inspect earlier turns. */
const userScrolledUp = ref(false);
let isProgrammaticScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

function getViewport(): HTMLElement | null {
  if (!scrollAreaRef.value) return null;
  const root = (
    "$el" in scrollAreaRef.value ? scrollAreaRef.value.$el : scrollAreaRef.value
  ) as HTMLElement | null;
  if (!root || typeof root.querySelector !== "function") return null;
  return root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? root;
}

function checkScrollPosition(): void {
  const viewport = getViewport();
  if (!viewport) return;
  userScrolledUp.value = !isNearBottom(
    viewport.scrollHeight,
    viewport.scrollTop,
    viewport.clientHeight,
  );
}

function onScroll(): void {
  if (isProgrammaticScrolling) return;
  checkScrollPosition();

  const viewport = getViewport();
  if (!viewport) return;

  if (hasEarlierTurns.value && isNearTop(viewport.scrollTop)) {
    loadEarlierTurns();
    return;
  }

  // Reading above the tail: freeze the window's top so live appends cannot
  // push what is being read out of view.
  if (userScrolledUp.value && pinnedStart.value === null) {
    pinnedStart.value = startIndex.value;
  }
}

let isLoadingEarlier = false;

/** Prepend the previous page, then shift `scrollTop` by exactly the growth. */
function loadEarlierTurns(): void {
  if (!hasEarlierTurns.value || isLoadingEarlier) return;
  const viewport = getViewport();
  const previousHeight = viewport?.scrollHeight ?? 0;

  isLoadingEarlier = true;
  if (pinnedStart.value === null) pinnedStart.value = startIndex.value;
  pinnedStart.value = Math.max(0, pinnedStart.value - DEFAULT_PAGE_SIZE);

  void nextTick(() => {
    const updated = getViewport();
    if (updated) {
      updated.scrollTop += computeScrollAnchorOffset(previousHeight, updated.scrollHeight);
    }
    isLoadingEarlier = false;
  });
}

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  const viewport = getViewport();
  if (!viewport) return;

  if (behavior === "smooth") {
    isProgrammaticScrolling = true;
    userScrolledUp.value = false;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    });
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isProgrammaticScrolling = false;
      checkScrollPosition();
    }, 400);
  } else {
    viewport.scrollTop = viewport.scrollHeight;
    userScrolledUp.value = false;
  }
}

onMounted(() => {
  nextTick(() => {
    const viewport = getViewport();
    if (viewport) {
      viewport.addEventListener("scroll", onScroll, { passive: true });
      viewport.scrollTop = viewport.scrollHeight;
    }

    if (typeof ResizeObserver !== "undefined" && contentRef.value) {
      resizeObserver = new ResizeObserver(() => {
        if (!userScrolledUp.value) {
          const vp = getViewport();
          if (vp) {
            vp.scrollTop = vp.scrollHeight;
          }
        }
      });
      resizeObserver.observe(contentRef.value);
    }
  });
});

onBeforeUnmount(() => {
  const viewport = getViewport();
  if (viewport) {
    viewport.removeEventListener("scroll", onScroll);
  }
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
});

// A freshly started run or new turn signals operator intent to watch latest activity.
watch(
  () => props.pendingRun,
  (pending) => {
    if (pending) {
      userScrolledUp.value = false;
      nextTick(() => {
        scrollToBottom("smooth");
      });
    }
  },
);

watch(
  () => turns.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen) {
      const last = turns.value[turns.value.length - 1];
      if (last?.kind === "user" || !userScrolledUp.value) {
        userScrolledUp.value = false;
        nextTick(() => {
          scrollToBottom("smooth");
        });
      }
    }
  },
);
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <ScrollArea ref="scrollAreaRef" class="min-h-0 min-w-0 flex-1">
      <div ref="contentRef" class="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 px-4 py-6 md:px-6">
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
          <div v-if="hasEarlierTurns" class="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              class="text-xs text-muted-foreground hover:text-foreground"
              @click="loadEarlierTurns"
            >
              Tải thêm tin nhắn cũ (còn {{ remainingEarlier }})
            </Button>
          </div>

          <template v-for="turn in displayedTurns" :key="turn.key">
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

    <!-- Floating scroll-to-bottom button when operator scrolled up -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-2 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-2 scale-95"
    >
      <Button
        v-if="userScrolledUp"
        variant="outline"
        size="icon-sm"
        class="absolute right-4 bottom-4 z-20 size-8 rounded-full border-border/80 bg-background/90 shadow-md backdrop-blur-xs transition hover:bg-muted md:right-8"
        aria-label="Cuộn xuống dưới"
        title="Cuộn xuống dưới"
        @click="scrollToBottom('smooth')"
      >
        <ArrowDown :size="15" />
      </Button>
    </Transition>
  </div>
</template>
