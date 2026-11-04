<script setup lang="ts">
import { ref, watch } from "vue";
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
import { useI18n } from "@/lib/i18n";

const { t } = useI18n();

/**
 * Reusable rename modal dialog for sessions, runners, etc.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    initialValue?: string;
    placeholder?: string;
  }>(),
  {
    description: "",
    initialValue: "",
  },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", name: string): void;
}>();

const value = ref(props.initialValue);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      value.value = props.initialValue;
    }
  },
);

function onConfirm(): void {
  emit("confirm", value.value.trim());
}

function onCancel(): void {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(val: boolean) => emit('update:open', val)">
    <DialogContent class="max-h-[85dvh] overflow-y-auto overscroll-contain sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ props.title }}</DialogTitle>
        <DialogDescription v-if="props.description">
          {{ props.description }}
        </DialogDescription>
      </DialogHeader>

      <div class="py-4">
        <Input
          v-model="value"
          :placeholder="props.placeholder ?? t('dialogs.enterNewName')"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="max-sm:h-11"
          autofocus
          @keydown.enter.prevent="onConfirm"
        />
      </div>

      <DialogFooter class="gap-2 sm:gap-0">
        <Button variant="outline" type="button" class="max-sm:h-11" @click="onCancel">
          {{ t("dialogs.cancel") }}
        </Button>
        <Button type="button" class="max-sm:h-11" @click="onConfirm">
          {{ t("dialogs.saveChanges") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
