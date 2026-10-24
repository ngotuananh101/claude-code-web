<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";

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
      <p class="wordmark">cc-web</p>
      <h1>Watch your coding agents work.</h1>
      <p class="lede">
        Sign in to follow sessions live from the journal — every event, in
        order, exactly as the runners wrote it.
      </p>
      <form @submit.prevent="submit">
        <label>
          <span>Username</span>
          <input v-model="username" autocomplete="username" autofocus />
        </label>
        <label>
          <span>Password</span>
          <input v-model="password" type="password" autocomplete="current-password" />
        </label>
        <p v-if="failed" class="error" role="alert">
          That username and password don't match.
        </p>
        <button type="submit" :disabled="busy || username === '' || password === ''">
          Sign in
        </button>
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
  border-top: 2px solid var(--ink);
}

.wordmark {
  font-family: var(--machine);
  font-size: 13px;
  color: var(--pine);
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
  color: var(--mute);
  font-size: 14px;
  margin: 0 0 28px;
}

form {
  display: grid;
  gap: 16px;
}

label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

label span {
  color: var(--mute);
}

input {
  font: inherit;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 9px 12px;
  outline: none;
}

input:focus {
  border-color: var(--pine);
  box-shadow: 0 0 0 3px var(--pine-wash);
}

.error {
  color: var(--amber);
  font-size: 13px;
  margin: 0;
}

button {
  font: inherit;
  font-weight: 500;
  color: #fff;
  background: var(--pine);
  border: none;
  border-radius: 6px;
  padding: 10px 14px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
