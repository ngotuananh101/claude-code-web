<script setup lang="ts">
import { Copy, Loader2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import {
  downscaleAvatarImage,
  validatePasswordChange,
  validateUsername,
} from "@/components/profiles/user-profile-helpers.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getBrowserNotificationEnabled,
  setBrowserNotificationEnabled,
} from "@/features/notifications/notification-events.ts";
import { useI18n } from "@/lib/i18n/index.ts";
import {
  createTelegramLink,
  getTelegramStatus,
  sendTelegramTest,
  setTelegramEnabled,
  type TelegramStatus,
  unlinkTelegram,
} from "@/services/notifications-api.ts";
import { type UpdateMePayloadInternal, updateUserProfile } from "@/services/user-api.ts";
import { sessions } from "@/stores/sessions.ts";

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "closed"): void;
}>();

const fileInput = ref<HTMLInputElement | null>(null);

// Form state
const username = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");

// Avatar state
const stagedAvatar = ref<string | null>(null);
const avatarRemoved = ref(false);
/** The image URL to show, or null when there is no avatar at all. */
const avatarUrl = computed(() => {
  if (avatarRemoved.value) return null;
  return stagedAvatar.value ?? sessions.avatar ?? null;
});
/** The letter shown when there is no avatar image — never used as an image URL. */
const avatarInitial = computed(() =>
  sessions.account ? sessions.account.charAt(0).toUpperCase() : "",
);

// Loading state
const isSaving = ref(false);
const avatarLoading = ref(false);

// Notifications state (N1)
const telegramStatus = ref<TelegramStatus | null>(null);
const telegramCode = ref<string | null>(null);
const telegramBusy = ref(false);
const browserEnabled = ref(true);
const browserPermission = ref("unsupported");
const browserStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};
const browserPermissionText = computed(() => {
  if (browserPermission.value === "granted") return t("user.browserPermissionGranted");
  if (browserPermission.value === "denied") return t("user.browserPermissionDenied");
  if (browserPermission.value === "unsupported") return t("user.browserPermissionUnsupported");
  return t("user.browserPermissionPrompt");
});
const telegramStatusText = computed(() => {
  if (telegramStatus.value === null) return t("user.telegramStatusError");
  if (!telegramStatus.value.configured) return t("user.telegramStatusUnconfigured");
  if (!telegramStatus.value.linked) return t("user.telegramStatusUnlinked");
  return telegramStatus.value.enabled
    ? t("user.telegramStatusLinkedEnabled")
    : t("user.telegramStatusLinkedDisabled");
});

async function loadNotifications(): Promise<void> {
  browserEnabled.value = getBrowserNotificationEnabled(browserStorage);
  browserPermission.value =
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  telegramStatus.value = await getTelegramStatus();
}

async function toggleBrowser(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  if (checked && typeof Notification !== "undefined" && Notification.permission !== "granted") {
    browserPermission.value = await Notification.requestPermission();
    if (browserPermission.value !== "granted") {
      browserEnabled.value = false;
      toast.error(t("user.browserPermissionDeniedToast"));
      return;
    }
  }
  browserEnabled.value = checked;
  setBrowserNotificationEnabled(browserStorage, checked);
}

async function createLink(): Promise<void> {
  telegramBusy.value = true;
  try {
    const result = await createTelegramLink();
    if (result === null) {
      toast.error(t("user.telegramCreateCodeFailed"));
      return;
    }
    telegramCode.value = result.code;
  } finally {
    telegramBusy.value = false;
  }
}

async function copyCode(): Promise<void> {
  if (telegramCode.value === null) return;
  try {
    await navigator.clipboard.writeText(`/start ${telegramCode.value}`);
    toast.success(t("user.telegramCopied"));
  } catch {
    toast.error(t("user.telegramCopyFailed"));
  }
}

async function testTelegram(): Promise<void> {
  telegramBusy.value = true;
  try {
    if (await sendTelegramTest()) toast.success(t("user.telegramTestSuccess"));
    else toast.error(t("user.telegramTestFailed"));
  } finally {
    telegramBusy.value = false;
  }
}

