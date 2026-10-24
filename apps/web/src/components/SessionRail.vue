<script setup lang="ts">
import { LogOut, Search, Server, SquarePen } from "@lucide/vue";
import { computed, onUnmounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeTime } from "../lib/relative-time.ts";
import { closeSession, openSession, sessions } from "../stores/sessions.ts";
import ConnectionChip from "./ConnectionChip.vue";

const router = useRouter();
const query = ref("");

// The rail's "5m ago" stays honest on an open page.
const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 30_000);
onUnmounted(() => clearInterval(ticker));

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (needle === "") return sessions.sessions;
  return sessions.sessions.filter((s) => s.sessionId.toLowerCase().includes(needle));
});

// "New session" is a detach, honestly labelled as such: §11's dispatch API is
// what will let a prompt create a session from here. Until then the greeting
// state is where the operator lands between journals.
function newSession(): void {
  closeSession();
}

async function signOut(): Promise<void> {
  // The server bumps the token version (killing every outstanding token) and
  // revokes the owner's live socket (§19.1); the journal then reconnects
  // into the login page.
  await fetch("/auth/logout", { method: "POST" });
  await router.push("/login");
}
</script>

<template>
  <aside class="flex h-full w-[270px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
    <div class="flex items-center gap-2.5 px-4 pt-4.5">
      <span
        class="grid size-7 shrink-0 place-items-center rounded-lg bg-primary font-mono text-xs font-semibold text-primary-foreground"
      >
        cc
      </span>
      <span class="text-sm font-medium">cc-web</span>
    </div>

    <nav class="grid gap-0.5 px-3 pt-4">
      <Button
        variant="secondary"
        class="h-9 w-full justify-start gap-2.5 rounded-lg text-[13px] font-normal"
        title="Detach — the next session lands here as soon as a runner starts one"
        @click="newSession"
      >
        <SquarePen :size="15" class="text-muted-foreground" />
        New session
      </Button>
      <RouterLink
        to="/runners"
        class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Server :size="15" />
        Runners
      </RouterLink>
    </nav>

    <div class="px-3 pt-4 pb-2">
      <div class="relative">
        <Search
          aria-hidden="true"
          class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="query"
          class="h-8 rounded-lg pl-8 text-xs"
          placeholder="Search sessions"
          type="search"
        />
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <p class="px-2.5 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">Sessions</p>
      <ul v-if="filtered.length > 0" class="grid content-start gap-0.5">
        <li v-for="s in filtered" :key="s.sessionId">
          <Button
            variant="ghost"
            class="h-auto w-full justify-between gap-2 rounded-lg px-2.5 py-2 font-normal"
            :class="
              s.sessionId === sessions.activeId &&
              'bg-sidebar-accent shadow-[inset_2px_0_0_var(--primary)]'
            "
            @click="openSession(s.sessionId)"
          >
            <span class="min-w-0 flex-1 truncate text-left font-mono text-xs">
              {{ s.sessionId }}
            </span>
            <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              {{ relativeTime(s.lastIngestedAt, now) }}
              <span
                v-if="s.live"
                class="size-[7px] animate-pulse rounded-full bg-primary"
                title="A run is in flight"
              />
            </span>
          </Button>
        </li>
      </ul>
      <p
        v-else-if="sessions.loaded && sessions.sessions.length > 0"
        class="px-2.5 py-2 text-xs text-muted-foreground"
      >
        No sessions match.
      </p>
      <p
        v-else-if="sessions.loaded"
        class="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
      >
        No sessions yet. Enroll a runner and dispatch a run — they land here as they start.
      </p>
      <p v-else class="px-2.5 py-2 text-xs text-muted-foreground">Reading the journal…</p>
    </div>

    <footer class="border-t border-sidebar-border px-3 py-2.5">
      <ConnectionChip class="mb-2" />
      <div class="flex items-center gap-2.5">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary uppercase"
        >
          o
        </span>
        <span class="flex-1 truncate text-[13px]">owner</span>
        <button
          type="button"
          aria-label="Sign out"
          class="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive"
          @click="signOut"
        >
          <LogOut :size="14" />
        </button>
      </div>
    </footer>
  </aside>
</template>
