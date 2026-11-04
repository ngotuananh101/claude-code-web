<script setup lang="ts">
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Folder,
  Key,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Search,
  Server,
  SquarePen,
  Trash2,
} from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/lib/i18n";
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
import { deleteSession, renameSession } from "../services/sessions-api.ts";
import { fetchWorkspaces, type OwnerWorkspace } from "../services/workspaces-api.ts";
import {
  closeSession,
  disconnectSocket,
  removeSession,
  type SessionSummary,
  sessions,
  updateSessionTitleInStore,
} from "../stores/sessions.ts";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog.vue";
import ConnectionChip from "./ConnectionChip.vue";
import UserProfileDialog from "./profiles/UserProfileDialog.vue";
import RenameDialog from "./RenameDialog.vue";

const { locale, setLocale, t } = useI18n();

const route = useRoute();
const router = useRouter();

// The shell owns whether the rail is shown (inline column or phone drawer);
// this component only asks to be dismissed.
const emit = defineEmits<{ close: [] }>();

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
  grouping.value === "runner" ? t("rail.groupByRunner") : t("rail.ungrouped"),
);
const sortIcon = computed<Component>(() => {
  if (sort.value === "oldest") return ArrowUpWideNarrow;
  if (sort.value === "name") return ArrowDownAZ;
  return ArrowDownWideNarrow;
});
const sortLabels: Record<SessionSort, string> = {
  recent: t("rail.sortRecent"),
  oldest: t("rail.sortOldest"),
  name: t("rail.sortName"),
};
const sortTitle = computed(() => `${t("rail.sort")}: ${sortLabels[sort.value]}`);

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

const profileDialogOpen = ref(false);
const userMenuOpen = ref(false);

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

const activeMenuSessionId = ref<string | null>(null);

const sessionToRename = ref<SessionSummary | null>(null);
const renameDialogOpen = ref(false);

function triggerRename(session: SessionSummary): void {
  activeMenuSessionId.value = null;
  sessionToRename.value = session;
  renameDialogOpen.value = true;
}

async function handleRenameConfirm(newTitle: string): Promise<void> {
  if (!sessionToRename.value) return;
  const sid = sessionToRename.value.sessionId;
  const ok = await renameSession(sid, newTitle);
  if (ok) {
    updateSessionTitleInStore(sid, newTitle);
    toast.success(t("common.sessionRenamed"));
  } else {
    toast.error(t("common.sessionRenameFailed"));
  }
  sessionToRename.value = null;
}

const sessionToDelete = ref<SessionSummary | null>(null);
const deleteDialogOpen = ref(false);
const deleteBusy = ref(false);

function triggerDelete(session: SessionSummary): void {
  activeMenuSessionId.value = null;
  sessionToDelete.value = session;
  deleteDialogOpen.value = true;
}

const deleteSessionTarget = computed(() => {
  if (!sessionToDelete.value) return "";
  return sessionToDelete.value.title
    ? `“${sessionToDelete.value.title}” (${sessionToDelete.value.sessionId})`
    : sessionToDelete.value.sessionId;
});

async function handleDeleteConfirm(): Promise<void> {
  if (!sessionToDelete.value) return;
  const sid = sessionToDelete.value.sessionId;
  deleteBusy.value = true;
  try {
    const ok = await deleteSession(sid);
    if (ok) {
      removeSession(sid);
      toast.success(t("common.sessionDeleted"));
      if (route.params.sessionId === sid) {
        void router.push("/sessions");
      }
    } else {
      toast.error(t("common.sessionDeleteFailed"));
    }
  } finally {
    deleteBusy.value = false;
    deleteDialogOpen.value = false;
    sessionToDelete.value = null;
  }
}
</script>

