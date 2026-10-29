<script setup lang="ts">
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  ChevronLeft,
  ChevronRight,
  Folder,
  LayoutDashboard,
  LogOut,
  Search,
  Server,
  SquarePen,
} from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  groupSessions,
  nextGrouping,
  nextSort,
  parseGrouping,
  parseSort,
  type SessionGrouping,
  type SessionSort,
} from "../features/sessions/session-groups.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { stopTokenRefreshTimer } from "../services/auth-api.ts";
import { fetchWorkspaces, type OwnerWorkspace } from "../services/workspaces-api.ts";
import { closeSession, disconnectSocket, sessions } from "../stores/sessions.ts";
import ConnectionChip from "./ConnectionChip.vue";

const route = useRoute();
const router = useRouter();

const workspaces = ref<OwnerWorkspace[]>([]);

async function refreshWorkspaces(): Promise<void> {
  const result = await fetchWorkspaces();
  if (result.ok) workspaces.value = result.workspaces;
}

// The rail's two view choices outlive a reload, so an operator who grouped by
// runner last week still finds that shape. Storage can be blocked (private
// window); the choice then simply lasts for the visit.
const GROUPING_KEY = "cc-web.sessions.grouping";
const SORT_KEY = "cc-web.sessions.sort";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked storage is not a broken rail — the preference is per-visit.
  }
}

const grouping = ref<SessionGrouping>(parseGrouping(readStored(GROUPING_KEY)));
const sort = ref<SessionSort>(parseSort(readStored(SORT_KEY)));
watch(grouping, (value) => writeStored(GROUPING_KEY, value));
watch(sort, (value) => writeStored(SORT_KEY, value));

const groups = computed(() =>
  groupSessions(sessions.sessions, workspaces.value, grouping.value, sort.value),
);

const groupingIcon = computed<Component>(() => (grouping.value === "runner" ? Server : Folder));
const groupingTitle = computed(() =>
  grouping.value === "runner"
    ? "Đang gộp theo runner — bấm để gộp theo project"
    : "Đang gộp theo project — bấm để gộp theo runner",
);
const sortIcon = computed<Component>(() => {
  if (sort.value === "oldest") return ArrowUpWideNarrow;
  if (sort.value === "name") return ArrowDownAZ;
  return ArrowDownWideNarrow;
});
const sortLabels: Record<SessionSort, string> = {
  recent: "mới nhất trước",
  oldest: "cũ nhất trước",
  name: "theo id",
};
const sortTitle = computed(() => `Sắp xếp: ${sortLabels[sort.value]} — bấm để đổi`);

function toggleGrouping(): void {
  grouping.value = nextGrouping(grouping.value);
}

function cycleSort(): void {
  sort.value = nextSort(sort.value);
}

// vue-router writes {back, current, forward} into history.state; reading it
// on every route change is what keeps the arrows honest.
const canGoBack = computed(() => {
  void route.fullPath;
  return window.history.state?.back != null;
});
const canGoForward = computed(() => {
  void route.fullPath;
  return window.history.state?.forward != null;
});

// The avatar is the account's first letter; "?" while /api/me is in flight.
const accountInitial = computed(() => sessions.account?.[0] ?? "?");

// The rail's "5m ago" stays honest on an open page.
const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 30_000);
onUnmounted(() => clearInterval(ticker));

const searchOpen = ref(false);

// Selecting a hit closes the palette and holds that session's journal.
function goToSession(sessionId: string): void {
  searchOpen.value = false;
  void router.push(`/sessions/${sessionId}`);
}

// Ctrl/Cmd+K opens the palette from anywhere in the app.
function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchOpen.value = true;
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void refreshWorkspaces();
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// Re-read workspace declarations whenever sessions change so newly custom-registered
// folders resolve their path without requiring a full page refresh.
watch(
  () => sessions.sessions.length,
  () => void refreshWorkspaces(),
);

// "New session" leaves the held journal for the composer page: §11's dispatch
// API is what will let a prompt create a session from there.
function newSession(): void {
  closeSession();
  void router.push("/sessions");
}

async function signOut(): Promise<void> {
  // Opt out of WebSocket updates before leaving the authenticated shell so no
  // frames land past the redirect. The server bumps the token version and
  // revokes outstanding tokens (§19.1).
  disconnectSocket();
  stopTokenRefreshTimer();
  await fetch("/auth/logout", { method: "POST" });
  await router.push("/login");
}
</script>