async function unlink(): Promise<void> {
  telegramBusy.value = true;
  try {
    if (await unlinkTelegram()) {
      telegramCode.value = null;
      telegramStatus.value = await getTelegramStatus();
      toast.success(t("user.telegramUnlinkSuccess"));
    } else {
      toast.error(t("user.telegramUnlinkFailed"));
    }
  } finally {
    telegramBusy.value = false;
  }
}

async function toggleTelegramEnabled(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  if (await setTelegramEnabled(checked)) {
    telegramStatus.value = await getTelegramStatus();
  } else {
    toast.error(t("user.telegramToggleFailed"));
  }
}

// Reset form when dialog opens
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      username.value = sessions.account ?? "";
      currentPassword.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
      stagedAvatar.value = null;
      avatarRemoved.value = false;
      telegramCode.value = null;
      void loadNotifications();
    }
  },
);

// Handle file selection for avatar
const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  // Validate file type
  if (!file.type.startsWith("image/")) {
    toast.error(t("user.avatarInvalidType"));
    return;
  }

  avatarLoading.value = true;
  try {
    const dataUrl = await downscaleAvatarImage(file, 256);
    stagedAvatar.value = dataUrl;
    avatarRemoved.value = false;
    toast.success(t("user.avatarLoaded"));
  } catch {
    toast.error(t("user.avatarLoadError"));
  } finally {
    avatarLoading.value = false;
    // Reset the input so the same file can be selected again
    if (fileInput.value) {
      fileInput.value.value = "";
    }
  }
};

// Remove the avatar: clearing only the staged value used to fall back
// to the saved server avatar, so "remove" appeared to do nothing. The
// flag makes the preview show the initial letter, and saveProfile sends
// an empty string, which the server treats as "clear avatar".
const removeAvatar = () => {
  stagedAvatar.value = null;
  avatarRemoved.value = true;
};

// Open file picker
const openFilePicker = () => {
  fileInput.value?.click();
};

// Validate and save profile
const saveProfile = async () => {
  // Validate username
  const usernameResult = validateUsername(username.value);
  if (!usernameResult.valid) {
    const errorMsg = usernameResult.errorKey
      ? t(usernameResult.errorKey)
      : usernameResult.error || t("user.usernameInvalid");
    toast.error(errorMsg);
    return;
  }

  // Validate password change
  const passwordResult = validatePasswordChange(
    currentPassword.value,
    newPassword.value,
    confirmPassword.value,
  );
  if (!passwordResult.valid) {
    const errorMsg = passwordResult.errorKey
      ? t(passwordResult.errorKey)
      : passwordResult.error || t("user.passwordInvalid");
    toast.error(errorMsg);
    return;
  }

  isSaving.value = true;

  try {
    const payload: UpdateMePayloadInternal = {
      username: username.value.trim() || undefined,
      avatar: avatarRemoved.value ? "" : (stagedAvatar.value ?? undefined),
      currentPassword: currentPassword.value.trim() || undefined,
      newPassword: newPassword.value.trim() || undefined,
    };

    const result = await updateUserProfile(payload);

    if (result.ok) {
      toast.success(t("user.saveSuccess"));
      emit("update:open", false);
      emit("closed");
    } else {
      toast.error(result.error);
    }
  } catch {
    toast.error(t("user.saveError"));
  } finally {
    isSaving.value = false;
  }
};

// Close dialog
const onClose = () => {
  emit("update:open", false);
  emit("closed");
};
</script>

