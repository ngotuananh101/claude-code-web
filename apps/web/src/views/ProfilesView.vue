<script setup lang="ts">
import type {
  ModelMapping,
  ProfileAuthField,
  ProfileDetail,
  ProfileSummary,
} from "@cc-web/protocol";
import { Plus, Save, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProfileForm } from "@/features/profiles/profiles-logic.ts";
import {
  formToJson,
  jsonToForm,
  validateSettingsJson,
} from "@/features/profiles/profiles-logic.ts";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  type SaveProfileResult,
  updateProfile,
} from "@/services/profiles-api.ts";

/** The auth-field choices the operator can bind the API key under. */
const AUTH_OPTIONS: Array<{ value: ProfileAuthField; label: string }> = [
  { value: "ANTHROPIC_AUTH_TOKEN", label: "ANTHROPIC_AUTH_TOKEN" },
  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" },
];

/** The five Claude Code model roles, paired with their upstream env-var name. */
const MODEL_ROLES: Array<{ role: keyof ModelMapping; envVar: string }> = [
  { role: "sonnet", envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { role: "opus", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { role: "haiku", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
  { role: "fable", envVar: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
  { role: "subagent", envVar: "CLAUDE_CODE_SUBAGENT_MODEL" },
];

const profiles = ref<ProfileSummary[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(false);

// The live editor state. `form` is the visual side; `json` is the raw editor
// text. Two `watch`es keep them in lockstep — form edits regenerate JSON, and
// valid JSON edits repopulate form fields; invalid JSON shows the badge and
// disables Save.
const form = ref<ProfileForm>({
  name: "",
  endpoint: "",
  apiKey: "",
  authField: "ANTHROPIC_AUTH_TOKEN",
  modelMapping: {},
});
const json = ref("");

const editingDetail = ref<ProfileDetail | null>(null);
const deleteTarget = ref<ProfileSummary | null>(null);
const deleteDialogOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deleteTarget.value = null;
  },
});

const selected = computed(() => profiles.value.find((p) => p.profileId === selectedId.value));

/**
 * Whether the editor's Save action is wired. The JSON editor always mirrors
 * the form, so the badge flips to "saving disabled" only while the JSON is
 * unparseable — mirroring design doc §7.4 point 4.
 */
const jsonValidation = computed(() => validateSettingsJson(json.value));
const saveDisabled = computed(() => !jsonValidation.value.valid);

const keepExistingKey = computed(() => Boolean(editingDetail.value?.hasKey));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listProfiles();
    if (result.ok) {
      profiles.value = result.profiles;
      if (result.profiles.length > 0 && selectedId.value === null) {
        selectedId.value = result.profiles[0].profileId;
      }
    } else {
      toast.error(result.message);
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

/**
 * Load the selected profile into the editor. The cleartext key is masked by
 * the server; an empty `apiKey` field with `hasKey` means "keep the stored
 * secret" (design doc §7.2). The API key input shows the masked hint.
 */
async function selectProfile(raw: string): Promise<void> {
  const id = raw === "" ? null : raw;
  selectedId.value = id;
  if (id === null) {
    newProfile();
    return;
  }
  const result = await getProfile(id);
  if (result.ok) {
    editingDetail.value = result.profile;
    form.value = {
      name: result.profile.name,
      endpoint: result.profile.endpoint,
      apiKey: "",
      authField: result.profile.authField,
      modelMapping: result.profile.modelMapping ?? {},
    };
    // Start the JSON editor from the masked/omitted form so the editor never
    // shows a cleartext secret it didn't just type.
    syncJsonFromForm();
  } else if (result.code !== "unauthorized") {
    toast.error(result.message);
  }
}

/** Start with a blank editor for creating a new profile. */
function newProfile(): void {
  editingDetail.value = null;
  form.value = {
    name: "",
    endpoint: "",
    apiKey: "",
    authField: "ANTHROPIC_AUTH_TOKEN",
    modelMapping: {},
  };
  syncJsonFromForm();
}

/** Regenerate the JSON editor text from the current form (one direction). */
function syncJsonFromForm(): void {
  json.value = formToJson(form.value, parseExtraSettings());
}

/**
 * Parse the non-env remainder currently held in the editor back into a plain
 * object so `formToJson` can re-merge it without clobbering it. Returns `{}`
 * when the editor is mid-keystroke / invalid.
 */
function parseExtraSettings(): Record<string, unknown> | undefined {
  const validation = validateSettingsJson(json.value);
  if (!validation.valid) return undefined;
  const parsed = JSON.parse(json.value);
  const record = parsed as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== "env") extra[key] = record[key];
  }
  return extra;
}

// When the form changes, regenerate the JSON editor — preserving any extra
// top-level settings (permissions, etc.) the form does not own.
watch(form, syncJsonFromForm, { deep: true });

// When the JSON editor becomes valid, push its known fields back into the
// form. We only overwrite form fields from JSON when the JSON parse
// succeeds — invalid JSON leaves the form untouched and shows the badge.
watch(json, (value) => {
  const validation = validateSettingsJson(value);
  if (!validation.valid) return;
  const parsed = jsonToForm(value);
  // Avoid a self-inflicted loop: only write back when something actually
  // changed. `authField`/`apiKey` are intentionally excluded from the
  // comparison because the editor may carry a masked value we must not
  // round-trip into the credential input.
  const same =
    parsed.name === form.value.name &&
    parsed.endpoint === form.value.endpoint &&
    parsed.authField === form.value.authField &&
    JSON.stringify(parsed.modelMapping) === JSON.stringify(form.value.modelMapping);
  if (!same) {
    form.value = parsed;
  }
});

function onModelChange(role: keyof ModelMapping, value: string): void {
  const next: ModelMapping = { ...form.value.modelMapping };
  if (value === "") {
    delete next[role];
  } else {
    next[role] = value;
  }
  form.value = { ...form.value, modelMapping: next };
}

async function save(): Promise<void> {
  if (saveDisabled.value) return;
  const extra = parseExtraSettings();
  const body = {
    name: form.value.name,
    endpoint: form.value.endpoint,
    authField: form.value.authField,
    apiKey: form.value.apiKey,
    modelMapping: form.value.modelMapping,
    settingsJson:
      extra !== undefined && Object.keys(extra).length > 0 ? JSON.stringify(extra) : undefined,
  };

  let result: SaveProfileResult;
  if (editingDetail.value !== null) {
    result = await updateProfile(editingDetail.value.id, body);
  } else {
    result = await createProfile(body);
  }

  if (result.ok) {
    await load();
    void selectProfile(result.profile.profileId);
    toast.success(editingDetail.value === null ? "Đã tạo profile." : "Đã lưu profile.");
  } else {
    toast.error(result.message);
  }
}

function triggerDelete(profile?: ProfileSummary): void {
  if (profile) deleteTarget.value = profile;
}

async function handleDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  const id = deleteTarget.value.profileId;
  const outcome = await deleteProfile(id);
  if (outcome === "deleted") {
    await load();
    if (selectedId.value === id) {
      selectedId.value = profiles.value[0]?.profileId ?? null;
    }
    toast.success("Đã xoá profile.");
  } else {
    toast.error("Không thể xoá profile.");
  }
  deleteTarget.value = null;
}

