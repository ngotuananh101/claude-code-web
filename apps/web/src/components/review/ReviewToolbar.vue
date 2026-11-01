<script setup lang="ts">
import { Check, RotateCcw, Save } from "@lucide/vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  reviewed: boolean;
  canReview: boolean;
  canSave: boolean;
  canRevert: boolean;
  saving: boolean;
  dirty: boolean;
  revertHint?: string;
}>();

const emit = defineEmits<{
  "toggle-reviewed": [];
  save: [];
  revert: [];
}>();

const iconSize = 15;
</script>

<template>
  <div class="flex items-center gap-2">
    <Button
      variant="outline"
      size="sm"
      :aria-pressed="reviewed"
      :class="reviewed ? 'border-primary text-primary' : ''"
      :disabled="!canReview"
      :title="
        canReview
          ? 'Chỉ đánh dấu trong phiên này — không ghi gì lên Runner.'
          : 'Cần một tệp có nội dung đọc được để đánh dấu đã duyệt.'
      "
      @click="emit('toggle-reviewed')"
    >
      <Check :size="iconSize" />
      Đã duyệt
    </Button>

    <Button
      variant="default"
      size="sm"
      :disabled="!canSave || saving"
      :title="dirty ? 'Lưu thay đổi đã duyệt.' : 'Không có thay đổi để lưu.'"
      @click="emit('save')"
    >
      <Save :size="iconSize" />
      {{ saving ? "Đang lưu…" : "Lưu" }}
    </Button>

    <Button
      variant="outline"
      size="sm"
      class="text-destructive"
      :disabled="!canRevert"
      :title="revertHint ?? 'Khôi phục tệp về bản chụp lúc bắt đầu chạy.'"
      @click="emit('revert')"
    >
      <RotateCcw :size="iconSize" />
      Khôi phục
    </Button>
  </div>
</template>
