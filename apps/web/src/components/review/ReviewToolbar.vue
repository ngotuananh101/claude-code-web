<script setup lang="ts">
import { Check, RotateCcw, Save } from "@lucide/vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  reviewed: boolean;
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
</script>

<template>
  <div class="flex items-center gap-2">
    <Button
      variant="outline"
      size="sm"
      :aria-pressed="reviewed"
      :class="reviewed ? 'border-primary text-primary' : ''"
      title="Chỉ đánh dấu trong phiên này — không ghi gì lên Runner."
      @click="emit('toggle-reviewed')"
    >
      <Check :size="15" />
      Đã duyệt
    </Button>

    <Button
      variant="default"
      size="sm"
      :disabled="!canSave || saving"
      :title="dirty ? 'Lưu thay đổi đã duyệt.' : 'Không có thay đổi để lưu.'"
      @click="emit('save')"
    >
      <Save :size="15" />
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
      <RotateCcw :size="15" />
      Khôi phục
    </Button>
  </div>
</template>
