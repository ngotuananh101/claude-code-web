<script setup lang="ts">
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
  if (browserPermission.value === "granted") return "Đã cho phép";
  if (browserPermission.value === "denied") return "Đã bị từ chối (đổi trong cài đặt trình duyệt)";
  if (browserPermission.value === "unsupported") return "Trình duyệt không hỗ trợ";
  return "Chưa xin phép";
});
const telegramStatusText = computed(() => {
  if (telegramStatus.value === null) return "Không tải được trạng thái";
  if (!telegramStatus.value.configured) return "Chưa cấu hình bot trên máy chủ";
  if (!telegramStatus.value.linked) return "Chưa liên kết";
  return telegramStatus.value.enabled ? "Đã liên kết, đang bật" : "Đã liên kết, đang tắt";
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
      toast.error("Trình duyệt chưa cho phép thông báo.");
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
      toast.error("Không tạo được mã liên kết. Kiểm tra bot đã cấu hình chưa.");
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
    toast.success("Đã sao chép lệnh liên kết.");
  } catch {
    toast.error("Không sao chép được, hãy gõ tay mã trên.");
  }
}

async function testTelegram(): Promise<void> {
  telegramBusy.value = true;
  try {
    if (await sendTelegramTest()) toast.success("Đã gửi tin thử qua Telegram.");
    else toast.error("Gửi tin thử thất bại. Kiểm tra liên kết Telegram.");
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
      toast.success("Đã hủy liên kết Telegram.");
    } else {
      toast.error("Hủy liên kết thất bại.");
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
    toast.error("Đổi cài đặt Telegram thất bại.");
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
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("user.dialogTitle") }}</DialogTitle>
        <DialogDescription>{{ t("user.dialogDescription") }}</DialogDescription>
      </DialogHeader>

      <!-- Avatar Section -->
      <div class="flex flex-col gap-4">
        <div class="flex flex-col items-center gap-3">
          <!-- Circular Avatar Preview -->
          <div
            class="relative flex items-center justify-center rounded-full bg-muted overflow-hidden"
            :class="`w-16 h-16 sm:w-18 sm:h-18 border-2 border-border`"
          >
            <!-- Circular mask using CSS -->
            <div class="absolute inset-0 rounded-full overflow-hidden">
              <div
                v-if="avatarUrl"
                class="w-full h-full bg-cover bg-center"
                :style="{ backgroundImage: `url(${avatarUrl})` }"
              />
              <div
                v-else
                class="w-full h-full flex items-center justify-center text-2xl font-medium text-foreground/50"
              >
                {{ avatarInitial }}
              </div>
            </div>
          </div>

          <!-- Avatar Actions -->
          <div class="flex gap-2">
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
              @click="removeAvatar"
            >
              {{ t("user.removeBtn") }}
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("user.avatarHint") }}</p>
        </div>

        <!-- Username Input -->
        <div class="flex flex-col gap-2">
          <Label for="username">{{ t("user.usernameLabel") }}</Label>
          <Input
            id="username"
            v-model="username"
            :placeholder="t('user.usernamePlaceholder')"
            :class="username.trim() && !validateUsername(username.trim()).valid ? 'aria-invalid' : ''"
          />
        </div>

        <!-- Password Change Section -->
        <div class="flex flex-col gap-3 border-t pt-4">
          <h4 class="text-sm font-medium">{{ t("user.passwordSection") }}</h4>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-2">
              <Label for="currentPassword">{{ t("user.currentPasswordLabel") }}</Label>
              <Input
                id="currentPassword"
                v-model="currentPassword"
                type="password"
                :placeholder="t('user.currentPasswordPlaceholder')"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="newPassword">{{ t("user.newPasswordLabel") }}</Label>
              <Input
                id="newPassword"
                v-model="newPassword"
                type="password"
                :placeholder="t('user.newPasswordPlaceholder')"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="confirmPassword">{{ t("user.confirmPasswordLabel") }}</Label>
              <Input
                id="confirmPassword"
                v-model="confirmPassword"
                type="password"
                :placeholder="t('user.confirmPasswordPlaceholder')"
              />
            </div>
          </div>
        </div>
        <!-- Notifications Section (N1) -->
        <div class="flex flex-col gap-3 border-t pt-4">
          <h4 class="text-sm font-medium">Thông báo</h4>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" :checked="browserEnabled" @change="toggleBrowser" />
            Thông báo trình duyệt khi cần phê duyệt hoặc run kết thúc
          </label>
          <p class="text-xs text-muted-foreground">Trình duyệt: {{ browserPermissionText }}</p>
          <div v-if="telegramStatus" class="flex flex-col gap-2">
            <p class="text-sm">Telegram: {{ telegramStatusText }}</p>
            <label v-if="telegramStatus.linked" class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                :checked="telegramStatus.enabled"
                @change="toggleTelegramEnabled"
              />
              Nhận thông báo qua Telegram
            </label>
            <div class="flex flex-wrap gap-2">
              <Button
                v-if="!telegramStatus.linked && telegramStatus.configured"
                type="button"
                variant="outline"
                size="sm"
                :disabled="telegramBusy"
                @click="createLink"
              >
                Tạo mã liên kết Telegram
              </Button>
              <Button
                v-if="telegramStatus.linked"
                type="button"
                variant="outline"
                size="sm"
                :disabled="telegramBusy"
                @click="testTelegram"
              >
                Gửi tin thử
              </Button>
              <Button
                v-if="telegramStatus.linked"
                type="button"
                variant="ghost"
                size="sm"
                :disabled="telegramBusy"
                @click="unlink"
              >
                Hủy liên kết
              </Button>
            </div>
            <p v-if="!telegramStatus.configured" class="text-xs text-muted-foreground">
              Chưa cấu hình bot Telegram trên máy chủ (CC_WEB_TELEGRAM_BOT_TOKEN).
            </p>
            <div v-if="telegramCode" class="flex flex-col gap-2">
              <p class="text-xs text-muted-foreground">
                Gửi lệnh sau cho bot Telegram của bạn (mã dùng 1 lần, hết hạn sau 15 phút):
              </p>
              <p class="break-all text-sm"><code>/start {{ telegramCode }}</code></p>
              <div>
                <Button type="button" variant="outline" size="sm" @click="copyCode">
                  Sao chép lệnh
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="onClose">
          {{ t("user.cancelBtn") }}
        </Button>
        <Button :loading="isSaving" @click="saveProfile">
          {{ t("user.saveBtn") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