<template>
  <aside class="flex h-dvh w-[min(300px,85vw)] shrink-0 flex-col bg-sidebar sm:w-[300px]">
    <div class="flex min-w-0 items-center gap-2.5 px-4 pt-4.5">
      <RouterLink
        to="/"
        class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-85"
        :title="t('rail.dashboard')"
      >
        cc
      </RouterLink>
      <ConnectionChip />
      <span class="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          class="size-9 sm:size-6"
          :aria-label="t('common.back')"
          :disabled="!canGoBack"
          @click="router.back()"
        >
          <ChevronLeft :size="15" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="size-9 sm:size-6"
          :aria-label="t('common.forward')"
          :disabled="!canGoForward"
          @click="router.forward()"
        >
          <ChevronRight :size="15" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="size-9 sm:size-6"
          :aria-label="t('rail.collapseSidebar')"
          :title="t('rail.collapseSidebar')"
          @click="emit('close')"
        >
          <PanelLeftClose :size="15" />
        </Button>
      </span>
    </div>

    <!-- Nav rows sit on the desktop pitch here too: the drawer is the same
         sidebar, and a phone does not need extra air between four fixed
         destinations. -->
    <nav class="grid gap-0 px-3 pt-2.5">
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
        {{ t("rail.dashboard") }}
      </RouterLink>
      <button
        type="button"
        class="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors"
        :class="
          route.name === 'sessions' && route.params.sessionId == null
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        "
        :title="t('rail.newSession')"
        @click="newSession"
      >
        <SquarePen :size="15" />
        {{ t("rail.newSession") }}
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
        {{ t("rail.runners") }}
      </RouterLink>
      <RouterLink
        to="/profiles"
        class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors"
        :class="
          route.name === 'profiles'
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        "
      >
        <Key :size="15" />
        {{ t("rail.profiles") }}
      </RouterLink>
    </nav>

    <ScrollArea class="min-h-0 flex-1">
      <div class="px-2 pb-2">
        <div class="flex h-9 items-center justify-between px-2.5">
          <p class="text-sm font-semibold text-foreground">{{ t("rail.sessions") }}</p>
          <span class="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-9 sm:size-6"
              :aria-label="t('rail.groupByRunner')"
              :title="groupingTitle"
              @click="toggleGrouping"
            >
              <component :is="groupingIcon" :size="15" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-9 sm:size-6"
              :aria-label="t('rail.sort')"
              :title="sortTitle"
              @click="cycleSort"
            >
              <component :is="sortIcon" :size="15" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-9 sm:size-6"
              :aria-label="t('rail.searchPlaceholder')"
              :title="t('rail.searchTitle')"
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
              <li
                v-for="row in group.sessions"
                :key="row.session.sessionId"
                class="group relative flex items-center"
              >
                <Button
                  variant="ghost"
                  class="h-auto min-h-11 w-full justify-between gap-2 rounded-lg px-2.5 py-2.5 font-normal sm:min-h-0 sm:py-1.5"
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
                    <span
                      class="min-w-0 flex-1 truncate text-left text-xs"
                      :class="row.session.title ? 'font-medium' : 'font-mono text-muted-foreground'"
                      :title="row.session.title || row.session.sessionId"
                    >
                      {{ row.session.title || row.session.sessionId }}
                    </span>
                  </span>
                  <span
                    class="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity max-lg:hidden"
                    :class="
                      activeMenuSessionId === row.session.sessionId
                        ? 'opacity-0'
                        : 'group-hover:opacity-0'
                    "
                  >
                    <span>
                      {{ relativeTime(row.session.lastIngestedAt, now) }}
                    </span>
                    <span
                      v-if="row.session.live"
                      class="size-[7px] animate-pulse rounded-full bg-primary"
                      :title="t('common.activeRun')"
                    />
                  </span>
                </Button>

                <Popover
                  :open="activeMenuSessionId === row.session.sessionId"
                  @update:open="(val: boolean) => (activeMenuSessionId = val ? row.session.sessionId : null)"
                >
                  <PopoverTrigger as-child>
                    <button
                      type="button"
                      class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-2 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 sm:p-1"
                      :class="
                        activeMenuSessionId === row.session.sessionId
                          ? 'opacity-100 bg-muted text-foreground pointer-events-auto'
                          : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto max-lg:pointer-events-auto max-lg:opacity-100'
                      "
                      :aria-label="t('rail.sessionOptions')"
                      :title="t('rail.actions')"
                      @click.stop
                    >
                      <MoreHorizontal :size="14" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent class="w-36 p-1 gap-0.5 rounded-lg" align="end" :side-offset="4">
                    <button
                      type="button"
                      class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-sm text-foreground transition-colors hover:bg-muted text-left sm:min-h-0 sm:py-1.5 sm:text-xs"
                      @click.stop="triggerRename(row.session)"
                    >
                      <Pencil :size="13" class="shrink-0" />
                      <span>{{ t("common.rename") }}</span>
                    </button>
                    <button
                      type="button"
                      class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/10 text-left sm:min-h-0 sm:py-1.5 sm:text-xs"
                      @click.stop="triggerDelete(row.session)"
                    >
                      <Trash2 :size="13" class="shrink-0" />
                      <span>{{ t("common.delete") }}</span>
                    </button>
                  </PopoverContent>
                </Popover>
              </li>
            </ul>
          </div>
        </div>
        <p
          v-else-if="sessions.loaded"
          class="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          {{ t("rail.noSessions") }}
        </p>
        <p v-else class="px-2.5 py-2 text-xs text-muted-foreground">{{ t("rail.readingJournal") }}</p>
      </div>
    </ScrollArea>

    <footer class="px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      <Popover :open="userMenuOpen" @update:open="(val: boolean) => (userMenuOpen = val)">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
            :aria-label="t('user.title')"
          >
            <span v-if="sessions.avatar" class="shrink-0 rounded-full object-cover">
              <img
                :src="sessions.avatar"
                alt="Avatar"
                class="size-6 shrink-0 rounded-full object-cover"
              />
            </span>
            <span
              v-else
              class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary uppercase"
            >
              {{ accountInitial }}
            </span>
            <span class="flex-1 truncate text-[13px] font-medium text-left">{{
              sessions.account ?? "—"
            }}</span>
            <EllipsisVertical :size="14" class="shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          class="w-56 gap-0.5 p-1 rounded-lg"
          align="end"
          :side-offset="4"
          @open-auto-focus="(e: Event) => e.preventDefault()"
        >
          <div class="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
            {{ t("user.language") }}
          </div>
          <div class="grid grid-cols-2 gap-1 px-2 pb-1.5">
            <Button
              :variant="locale === 'vi' ? 'secondary' : 'ghost'"
              size="xs"
              class="gap-1"
              @click="() => { setLocale('vi'); userMenuOpen = false }"
            >
              <span>🇻🇳</span>
              <span>VN</span>
            </Button>
            <Button
              :variant="locale === 'en' ? 'secondary' : 'ghost'"
              size="xs"
              class="gap-1"
              @click="() => { setLocale('en'); userMenuOpen = false }"
            >
              <span>🇺🇸</span>
              <span>EN</span>
            </Button>
          </div>
          <div class="my-1 h-px bg-border" />
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-sm text-foreground transition-colors hover:bg-muted text-left sm:min-h-0 sm:py-1.5 sm:text-xs"
            @click="() => { profileDialogOpen = true; userMenuOpen = false }"
          >
            <Pencil :size="13" class="shrink-0" />
            <span>{{ t("user.profile") }}</span>
          </button>
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/10 text-left sm:min-h-0 sm:py-1.5 sm:text-xs"
            @click="() => { signOut(); userMenuOpen = false }"
          >
            <LogOut :size="13" class="shrink-0" />
            <span>{{ t("common.logout") }}</span>
          </button>
        </PopoverContent>
      </Popover>
      <UserProfileDialog v-model:open="profileDialogOpen" />
    </footer>

    <CommandDialog
      v-model:open="searchOpen"
      :title="t('rail.searchTitle')"
      :description="t('rail.searchDescription')"
    >
      <CommandInput :placeholder="t('rail.searchPlaceholder')" />
      <CommandList>
        <CommandEmpty>{{ t("rail.noMatchingSessions") }}</CommandEmpty>
        <CommandGroup
          v-for="group in groups"
          :key="group.key"
          :heading="`${group.label} (${group.detail})`"
        >
          <CommandItem
            v-for="row in group.sessions"
            :key="row.session.sessionId"
            :value="row.session.title ? `${row.session.title} ${row.session.sessionId}` : row.session.sessionId"
            @select="goToSession(row.session.sessionId)"
          >
            <span
              v-if="grouping === 'runner' && row.folder"
              class="mr-1.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            >
              {{ row.folder }}
            </span>
            <span
              class="min-w-0 flex-1 truncate text-xs"
              :class="row.session.title ? 'font-medium' : 'font-mono text-muted-foreground'"
            >
              {{ row.session.title || row.session.sessionId }}
            </span>
            <span class="shrink-0 text-[11px] text-muted-foreground">
              {{ relativeTime(row.session.lastIngestedAt, now) }}
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>

    <RenameDialog
      v-model:open="renameDialogOpen"
      :title="t('common.renameSession')"
      :description="t('common.renameSessionDescription')"
      :initial-value="sessionToRename?.title || ''"
      :placeholder="t('common.enterSessionName')"
      @confirm="handleRenameConfirm"
    />

    <ConfirmDeleteDialog
      v-model:open="deleteDialogOpen"
      :title="t('common.deleteSession')"
      :description="t('rail.confirmDeleteSession', { target: deleteSessionTarget })"
      :warning="t('common.deleteSessionWarning')"
      :confirm-label="t('common.delete')"
      :busy="deleteBusy"
      @confirm="handleDeleteConfirm"
    />
  </aside>
</template>
