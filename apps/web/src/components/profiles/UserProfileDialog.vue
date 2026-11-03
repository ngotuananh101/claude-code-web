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
import { useI18n } from "@/lib/i18n/index.ts";
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