<template>
  <aside class="flex h-full w-[300px] shrink-0 flex-col bg-sidebar">
    <div class="flex items-center gap-2.5 px-4 pt-4.5">
      <RouterLink
        to="/"
        class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-85"
        title="Tổng quan"
      >
        cc
      </RouterLink>
      <ConnectionChip />
      <span class="ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Quay lại"
          :disabled="!canGoBack"
          @click="router.back()"
        >
          <ChevronLeft :size="15" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Tiến"
          :disabled="!canGoForward"
          @click="router.forward()"
        >
          <ChevronRight :size="15" />
        </Button>
      </span>
    </div>

    <nav class="grid gap-0.5 px-3 pt-4">
      <RouterLink
        to="/"
        class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors"
        :class="
          route.name === 'dashboard'
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        "
      >
        <LayoutDashboard :size="15" />
        Tổng quan
      </RouterLink>
      <button
        type="button"
        class="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors"
        :class="
          route.name === 'sessions' && route.params.sessionId == null
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        "
        title="Tháo journal — phiên kế tiếp sẽ hiện ở đây ngay khi runner bắt đầu"
        @click="newSession"
      >
        <SquarePen :size="15" />
        Phiên mới
      </button>
      <RouterLink
        to="/runners"
        class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors"
        :class="
          route.name === 'runners'
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        "
      >
        <Server :size="15" />
        Runners
      </RouterLink>
    </nav>

    <ScrollArea class="min-h-0 flex-1">
      <div class="px-2 pb-2">
      <div class="flex h-9 items-center justify-between px-2.5">
        <p class="text-sm font-semibold text-foreground">Phiên</p>
        <span class="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Đổi cách gộp phiên"
            :title="groupingTitle"
            @click="toggleGrouping"
          >
            <component :is="groupingIcon" :size="15" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Đổi cách sắp xếp phiên"
            :title="sortTitle"
            @click="cycleSort"
          >
            <component :is="sortIcon" :size="15" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Tìm phiên"
            title="Tìm phiên (Ctrl+K)"
            @click="searchOpen = true"
          >
            <Search :size="15" />
          </Button>
        </span>
      </div>
      <!-- Grouped by project or by runner, per the two buttons above — never an
           un-scoped flat list. -->
      <div v-if="groups.length > 0" class="space-y-3">
        <div v-for="group in groups" :key="group.key" class="space-y-0.5">
          <div
            class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
            :title="group.title"
          >
            <component
              :is="grouping === 'runner' ? Server : Folder"
              :size="12"
              class="shrink-0 text-primary"
            />
            <span class="truncate font-mono">{{ group.label }}</span>
            <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
              {{ group.detail }}
            </span>
          </div>
          <ul class="grid grid-cols-1 content-start gap-0.5 pl-1.5">
            <li v-for="row in group.sessions" :key="row.session.sessionId">
              <Button
                variant="ghost"
                class="h-auto w-full justify-between gap-2 rounded-lg px-2.5 py-1.5 font-normal"
                :class="
                  row.session.sessionId === sessions.activeId &&
                  'bg-sidebar-accent shadow-[inset_2px_0_0_var(--primary)]'
                "
                @click="router.push(`/sessions/${row.session.sessionId}`)"
              >
                <span class="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    v-if="grouping === 'runner' && row.folder"
                    class="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {{ row.folder }}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-left font-mono text-xs">
                    {{ row.session.sessionId }}
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  {{ relativeTime(row.session.lastIngestedAt, now) }}
                  <span
                    v-if="row.session.live"
                    class="size-[7px] animate-pulse rounded-full bg-primary"
                    title="Có một run đang chạy"
                  />
                </span>
              </Button>
            </li>
          </ul>
        </div>
      </div>
      <p
        v-else-if="sessions.loaded"
        class="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
      >
        Chưa có phiên nào. Chọn runner và thư mục để tạo phiên mới.
      </p>
      <p v-else class="px-2.5 py-2 text-xs text-muted-foreground">Đang đọc journal…</p>
      </div>
    </ScrollArea>

    <footer class="px-3 py-2.5">
      <div class="flex items-center gap-2.5">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary uppercase"
        >
          {{ accountInitial }}
        </span>
        <span class="flex-1 truncate text-[13px]">{{ sessions.account ?? "—" }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Đăng xuất"
          class="text-muted-foreground hover:text-destructive"
          @click="signOut"
        >
          <LogOut :size="14" />
        </Button>
      </div>
    </footer>

    <CommandDialog
      v-model:open="searchOpen"
      title="Tìm phiên"
      description="Chọn một phiên để mở journal của nó."
    >
      <CommandInput placeholder="Tìm phiên theo id…" />
      <CommandList>
        <CommandEmpty>Không có phiên nào khớp.</CommandEmpty>
        <CommandGroup
          v-for="group in groups"
          :key="group.key"
          :heading="`${group.label} (${group.detail})`"
        >
          <CommandItem
            v-for="row in group.sessions"
            :key="row.session.sessionId"
            :value="row.session.sessionId"
            @select="goToSession(row.session.sessionId)"
          >
            <span
              v-if="grouping === 'runner' && row.folder"
              class="mr-1.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            >
              {{ row.folder }}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">
              {{ row.session.sessionId }}
            </span>
            <span class="shrink-0 text-[11px] text-muted-foreground">
              {{ relativeTime(row.session.lastIngestedAt, now) }}
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  </aside>
</template>
