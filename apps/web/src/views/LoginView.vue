<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const router = useRouter();
const username = ref("");
const password = ref("");
const failed = ref(false);
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  failed.value = false;
  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    if (!response.ok) {
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
    <div class="login-body">
      <p class="wordmark font-mono">cc-web</p>
      <h1>Watch your coding agents work.</h1>
      <p class="lede">
        Sign in to follow sessions live from the journal — every event, in
        order, exactly as the runners wrote it.
      </p>
      <form class="login-form" @submit.prevent="submit">
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
          That username and password don't match.
        </p>
        <Button type="submit" :disabled="busy || username === '' || password === ''">
          Sign in
        </Button>
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

.login-body {
  width: min(340px, calc(100vw - 48px));
  padding-top: 28px;
  border-top: 2px solid var(--foreground);
}

.wordmark {
  font-size: 13px;
  color: var(--primary);
  margin: 0 0 18px;
}

h1 {
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0 0 8px;
}

.lede {
  color: var(--muted-foreground);
  font-size: 14px;
  margin: 0 0 28px;
}

.login-form {
  display: grid;
  gap: 16px;
}

.field {
  display: grid;
  gap: 6px;
}

.field-label {
  color: var(--muted-foreground);
  font-size: 13px;
}

.error {
  color: var(--destructive);
  font-size: 13px;
  margin: 0;
}
</style>