const deleteBusy = ref(false);
async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleteBusy.value = true;
  try {
    await handleDelete();
  } finally {
    deleteBusy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="mx-auto w-full max-w-[720px] px-7 py-7">
      <p class="mb-6 flex items-center gap-3.5 font-mono text-[13px] text-primary">
        cc-web / profiles
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </p>
      <h1 class="mb-2 text-[26px] font-medium tracking-tight">Profiles nguồn dữ liệu.</h1>
      <p class="mb-6 text-sm leading-relaxed text-muted-foreground">
        Định cấu hình nguồn dữ liệu thay thế (9Router, proxy, endpoint
        Anthropic) và bảng ánh xạ model cho từng phiên. Thay đổi ở form này
        cập nhật ngay sang JSON bên phải.
      </p>

      <div class="mb-6 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <span class="text-xs font-medium text-muted-foreground">Chọn profile:</span>
          <Select
            :model-value="selectedId ?? ''"
            @update:model-value="selectProfile"
          >
            <SelectTrigger class="w-48">
              <SelectValue placeholder="Chọn hoặc tạo profile…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" class="font-mono">mới</SelectItem>
              <SelectItem
                v-for="p in profiles"
                :key="p.profileId"
                :value="p.profileId"
              >
                <div class="flex flex-col">
                  <span class="font-medium">{{ p.name }}</span>
                  <span class="text-xs text-muted-foreground">{{ p.endpoint }}</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" @click="newProfile">
            <Plus :size="14" />
            <span class="ml-1.5">Tạo profile mới</span>
          </Button>
        </div>
      </div>

      <div
        v-if="loading"
        class="py-8 text-center text-sm text-muted-foreground"
      >
        Đang tải profile…
      </div>

      <template v-else>
        <div class="grid grid-cols-1 gap-6 md:grid-cols-[1.1fr_0.9fr]">
          <!-- LEFT: Visual form + model mapping table -->
          <section class="space-y-5">
            <div class="space-y-2">
              <Label for="profile-name">Tên profile *</Label>
              <Input
                id="profile-name"
                v-model="form.name"
                placeholder="9Router"
                class="font-mono text-sm"
              />
            </div>

            <div class="space-y-2">
              <Label for="profile-endpoint">API Endpoint *</Label>
              <Input
                id="profile-endpoint"
                v-model="form.endpoint"
                placeholder="http://192.168.2.3:20128"
                class="font-mono text-sm"
              />
            </div>

            <div class="space-y-2">
              <Label for="profile-apiKey">API Key</Label>
              <Input
                id="profile-apiKey"
                v-model="form.apiKey"
                type="password"
                autocomplete="off"
                :placeholder="
                  keepExistingKey
                    ? 'Để trống để giữ key đã lưu (được ẩn)'
                    : 'Chưa có key'
                "
                class="font-mono text-sm"
              />
              <p
                v-if="keepExistingKey"
                class="text-xs text-muted-foreground"
              >
                Key hiện tại đã được lưu và mã hoá an toàn. Để trống để giữ
                nguyên, nhập giá trị mới để cập nhật.
              </p>
            </div>

            <div class="space-y-2">
              <Label for="profile-authField">Auth Header Field</Label>
              <Select v-model="form.authField">
                <SelectTrigger id="profile-authField">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in AUTH_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                    :text="opt.label"
                  >
                    <span class="flex items-center gap-1.5">
                      <span class="font-mono">{{ opt.label }}</span>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div class="mb-2 flex items-end justify-between">
                <Label>Model Mapping (Ánh xạ vai trò &rarr; upstream)</Label>
                <span class="text-[11px] text-muted-foreground">
                  Khớp với cấu hình 9Router
                </span>
              </div>
              <div class="overflow-x-auto">
                <table
                  class="w-full table-fixed border-separate border-spacing-0 text-sm"
                >
                  <thead>
                    <tr class="text-left text-[11px] uppercase text-muted-foreground">
                      <th class="pb-1.5 pl-1">Vai trò Claude</th>
                      <th class="pb-1.5">Biến môi trường</th>
                      <th class="pb-1.5 pl-1">Tên model upstream</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="m in MODEL_ROLES"
                      :key="m.role"
                      class="border-t border-border"
                    >
                      <td class="py-1.5 pl-1 font-medium capitalize">
                        {{ m.role }}
                      </td>
                      <td class="py-1.5">
                        <code class="text-[10px] text-muted-foreground">
                          {{ m.envVar }}
                        </code>
                      </td>
                      <td class="py-1.5 pl-1">
                        <Input
                          :value="form.modelMapping[m.role] ?? ''"
                          @update:model-value="onModelChange(m.role, $event)"
                          placeholder="—"
                          class="font-mono text-sm"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p class="text-xs text-muted-foreground">
              * Mọi thay đổi ở form này cập nhật ngay sang khung JSON bên
              phải.
            </p>
          </section>

          <!-- RIGHT: JSON editor -->
          <section class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <div>
                <Label for="profile-json">Config JSON (Claude Code settings)</Label>
                <p class="text-[11px] text-muted-foreground">
                  Sửa trực tiếp block env &amp; cài đặt tuỳ chọn
                </p>
              </div>
              <TooltipProvider>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="outline"
                    size="sm"
                    @click="json = JSON.stringify(JSON.parse(json), null, 2)"
                    :disabled="!jsonValidation.valid"
                  >
                    Định dạng
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Format JSON</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </div>

            <div class="relative flex-1">
              <Textarea
                id="profile-json"
                v-model="json"
                spellcheck="false"
                class="font-mono text-xs"
                rows="18"
              />
              <div
                v-if="!jsonValidation.valid"
                class="absolute right-2 top-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
              >
                {{ jsonValidation.error }}
              </div>
            </div>

            <div class="flex justify-end gap-3">
              <Button
                v-if="editingDetail"
                variant="outline"
                size="sm"
                class="border-destructive text-destructive hover:bg-destructive/10"
                @click="triggerDelete(selected)"
              >
                <Trash2 :size="13" />
                <span class="ml-1">Xoá profile</span>
              </Button>
              <Button :disabled="saveDisabled" @click="save">
                <Save :size="14" />
                <span class="ml-1.5">Lưu profile</span>
              </Button>
            </div>
          </section>
        </div>
      </template>
    </div>

    <ConfirmDeleteDialog
      v-model:open="deleteDialogOpen"
      title="Xoá profile"
      :description="`Bạn có chắc chắn muốn xoá profile “${deleteTarget?.name}”?`"
      :warning="
        'Toàn bộ cấu hình endpoint, key và ánh xạ model của profile này sẽ bị xoá vĩnh viễn.'
      "
      confirm-label="Xoá profile"
      :busy="deleteBusy"
      @confirm="confirmDelete"
    />
  </div>
</template>
