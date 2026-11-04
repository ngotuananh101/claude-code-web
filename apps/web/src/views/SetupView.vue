<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateSetupForm } from "@/features/setup/setup-logic.ts";
import { useI18n } from "@/lib/i18n";
import { submitSetup } from "@/services/auth-api.ts";
import { connectSocket } from "@/stores/sessions.ts";

const router = useRouter();
const { t } = useI18n();
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
    toast.success(t("auth.accountCreated"));
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
        {{ t("auth.setupTitle") }}
      </h1>
      <p class="mb-5 text-center text-sm leading-normal text-muted-foreground">
        {{ t("auth.setupSubtitle") }}
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
          autocomplete="new-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="next"
          class="max-sm:h-11"
          :placeholder="t('auth.passwordMinLength')"
        />
        <Label class="sr-only" for="confirm-password">{{ t("auth.confirmPassword") }}</Label>
        <Input
          id="confirm-password"
          v-model="confirmPassword"
          type="password"
          autocomplete="new-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="go"
          class="max-sm:h-11"
          :placeholder="t('auth.confirmPassword')"
        />
        <Button
          type="submit"
          class="max-sm:h-11"
          :disabled="busy || username === '' || password === '' || confirmPassword === ''"
        >
          {{ t("auth.createAccount") }}
        </Button>
      </form>
    </section>
  </main>
</template>