<template>
  <Dialog :open="open" @update:open="onClose">
    <DialogContent
      class="flex max-h-[90dvh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl md:max-w-3xl lg:max-w-4xl"
    >
      <!-- Dialog Header: Fixed at top -->
      <DialogHeader class="shrink-0 border-b border-border/60 px-6 py-4 pr-12 text-left">
        <DialogTitle class="text-base font-semibold">{{ t("user.dialogTitle") }}</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          {{ t("user.dialogDescription") }}
        </DialogDescription>
      </DialogHeader>

      <!-- Scrollable Body: 2 columns on desktop/tablet, 1 stacked column on mobile -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
        <div class="grid grid-cols-1 gap-6 items-start md:grid-cols-2">
          <!-- COLUMN 1: Account Information & Security -->
          <div class="flex flex-col gap-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t("user.accountSection") }}
            </h4>

            <!-- Circular Avatar & Actions -->
            <div class="flex items-center gap-4 rounded-xl border border-border/60 bg-muted/20 p-3.5">
              <div
                class="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-border bg-muted"
              >
                <div class="absolute inset-0 overflow-hidden rounded-full">
                  <div
                    v-if="avatarUrl"
                    class="h-full w-full bg-cover bg-center"
                    :style="{ backgroundImage: `url(${avatarUrl})` }"
                  />
                  <div
                    v-else
                    class="flex h-full w-full items-center justify-center text-2xl font-medium text-foreground/50"
                  >
                    {{ avatarInitial }}
                  </div>
                </div>
              </div>

              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" @click="openFilePicker">
                    {{ t("user.uploadBtn") }}
                  </Button>
                  <input
                    ref="fileInput"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    class="hidden"
                    @change="handleFileSelect"
                  />
                  <Button
                    v-if="avatarUrl"
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    @click="removeAvatar"
                  >
                    {{ t("user.removeBtn") }}
                  </Button>
                </div>
                <p class="text-[11px] leading-tight text-muted-foreground">
                  {{ t("user.avatarHint") }}
                </p>
              </div>
            </div>

            <!-- Username Input -->
            <div class="flex flex-col gap-1.5">
              <Label for="username" class="text-xs font-medium">{{ t("user.usernameLabel") }}</Label>
              <Input
                id="username"
                v-model="username"
                :placeholder="t('user.usernamePlaceholder')"
                :class="username.trim() && !validateUsername(username.trim()).valid ? 'aria-invalid' : ''"
              />
            </div>

            <!-- Password Change Card -->
            <div class="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
              <h5 class="text-xs font-semibold text-foreground">{{ t("user.passwordSection") }}</h5>
              <div class="flex flex-col gap-2.5">
                <div class="flex flex-col gap-1">
                  <Label for="currentPassword" class="text-xs text-muted-foreground">
                    {{ t("user.currentPasswordLabel") }}
                  </Label>
                  <Input
                    id="currentPassword"
                    v-model="currentPassword"
                    type="password"
                    :placeholder="t('user.currentPasswordPlaceholder')"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="newPassword" class="text-xs text-muted-foreground">
                    {{ t("user.newPasswordLabel") }}
                  </Label>
                  <Input
                    id="newPassword"
                    v-model="newPassword"
                    type="password"
                    :placeholder="t('user.newPasswordPlaceholder')"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="confirmPassword" class="text-xs text-muted-foreground">
                    {{ t("user.confirmPasswordLabel") }}
                  </Label>
                  <Input
                    id="confirmPassword"
                    v-model="confirmPassword"
                    type="password"
                    :placeholder="t('user.confirmPasswordPlaceholder')"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- COLUMN 2: Notification Preferences -->
          <div class="flex flex-col gap-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t("user.notificationsSection") }}
            </h4>

            <!-- Browser Notifications Card -->
            <div class="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/20 p-3.5">
              <div class="flex items-start gap-2.5">
                <input
                  id="browser-notification-toggle"
                  type="checkbox"
                  :checked="browserEnabled"
                  class="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-primary"
                  @change="toggleBrowser"
                />
                <label
                  for="browser-notification-toggle"
                  class="cursor-pointer text-xs font-medium leading-snug"
                >
                  {{ t("user.browserNotificationsHelp") }}
                </label>
              </div>
              <div class="flex items-center gap-1.5 pl-6 text-[11px] text-muted-foreground">
                <span>{{ t("user.browserStatusLabel") }}</span>
                <span
                  class="font-medium"
                  :class="{
                    'text-emerald-600 dark:text-emerald-400': browserPermission === 'granted',
                    'text-destructive': browserPermission === 'denied',
                  }"
                >
                  {{ browserPermissionText }}
                </span>
              </div>
            </div>

            <!-- Telegram Notifications Card -->
            <div class="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold">{{ t("user.telegramSection") }}</span>
                <span
                  class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="{
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400':
                      telegramStatus?.linked && telegramStatus?.enabled,
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400':
                      telegramStatus?.linked && !telegramStatus?.enabled,
                    'bg-muted text-muted-foreground': !telegramStatus?.linked,
                  }"
                >
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    :class="{
                      'bg-emerald-500': telegramStatus?.linked && telegramStatus?.enabled,
                      'bg-amber-500': telegramStatus?.linked && !telegramStatus?.enabled,
                      'bg-muted-foreground/60': !telegramStatus?.linked,
                    }"
                  />
                  {{ telegramStatusText }}
                </span>
              </div>

              <!-- Telegram Toggle when linked -->
              <div v-if="telegramStatus?.linked" class="flex items-center gap-2.5">
                <input
                  id="telegram-toggle"
                  type="checkbox"
                  :checked="telegramStatus.enabled"
                  class="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                  @change="toggleTelegramEnabled"
                />
                <label for="telegram-toggle" class="cursor-pointer text-xs font-medium">
                  {{ t("user.telegramNotificationsCheckbox") }}
                </label>
              </div>

              <!-- Telegram Action Buttons -->
              <div v-if="telegramStatus" class="flex flex-wrap gap-2">
                <Button
                  v-if="!telegramStatus.linked && telegramStatus.configured"
                  type="button"
                  variant="outline"
                  size="sm"
                  :disabled="telegramBusy"
                  @click="createLink"
                >
                  <Loader2 v-if="telegramBusy" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {{ t("user.telegramCreateLink") }}
                </Button>
                <Button
                  v-if="telegramStatus.linked"
                  type="button"
                  variant="outline"
                  size="sm"
                  :disabled="telegramBusy"
                  @click="testTelegram"
                >
                  <Loader2 v-if="telegramBusy" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {{ t("user.telegramTest") }}
                </Button>
                <Button
                  v-if="telegramStatus.linked"
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  :disabled="telegramBusy"
                  @click="unlink"
                >
                  <Loader2 v-if="telegramBusy" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {{ t("user.telegramUnlink") }}
                </Button>
              </div>

              <!-- Not Configured Notice -->
              <p
                v-if="telegramStatus && !telegramStatus.configured"
                class="text-[11px] leading-relaxed text-muted-foreground"
              >
                {{ t("user.telegramUnconfiguredHelp") }}
              </p>

              <!-- One-time code card -->
              <div
                v-if="telegramCode"
                class="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs"
              >
                <p class="text-[11px] text-muted-foreground">
                  {{ t("user.telegramCodeInstructions") }}
                </p>
                <div
                  class="flex items-center justify-between gap-2 rounded bg-background/80 px-2.5 py-1.5 font-mono text-xs"
                >
                  <code class="break-all text-primary">/start {{ telegramCode }}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-7 shrink-0 px-2.5 text-xs"
                    @click="copyCode"
                  >
                    <Copy class="mr-1.5 h-3 w-3" />
                    {{ t("user.telegramCopyCode") }}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Dialog Footer: Fixed at bottom -->
      <DialogFooter
        class="flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border/60 bg-muted/10 px-6 py-3.5"
      >
        <Button variant="outline" size="sm" @click="onClose">
          {{ t("user.cancelBtn") }}
        </Button>
        <Button size="sm" :disabled="isSaving" @click="saveProfile">
          <Loader2 v-if="isSaving" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          {{ isSaving ? t("user.savingBtn") : t("user.saveBtn") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
