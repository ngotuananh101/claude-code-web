<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateSetupForm } from "@/features/setup/setup-logic.ts";
import { submitSetup } from "@/services/auth-api.ts";
import { connectSocket } from "@/stores/sessions.ts";

const router = useRouter();
const username = ref("");
const password = ref("");
const confirmPassword = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  const validation = validateSetupForm({
    username: username.value,
    password: password.value,
    confirmPassword: confirmPassword.value,
  });
  if (!validation.valid) {
    toast.error(validation.error);
    return;
  }
  busy.value = true;
  try {
    const result = await submitSetup({
      username: username.value.trim(),
      password: password.value,
    });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    connectSocket();
    toast.success("Khởi tạo tài khoản thành công.");
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
        Thiết lập hệ thống
      </h1>
      <p class="mb-5 text-center text-sm leading-normal text-muted-foreground">
        Khởi tạo tài khoản quản trị đầu tiên cho hệ thống cc-web.
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
          autocomplete="new-password"
          placeholder="Mật khẩu (ít nhất 6 ký tự)"
        />
        <Label class="sr-only" for="confirm-password">Xác nhận mật khẩu</Label>
        <Input
          id="confirm-password"
          v-model="confirmPassword"
          type="password"
          autocomplete="new-password"
          placeholder="Xác nhận mật khẩu"
        />
        <Button
          type="submit"
          :disabled="busy || username === '' || password === '' || confirmPassword === ''"
        >
          Khởi tạo tài khoản
        </Button>
      </form>
    </section>
  </main>
</template>
