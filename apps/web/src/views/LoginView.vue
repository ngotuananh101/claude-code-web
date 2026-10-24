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
    <p class="brand font-mono">cc-web</p>
    <section class="panel">
      <h1>Đăng nhập</h1>
      <p class="lede">
        Theo dõi phiên làm việc của coding agent, trực tiếp từ journal.
      </p>
      <form class="panel-form" @submit.prevent="submit">
        <Label class="sr-only" for="username">Tên đăng nhập</Label>
        <Input
          id="username"
          v-model="username"
          class="field"
          autocomplete="username"
          autofocus
          placeholder="Tên đăng nhập"
        />
        <Label class="sr-only" for="password">Mật khẩu</Label>
        <Input
          id="password"
          v-model="password"
          class="field"
          type="password"
          autocomplete="current-password"
          placeholder="Mật khẩu"
        />
        <p v-if="failed" class="error" role="alert">
          Sai tên đăng nhập hoặc mật khẩu.
        </p>
        <Button
          type="submit"
          class="submit"
          :disabled="busy || username === '' || password === ''"
        >
          Tiếp tục
        </Button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login {
  min-height: 100%;
  display: grid;
  place-items: center;
  position: relative;
  padding: 24px;
}

.brand {
  position: absolute;
  top: 22px;
  left: 26px;
  margin: 0;
  font-size: 13px;
  color: var(--foreground);
}

.panel {
  width: min(360px, 100%);
}

h1 {
  margin: 0 0 8px;
  text-align: center;
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.lede {
  margin: 0 0 30px;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 14px;
  line-height: 1.5;
}

.panel-form {
  display: grid;
  gap: 10px;
}

.field {
  height: 40px;
}

.error {
  margin: 2px 0 0;
  text-align: center;
  color: var(--destructive);
  font-size: 13px;
}

.submit {
  height: 40px;
  margin-top: 6px;
}
</style>
