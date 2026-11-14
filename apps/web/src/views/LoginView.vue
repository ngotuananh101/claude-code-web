<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { connectSocket } from "@/stores/sessions.ts";

const router = useRouter();
const { t } = useI18n();
const username = ref("");
const password = ref("");
const rememberMe = ref(false);
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        rememberMe: rememberMe.value,
      }),
    });
    if (!response.ok) {
      // The server answers every credential failure identically (no username
      // oracle); the toast carries that one message.
      toast.error(t("auth.invalidCredentials"));
      return;
    }
    connectSocket();
    await router.push("/");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="relative grid min-h-full place-items-center overflow-y-auto p-4 py-16">
    <p class="absolute top-4 left-4.5 font-mono text-sm text-foreground">
      cc-web
    </p>
    <section class="w-full max-w-[360px]">
      <h1
        class="mb-1.5 text-center text-[28px] font-medium leading-tight tracking-tight"
      >
        {{ t("auth.signIn") }}
      </h1>
      <p class="mb-5 text-center text-sm leading-normal text-muted-foreground">
        {{ t("auth.tagline") }}
      </p>
      <form class="grid gap-2" @submit.prevent="submit">
        <Label class="sr-only" for="username">{{ t("auth.username") }}</Label>
        <Input
          id="username"
          v-model="username"
          autocomplete="username"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="next"
          autofocus
          class="max-sm:h-11"
          :placeholder="t('auth.username')"
        />
        <Label class="sr-only" for="password">{{ t("auth.password") }}</Label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="go"
          class="max-sm:h-11"
          :placeholder="t('auth.password')"
        />
        <label
          for="remember-me"
          class="my-0.5 flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground"
        >
          <input
            id="remember-me"
            v-model="rememberMe"
            type="checkbox"
            class="h-4 w-4 cursor-pointer rounded border-border accent-primary"
          />
          <span>{{ t("auth.rememberMe") }}</span>
        </label>
        <Button
          type="submit"
          class="max-sm:h-11"
          :disabled="busy || username === '' || password === ''"
        >
          {{ t("auth.continue") }}
        </Button>
      </form>
    </section>
  </main>
</template>
