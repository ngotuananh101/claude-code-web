<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const router = useRouter();
const username = ref("");
const password = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    if (!response.ok) {
      // The server answers every credential failure identically (no username
      // oracle); the toast carries that one message.
      toast.error("Sai tên đăng nhập hoặc mật khẩu.");
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
