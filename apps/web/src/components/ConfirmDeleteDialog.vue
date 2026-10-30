<script setup lang="ts">
import { AlertTriangle, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Reusable delete confirmation modal dialog.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    warning?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
  }>(),
  {
    warning: "",
    confirmLabel: "Xoá",
    cancelLabel: "Huỷ",
    busy: false,
  },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm"): void;
}>();

function onCancel(): void {
  if (!props.busy) {
    emit("update:open", false);
  }
}

function onConfirm(): void {
  if (!props.busy) {
    emit("confirm");
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(val: boolean) => !props.busy && emit('update:open', val)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5 shrink-0 text-destructive" />
          <span>{{ props.title }}</span>
        </DialogTitle>
        <DialogDescription class="pt-2 text-sm text-foreground">
          {{ props.description }}
        </DialogDescription>
      </DialogHeader>

      <div
        v-if="props.warning"
        class="my-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2"
      >
        <AlertTriangle class="h-4 w-4 shrink-0 text-destructive mt-0.5" />
        <span class="leading-relaxed">{{ props.warning }}</span>
      </div>

      <DialogFooter class="gap-2 sm:gap-0">
        <Button
          variant="outline"
          type="button"
          :disabled="props.busy"
          @click="onCancel"
        >
          {{ props.cancelLabel }}
        </Button>
        <Button
          variant="destructive"
          type="button"
          :disabled="props.busy"
          @click="onConfirm"
        >
          <Loader2 v-if="props.busy" class="mr-2 h-4 w-4 animate-spin" />
          {{ props.confirmLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
