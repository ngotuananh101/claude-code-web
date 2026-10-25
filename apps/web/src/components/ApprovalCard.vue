<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { computed, reactive } from "vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { approvalUi, submitDecision } from "../features/approvals/store";

/**
 * An inline decision card in the journal (§13.2), rendered in place of the
 * raw JSON for every `approval.requested` row.
 *
 * The journal remains the authority on the outcome: a later
 * `approval.resolved`/`approval.expired` for the same id arrives through the
 * `terminal` prop and turns the card read-only. Between the owner's POST and
 * that event, the approvals store carries the optimistic state; and a
 * `requested` row whose expiry has passed with no terminal event renders
 * "Đã hết hạn" on its own — that is a boot-swept gate whose closing event
 * never shipped.
 */

const props = defineProps<{
  event: BrowserReplayEvent;
  terminal?: { decision?: "allow" | "deny"; reason?: string } | undefined;
}>();

type Question = {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
};

const payload = (props.event.payload ?? {}) as Record<string, unknown>;

const approvalId = typeof payload["approvalId"] === "string" ? payload["approvalId"] : "";
const kind = payload["kind"] === "user_question" ? "user_question" : "tool_permission";
const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : "";
const inputSummary = typeof payload["inputSummary"] === "string" ? payload["inputSummary"] : "";
const expiresAt = typeof payload["expiresAt"] === "number" ? payload["expiresAt"] : undefined;

const questions = computed<Question[]>(() => {
  if (kind !== "user_question") return [];
  const source = Array.isArray(payload["questions"])
    ? payload["questions"]
    : parseJsonArray(inputSummary);
  return source
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q) => ({
      question: typeof q["question"] === "string" ? q["question"] : "",
      header: typeof q["header"] === "string" ? q["header"] : undefined,
      options: Array.isArray(q["options"])
        ? q["options"]
            .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
            .map((o) => ({
              label: typeof o["label"] === "string" ? o["label"] : "",
              description: typeof o["description"] === "string" ? o["description"] : undefined,
            }))
            .filter((o) => o.label !== "")
        : undefined,
    }))
    .filter((q) => q.question !== "");
});

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const ui = approvalId === "" ? undefined : approvalUi(approvalId);

// The chosen answer per question: an option label, or the free-text "Khác".
const answers = reactive<Record<string, string>>({});
const others = reactive<Record<string, string>>({});

const allAnswered = computed(() =>
  questions.value.every((q) => (answers[q.question] ?? "") !== ""),
);

const canDecide = computed(() => {
  if (props.terminal !== undefined) return false;
  if (ui?.deciding || ui?.decision !== undefined) return false;
  if (kind === "user_question") return allAnswered.value;
  return true;
});

/** Display-side expiry fallback: the row outlived its window with no closing event. */
const displayExpired = computed(
  () => props.terminal === undefined && expiresAt !== undefined && expiresAt < Date.now(),
);

const stateLabel = computed(() => {
  if (props.terminal !== undefined) {
    if (props.terminal.decision === "allow") return "Đã cho phép";
    if (props.terminal.decision === "deny") return "Đã từ chối";
    return props.terminal.reason === "timeout" ? "Đã hết hạn" : "Đã hủy";
  }
  if (displayExpired.value) return "Đã hết hạn";
  if (ui?.decision === "allow") return "Đã cho phép";
  if (ui?.decision === "deny") return "Đã từ chối";
  return undefined;
});

function pick(question: string, label: string): void {
  answers[question] = label;
  delete others[question];
}

function answerWithOther(question: string): void {
  answers[question] = others[question] ?? "";
}

async function decide(
  decision: "allow" | "deny",
  answersMap?: Record<string, string>,
): Promise<void> {
  if (!canDecide.value || approvalId === "") return;
  await submitDecision(approvalId, decision, answersMap);
}

function submitAnswers(): void {
  if (!allAnswered.value) return;
  const map: Record<string, string> = {};
  for (const q of questions.value) map[q.question] = answers[q.question] ?? "";
  void decide("allow", map);
}
</script>

<template>
  <div
    class="mt-1 mb-1.5 max-w-[560px] rounded-lg border border-border bg-card px-3.5 py-3 shadow-sm"
  >
    <div class="flex items-center gap-2">
      <Badge variant="outline" class="font-mono text-[11px]">
        {{ kind === "user_question" ? "Câu hỏi" : "Xin quyền" }}
      </Badge>
      <span v-if="toolName" class="font-mono text-xs text-muted-foreground">{{ toolName }}</span>
      <span
        v-if="stateLabel"
        class="ml-auto text-xs font-medium"
        :class="
          stateLabel === 'Đã cho phép'
            ? 'text-emerald-600 dark:text-emerald-500'
            : stateLabel === 'Đã từ chối'
              ? 'text-destructive'
              : 'text-muted-foreground'
        "
      >
        {{ stateLabel }}
      </span>
    </div>

    <pre
      v-if="kind === 'tool_permission' && inputSummary"
      class="mt-2 max-h-40 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[12px] leading-[1.55] break-words whitespace-pre-wrap text-foreground"
      >{{ inputSummary }}</pre
    >

    <div v-if="kind === 'user_question'" class="mt-2 space-y-3">
      <div v-for="q in questions" :key="q.question">
        <p class="text-[13px] font-medium text-foreground">
          {{ q.header ? `${q.header}: ${q.question}` : q.question }}
        </p>
        <div class="mt-1.5 space-y-1.5">
          <Button
            v-for="option in q.options"
            :key="option.label"
            variant="outline"
            size="sm"
            class="h-auto w-full justify-start py-1.5 text-left text-[13px]"
            :class="answers[q.question] === option.label ? 'border-primary bg-primary/10' : ''"
            :disabled="!canDecide"
            @click="pick(q.question, option.label)"
          >
            <span class="min-w-0">
              <span class="block font-medium">{{ option.label }}</span>
              <span
                v-if="option.description"
                class="block text-xs font-normal text-muted-foreground"
                >{{ option.description }}</span
              >
            </span>
          </Button>
        </div>
        <div class="mt-1.5 flex items-center gap-1.5">
          <Input
            v-model="others[q.question]"
            class="h-7 text-[13px]"
            placeholder="Khác — nhập câu trả lời…"
            :aria-label="`Câu trả lời khác cho: ${q.question}`"
            :disabled="!canDecide"
            @update:model-value="answerWithOther(q.question)"
          />
        </div>
      </div>
    </div>

    <div v-if="ui?.deciding" class="mt-2.5 text-xs text-muted-foreground">
      Đang chuyển quyết định…
    </div>

    <div v-if="canDecide" class="mt-2.5 flex items-center gap-2">
      <template v-if="kind === 'tool_permission'">
        <Button size="sm" @click="decide('allow')">Cho phép</Button>
        <Button size="sm" variant="outline" @click="decide('deny')">Từ chối</Button>
      </template>
      <template v-else>
        <Button size="sm" :disabled="!allAnswered" @click="submitAnswers">Gửi câu trả lời</Button>
        <Button size="sm" variant="outline" @click="decide('deny')">Bỏ qua</Button>
      </template>
    </div>
  </div>
</template>
