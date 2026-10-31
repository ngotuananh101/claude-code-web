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
import {
  computeScrollAnchorOffset,
  isNearBottom,
  isNearTop,
  previousPageStart,
  resolveScrollBehavior,
  resolveWindowStart,
  shouldAutoLoadEarlier,
  shouldFollowAppend,
} from "@/features/journal/scroll.ts";

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
 *
 * `earliestLoadedIndex` tracks how far back the reader has expanded history.
 * Once older turns are loaded (via button or upward scroll), they remain loaded
 * even if the reader scrolls back to the tail to inspect new output.
 */
const pinnedStart = ref<number | null>(null);
const earliestLoadedIndex = ref<number | null>(null);

const startIndex = computed(() => resolveWindowStart(pinnedStart.value, turns.value.length));
const displayedTurns = computed(() => turns.value.slice(startIndex.value));
const remainingEarlier = computed(() => startIndex.value);
const hasEarlierTurns = computed(() => remainingEarlier.value > 0);

const scrollAreaRef = ref<{ $el?: HTMLElement } | null>(null);
const contentRef = ref<HTMLElement | null>(null);

/** Whether initial scroll positioning to the bottom has settled. */
const isMountedAndScrolled = ref(false);

/** Whether the operator has scrolled up to inspect earlier turns. */
const userScrolledUp = ref(false);
let isProgrammaticScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeRaf: number | null = null;

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
  // Back at the tail: if earlier history has not been expanded, release the
  // window to follow the tail live. If earlier history WAS expanded, preserve
  // it so the loaded messages are not abruptly truncated.
  if (!userScrolledUp.value) {
    pinnedStart.value = earliestLoadedIndex.value;
  }
}

function onScroll(): void {
  if (isProgrammaticScrolling) return;
  checkScrollPosition();

  const viewport = getViewport();
  if (!viewport) return;

  if (
    shouldAutoLoadEarlier(
      userScrolledUp.value,
      hasEarlierTurns.value,
      viewport.scrollTop,
      viewport.scrollHeight,
      viewport.clientHeight,
    )
  ) {
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

/**
 * Prepend the previous page, then shift `scrollTop` so the turn the reader was
 * looking at stays put. The anchor is that turn's own box, not the container's
 * total height: content still streaming in at the bottom must not inflate the
 * correction. The height delta is the fallback when no turn is rendered yet.
 */
function loadEarlierTurns(): void {
  if (!hasEarlierTurns.value || isLoadingEarlier) return;
  const viewport = getViewport();
  if (!viewport) return;

  const anchor = contentRef.value?.querySelector<HTMLElement>("[data-turn-key]");
  const anchorTop = anchor?.getBoundingClientRect().top;
  const previousHeight = viewport.scrollHeight;

  isLoadingEarlier = true;
  const nextStart = previousPageStart(startIndex.value);
  earliestLoadedIndex.value = nextStart;
  pinnedStart.value = nextStart;

  void nextTick(() => {
    const updated = getViewport();
    if (updated) {
      const nextAnchorTop = anchor?.getBoundingClientRect().top;
      const offset =
        anchorTop !== undefined && nextAnchorTop !== undefined
          ? Math.max(nextAnchorTop - anchorTop, 0)
          : computeScrollAnchorOffset(previousHeight, updated.scrollHeight);
      updated.scrollTop += offset;
    }
    isLoadingEarlier = false;
  });
}

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  const viewport = getViewport();
  if (!viewport) return;

  isProgrammaticScrolling = true;
  userScrolledUp.value = false;
  if (scrollTimeout) clearTimeout(scrollTimeout);

  if (behavior === "smooth") {
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    });
    scrollTimeout = setTimeout(() => {
      isProgrammaticScrolling = false;
      checkScrollPosition();
    }, 400);
  } else {
    viewport.scrollTop = viewport.scrollHeight;
    scrollTimeout = setTimeout(() => {
      isProgrammaticScrolling = false;
      checkScrollPosition();
    }, 50);
  }
}

onMounted(() => {
  nextTick(() => {
    const viewport = getViewport();
    if (viewport) {
      viewport.addEventListener("scroll", onScroll, { passive: true });
      viewport.scrollTop = viewport.scrollHeight;
    }
    requestAnimationFrame(() => {
      const vp = getViewport();
      if (vp) vp.scrollTop = vp.scrollHeight;
      isMountedAndScrolled.value = true;
    });

    if (typeof ResizeObserver !== "undefined" && contentRef.value) {
      resizeObserver = new ResizeObserver(() => {
        if (!userScrolledUp.value) {
          if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
          resizeRaf = requestAnimationFrame(() => {
            resizeRaf = null;
            scrollToBottom("auto");
          });
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
  if (resizeRaf !== null) {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = null;
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

let lastTailKey: string | undefined = turns.value[turns.value.length - 1]?.key;

// New content only pulls the viewport down while the operator is already at
// the tail. A user turn does not override an upward read: it can arrive from
// another client or a replay, and the composer's own send is handled by the
// `pendingRun` watcher above, which scrolls unconditionally.
watch(
  () => turns.value.length,
  (newLen, oldLen = 0) => {
    const currentTailKey = newLen > 0 ? turns.value[newLen - 1]?.key : undefined;
    const previousTailKey = lastTailKey;
    lastTailKey = currentTailKey;

    if (!shouldFollowAppend(oldLen, newLen, userScrolledUp.value)) return;

    const behavior = resolveScrollBehavior(oldLen, newLen, previousTailKey, currentTailKey);
    nextTick(() => {
      scrollToBottom(behavior);
    });
  },
);
</script>

<template>
  <div
    class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-opacity duration-150"
    :class="isMountedAndScrolled ? 'opacity-100' : 'opacity-0'"
  >
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
            <UserChatBubble v-if="turn.kind === 'user'" :turn="turn" :data-turn-key="turn.key" />
            <AgentChatTurn
              v-else-if="turn.kind === 'agent'"
              :turn="turn"
              :terminal-for="terminalFor"
              :data-turn-key="turn.key"
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
