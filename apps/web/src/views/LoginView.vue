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
  <main class="relative grid min-h-full place-items-center p-4">
    <p class="absolute top-4 left-4.5 font-mono text-sm text-foreground">
      cc-web
    </p>
    <section class="w-full max-w-[360px]">
      <h1
        class="mb-1.5 text-center text-[28px] font-medium leading-tight tracking-tight"
      >
        Đăng nhập
      </h1>
      <p class="mb-5 text-center text-sm leading-normal text-muted-foreground">
        Theo dõi phiên làm việc của coding agent, trực tiếp từ journal.
      </p>
      <form class="grid gap-2" @submit.prevent="submit">
        <Label class="sr-only" for="username">Tên đăng nhập</Label>
        <Input
          id="username"
          v-model="username"
          autocomplete="username"
          autofocus
          placeholder="Tên đăng nhập"
        />
        <Label class="sr-only" for="password">Mật khẩu</Label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="Mật khẩu"
        />
        <p v-if="failed" class="mt-0.5 text-center text-sm text-destructive" role="alert">
          Sai tên đăng nhập hoặc mật khẩu.
        </p>
        <Button
          type="submit"
          :disabled="busy || username === '' || password === ''"
        >
          Tiếp tục
        </Button>
      </form>
    </section>
  </main>
</template>
