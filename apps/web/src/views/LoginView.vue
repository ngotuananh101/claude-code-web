<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "../lib/auth-client.ts";

const router = useRouter();
const username = ref("");
const password = ref("");
const failed = ref(false);
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  failed.value = false;
  try {
    const { error } = await authClient.signIn.username({
      username: username.value,
      password: password.value,
    });
    if (error !== null) {
      // One message for every failure: whether the username exists is not
      // something the form will leak.
      failed.value = true;
      return;
    }
    await router.push("/");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login">
    <div class="entry">
      <p class="wordmark font-mono">cc-web</p>
      <h1>Watch your coding agents work.</h1>
      <p class="lede">
        Sign in to follow sessions live from the journal — every event, in
        order, exactly as the runners wrote it.
      </p>
      <form class="event" @submit.prevent="submit">
        <span class="seq font-mono" aria-hidden="true">0001</span>
        <div class="event-body">
          <div class="field">
            <Label class="field-label" for="username">Username</Label>
            <Input id="username" v-model="username" autocomplete="username" autofocus />
          </div>
          <div class="field">
            <Label class="field-label" for="password">Password</Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
            />
          </div>
          <p v-if="failed" class="error" role="alert">
            Sai tên đăng nhập hoặc mật khẩu.
          </p>
          <Button
            type="submit"
            class="submit"
            :disabled="busy || username === '' || password === ''"
          >
            Sign in
          </Button>
        </div>
      </form>
    </div>
  </main>
</template>

<style scoped>
.login {
  min-height: 100%;
  display: grid;
  place-items: center;
}

.entry {
  width: min(420px, calc(100vw - 48px));
}

/* The journal's run divider: mono wordmark, hairline running out. */
.wordmark {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
  color: var(--primary);
  margin: 0 0 26px;
}

.wordmark::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

h1 {
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0 0 8px;
}

.lede {
  color: var(--muted-foreground);
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 30px;
}

/* The form is the first event: sequence gutter, then the payload. */
.event {
  display: grid;
  grid-template-columns: 48px 1fr;
  column-gap: 14px;
}

.seq {
  text-align: right;
  line-height: 14px;
  color: var(--muted-foreground);
  font-size: 12px;
  user-select: all;
}

.event-body {
  display: grid;
  gap: 16px;
}

/* Grid would stretch the button across the payload column; the journal's
   actions sit where the text ends. */
.submit {
  justify-self: start;
}

.field {
  display: grid;
  gap: 6px;
}

.field-label {
  color: var(--muted-foreground);
  font-size: 13px;
}

/* Auth failure wears the journal's repair-row language. */
.error {
  margin: 0;
  padding: 8px 12px;
  border-left: 2px solid var(--destructive);
  color: var(--destructive);
  font-size: 13px;
}

@media (max-width: 379px) {
  .event {
    grid-template-columns: 1fr;
    row-gap: 8px;
  }

  .seq {
    text-align: left;
    padding-top: 0;
  }
}
</style>
