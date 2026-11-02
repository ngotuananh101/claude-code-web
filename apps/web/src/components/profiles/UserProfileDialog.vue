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
import { t } from "@/lib/i18n";
import { type UpdateMePayloadInternal, updateUserProfile } from "@/services/user-api.ts";
import { sessions } from "@/stores/sessions.ts";

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
const avatarPreview = computed(() => {
  if (stagedAvatar.value) {
    return stagedAvatar.value;
  }
  if (sessions.avatar) {
    return sessions.avatar;
  }
  // Fallback to initial
  const initial = sessions.account ? sessions.account.charAt(0).toUpperCase() : "";
  return initial;
});

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
    toast.error(t("profiles.avatarInvalidType"));
    return;
  }

  avatarLoading.value = true;
  try {
    const dataUrl = await downscaleAvatarImage(file, 256);
    stagedAvatar.value = dataUrl;
    toast.success(t("profiles.avatarLoaded"));
  } catch {
    toast.error(t("profiles.avatarLoadError"));
  } finally {
    avatarLoading.value = false;
    // Reset the input so the same file can be selected again
    if (fileInput.value) {
      fileInput.value.value = "";
    }
  }
};

// Remove staged avatar
const removeAvatar = () => {
  stagedAvatar.value = null;
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
    toast.error(usernameResult.error || t("profiles.usernameInvalid"));
    return;
  }

  // Validate password change
  const passwordResult = validatePasswordChange(
    currentPassword.value,
    newPassword.value,
    confirmPassword.value,
  );
  if (!passwordResult.valid) {
    toast.error(passwordResult.error || t("profiles.passwordInvalid"));
    return;
  }

  isSaving.value = true;

  try {
    const payload: UpdateMePayloadInternal = {
      username: username.value.trim() || undefined,
      avatar: stagedAvatar.value ?? undefined,
      currentPassword: currentPassword.value.trim() || undefined,
      newPassword: newPassword.value.trim() || undefined,
    };

    const result = await updateUserProfile(payload);

    if (result.ok) {
      toast.success(t("profiles.saveSuccess"));
      emit("update:open", false);
      emit("closed");
    } else {
      toast.error(result.error);
    }
  } catch {
    toast.error(t("profiles.saveError"));
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
        <DialogTitle>{{ t("profiles.dialogTitle") }}</DialogTitle>
        <DialogDescription>{{ t("profiles.dialogDescription") }}</DialogDescription>
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
                v-if="avatarPreview"
                class="w-full h-full bg-cover bg-center"
                :style="{ backgroundImage: `url(${avatarPreview})` }"
              />
              <div
                v-else
                class="w-full h-full flex items-center justify-center text-2xl font-medium text-foreground/50"
              >
                {{ avatarPreview }}
              </div>
            </div>
          </div>

          <!-- Avatar Actions -->
          <div class="flex gap-2">
            <Button type="button" variant="outline" size="sm" @click="openFilePicker">
              {{ t("profiles.uploadBtn") }}
            </Button>
            <input
              ref="fileInput"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              class="hidden"
              @change="handleFileSelect"
            />
            <Button
              v-if="avatarPreview"
              type="button"
              variant="ghost"
              size="sm"
              @click="removeAvatar"
            >
              {{ t("profiles.removeBtn") }}
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("profiles.avatarHint") }}</p>
        </div>

        <!-- Username Input -->
        <div class="flex flex-col gap-2">
          <Label for="username">{{ t("profiles.usernameLabel") }}</Label>
          <Input
            id="username"
            v-model="username"
            :placeholder="t('profiles.usernamePlaceholder')"
            :class="username.trim() && !validateUsername(username.trim()).valid ? 'aria-invalid' : ''"
          />
        </div>

        <!-- Password Change Section -->
        <div class="flex flex-col gap-3 border-t pt-4">
          <h4 class="text-sm font-medium">{{ t("profiles.passwordSection") }}</h4>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-2">
              <Label for="currentPassword">{{ t("profiles.currentPasswordLabel") }}</Label>
              <Input
                id="currentPassword"
                v-model="currentPassword"
                type="password"
                :placeholder="t('profiles.currentPasswordPlaceholder')"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="newPassword">{{ t("profiles.newPasswordLabel") }}</Label>
              <Input
                id="newPassword"
                v-model="newPassword"
                type="password"
                :placeholder="t('profiles.newPasswordPlaceholder')"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="confirmPassword">{{ t("profiles.confirmPasswordLabel") }}</Label>
              <Input
                id="confirmPassword"
                v-model="confirmPassword"
                type="password"
                :placeholder="t('profiles.confirmPasswordPlaceholder')"
              />
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="onClose">
          {{ t("profiles.cancelBtn") }}
        </Button>
        <Button :loading="isSaving" @click="saveProfile">
          {{ t("profiles.saveBtn") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
