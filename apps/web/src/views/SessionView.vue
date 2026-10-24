<script setup lang="ts">
import { LogOut } from "@lucide/vue";
import { computed, onMounted, onUnmounted } from "vue";
import { RouterLink, useRouter } from "vue-router";
import Composer from "../components/Composer.vue";
import ConnectionChip from "../components/ConnectionChip.vue";
import EventJournal from "../components/EventJournal.vue";
import SessionRail from "../components/SessionRail.vue";
import { loadSessions, openSession, resolveSessionLive, sessions } from "../stores/sessions.ts";

const router = useRouter();
const active = computed(() => sessions.sessions.find((s) => s.sessionId === sessions.activeId));

const activeLive = computed(() => resolveSessionLive(active.value?.live, sessions.stream?.live));

let refresh: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  // Reopen the held session after a reload; otherwise take the most recent.
  if (sessions.activeId === null && sessions.sessions.length > 0) {
    openSession(sessions.sessions[0]!.sessionId);
  }
  refresh = setInterval(() => void loadSessions(), 15_000);
});
onUnmounted(() => clearInterval(refresh));

async function signOut(): Promise<void> {
  // The server bumps the token version (killing every outstanding token) and
  // revokes the owner's live socket (§19.1); the journal then reconnects
  // into the login page.
  await fetch("/auth/logout", { method: "POST" });
  await router.push("/login");
}
</script>

<template>
  <div class="frame">
    <SessionRail />
    <section class="stage">
      <header v-if="active" class="stage-head">
        <span class="session-id font-mono">{{ active.sessionId }}</span>
        <span class="head-meta">
          <span class="font-mono">{{ active.watermark }}</span>
          <span v-if="activeLive" class="live-flag"><i class="live-dot" /> live</span>
        </span>
      </header>
      <header v-else class="stage-head">
        <span class="head-meta">No session selected.</span>
      </header>

      <EventJournal
        v-if="sessions.stream !== null"
        :events="sessions.stream.events"
        :needs-resync="sessions.stream.needsResync"
        :session-live="activeLive"
      />
      <div v-else class="stage-empty">
        <p>Select a session from the rail, or wait for one to start.</p>
      </div>

      <Composer />
    </section>
  </div>
  <div class="foot">
    <ConnectionChip />
    <div class="foot-actions">
      <RouterLink class="foot-link font-mono" to="/runners">runners</RouterLink>
      <button class="foot-btn" type="button" aria-label="Sign out" @click="signOut">
        <LogOut :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.frame {
  display: grid;
  grid-template-columns: 264px 1fr;
  height: 100vh;
}

.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--border);
}

.stage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 28px 14px;
  border-bottom: 1px solid var(--border);
}

.session-id {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-meta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  color: var(--muted-foreground);
  font-size: 12px;
  flex-shrink: 0;
}

.live-flag {
  color: var(--primary);
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  display: inline-block;
  align-self: center;
  animation: livepulse 2.4s ease-in-out infinite;
}

@keyframes livepulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.stage-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted-foreground);
}

/* The chip row: connection state on the left, runners link and sign-out on
   the same hairline. */
.foot {
  position: relative;
}

.foot-actions {
  position: absolute;
  right: 20px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.foot-link {
  color: var(--muted-foreground);
  font-size: 12px;
  text-decoration: none;
}

.foot-link:hover {
  color: var(--primary);
}

.foot-btn {
  display: grid;
  place-items: center;
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

.foot-btn:hover {
  color: var(--destructive);
}
</style>
