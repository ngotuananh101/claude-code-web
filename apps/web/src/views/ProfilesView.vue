<script setup lang="ts">
import type {
  ModelMapping,
  ProfileAuthField,
  ProfileDetail,
  ProfileSummary,
} from "@cc-web/protocol";
import { Loader2, Plus, RefreshCw, Save, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog.vue";
import ModelCombobox from "@/components/profiles/ModelCombobox.vue";
import MonacoCodeEditor from "@/components/review/MonacoCodeEditor.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProfileForm } from "@/features/profiles/profiles-logic.ts";
import {
  formFreeSettings,
  formToJson,
  jsonToForm,
  nextSelectedProfileId,
  profileFormFromDetail,
  profileSaveBody,
  validateSettingsJson,
  withModelMapping,
} from "@/features/profiles/profiles-logic.ts";
import { useI18n } from "@/lib/i18n/index.ts";
import {
  createProfile,
  deleteProfile,
  fetchProfileModels,
  getProfile,
  listProfiles,
  updateProfile,
} from "@/services/profiles-api.ts";

const { t } = useI18n();

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
const json = ref("{}");

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

// The upstream model catalogue the comboboxes suggest from. Loaded from the
// gateway through the control server (which holds the credential), so the list
// belongs to the selected profile's endpoint, not to the screen.
const availableModels = ref<string[]>([]);
const modelsLoading = ref(false);
const modelsError = ref<string | null>(null);
let modelsRequestId = 0;

/**
 * Fetch the gateway's model catalogue for the current form. `manual` marks an
 * operator click: a missing endpoint/key or a failed lookup turns into a toast,
 * while the silent auto-load on profile selection keeps the error inline.
 * Responses are token-checked so switching profiles mid-flight cannot let a
 * stale catalogue land on the new one.
 */
async function loadModels(manual = false): Promise<void> {
  const requestId = ++modelsRequestId;
  availableModels.value = [];
  modelsError.value = null;

  const endpoint = form.value.endpoint.trim();
  const apiKey = form.value.apiKey.trim();
  if (endpoint === "") {
    if (manual) toast.error(t("profiles.enterEndpointFirst"));
    return;
  }
  if (apiKey === "" && editingDetail.value?.hasKey !== true) {
    if (manual) toast.error(t("profiles.enterApiKeyFirst"));
    return;
  }

  modelsLoading.value = true;
  try {
    const result = await fetchProfileModels({
      endpoint,
      authField: form.value.authField,
      ...(apiKey === "" ? {} : { apiKey }),
      ...(editingDetail.value === null ? {} : { profileId: editingDetail.value.id }),
    });
    if (requestId !== modelsRequestId) return;
    if (result.ok) {
      availableModels.value = result.models;
      if (manual) toast.success(t("profiles.modelsLoadedGateway", { count: result.models.length }));
    } else if (result.code !== "unauthorized") {
      modelsError.value = result.message;
      if (manual) toast.error(result.message);
    }
  } finally {
    if (requestId === modelsRequestId) modelsLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listProfiles();
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    profiles.value = result.profiles;
    // Keep the operator on the profile they were editing when it still exists;
    // otherwise open the first one — or a blank editor when none are left.
    // Loading the detail here is what seeds the editor: a bare `selectedId`
    // would leave the Select showing a profile the form knows nothing about.
    const nextId = nextSelectedProfileId(result.profiles, selectedId.value);
    if (nextId === null) {
      newProfile();
    } else {
      await selectProfile(nextId);
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
    form.value = profileFormFromDetail(result.profile);
    // Seed the JSON editor from the stored settings — not from the previous
    // selection's text — so a profile's own custom env/permissions show up and
    // the editor never carries another profile's leftover settings.
    json.value = formToJson(form.value, result.profile.settings ?? {});
    // Reset catalogue for the newly opened profile; models are fetched on-demand
    // only when the operator clicks "Lấy model".
    modelsRequestId += 1;
    availableModels.value = [];
    modelsLoading.value = false;
    modelsError.value = null;
  } else if (result.code !== "unauthorized") {
    toast.error(result.message);
  }
}

/** Start with a blank editor for creating a new profile. */
function newProfile(): void {
  selectedId.value = null;
  editingDetail.value = null;
  form.value = {
    name: "",
    endpoint: "",
    apiKey: "",
    authField: "ANTHROPIC_AUTH_TOKEN",
    modelMapping: {},
  };
  // Drop the previous profile's catalogue: it does not describe this endpoint.
  modelsRequestId += 1;
  availableModels.value = [];
  modelsLoading.value = false;
  modelsError.value = null;
  syncJsonFromForm();
}

/** Regenerate the JSON editor text from the current form (one direction). */
function syncJsonFromForm(): void {
  json.value = formToJson(form.value, parseExtraSettings());
}

/**
 * Parse the settings the visual form does not own out of the editor text so
 * `formToJson` can re-merge them without clobbering them. Only the env vars a
 * form field drives are stripped — custom env entries the operator typed into
 * the JSON side survive both a form edit and a save. Returns `undefined` when
 * the editor is mid-keystroke / invalid.
 */
function parseExtraSettings(): Record<string, unknown> | undefined {
  const validation = validateSettingsJson(json.value);
  if (!validation.valid) return undefined;
  return formFreeSettings(JSON.parse(json.value) as Record<string, unknown>);
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
  // changed. The credential and auth field are part of the comparison — typing
  // a key into the JSON env block is a real edit, and it should reach the form
  // (and therefore the save body) rather than being silently ignored.
  const same =
    parsed.name === form.value.name &&
    parsed.endpoint === form.value.endpoint &&
    parsed.authField === form.value.authField &&
    parsed.apiKey === form.value.apiKey &&
    JSON.stringify(parsed.modelMapping) === JSON.stringify(form.value.modelMapping);
  if (!same) {
    form.value = {
      name: parsed.name,
      endpoint: parsed.endpoint,
      apiKey: parsed.apiKey,
      authField: parsed.authField,
      modelMapping: parsed.modelMapping,
    };
  }
});

function onModelChange(role: keyof ModelMapping, value: string): void {
  form.value = {
    ...form.value,
    modelMapping: withModelMapping(form.value.modelMapping, role, value),
  };
}

async function save(): Promise<void> {
  if (saveDisabled.value) return;
  const editingId = editingDetail.value?.id ?? null;
  const wasCreating = editingId === null;
  const body = profileSaveBody(form.value, parseExtraSettings());

  const result =
    editingId === null ? await createProfile(body) : await updateProfile(editingId, body);

  if (result.ok) {
    await load();
    // `load` may already have opened the saved profile (a create lands first in
    // the list); only re-select when it did not.
    if (selectedId.value !== result.profile.profileId) {
      await selectProfile(result.profile.profileId);
    }
    toast.success(
      wasCreating ? t("profiles.profileCreatedSuccess") : t("profiles.profileSavedSuccess"),
    );
  } else {
    toast.error(result.message);
  }
}

function triggerDelete(profile?: ProfileSummary): void {
  if (profile) deleteTarget.value = profile;
}

const deleteProfileTargetName = computed(() => deleteTarget.value?.name ?? "");

async function handleDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  const id = deleteTarget.value.profileId;
  const outcome = await deleteProfile(id);
  if (outcome === "deleted") {
    // `load` re-resolves the selection: the deleted profile is gone from the
    // list, so it opens the next one — or a blank editor when none remain.
    await load();
    toast.success(t("profiles.profileDeletedSuccess"));
  } else {
    toast.error(t("profiles.profileDeleteError"));
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
  <ScrollArea class="min-h-0 flex-1">
    <div class="w-full px-7 py-7">
      <p class="mb-6 flex items-center gap-3.5 font-mono text-[13px] text-primary">
        cc-web / {{ t("rail.profiles").toLowerCase() }}
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </p>
      <h1 class="mb-2 text-[26px] font-medium tracking-tight">{{ t("profiles.profilesDataSourceTitle") }}</h1>
      <p class="mb-6 text-sm leading-relaxed text-muted-foreground">
        {{ t("profiles.profilesDataSourceDesc") }}
      </p>

      <div class="mb-6 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <span class="text-xs font-medium text-muted-foreground">{{ t("profiles.selectProfileLabel") }}</span>
          <Select
            :model-value="selectedId ?? ''"
            @update:model-value="selectProfile"
          >
            <SelectTrigger class="w-64 sm:w-72">
              <SelectValue :placeholder="t('profiles.selectOrNewPlaceholder')">
                <span v-if="selected" class="truncate font-medium text-foreground">
                  {{ selected.name }}
                </span>
                <span v-else-if="selectedId === null" class="italic text-muted-foreground">
                  {{ t("profiles.newProfileOption") }}
                </span>
                <span v-else class="text-muted-foreground">{{ t("profiles.selectOrNewPlaceholder") }}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              :side-offset="4"
              class="w-[var(--reka-select-trigger-width)] min-w-72"
            >
              <SelectItem value="" :text-value="t('profiles.newProfileOption')">
                <span class="font-medium text-primary">{{ t("profiles.newProfileOption") }}</span>
              </SelectItem>
              <SelectItem
                v-for="p in profiles"
                :key="p.profileId"
                :value="p.profileId"
                :text-value="p.name"
              >
                <div class="flex flex-col gap-0.5 py-0.5 min-w-0">
                  <span class="font-medium text-foreground truncate">{{ p.name }}</span>
                  <span class="font-mono text-[11px] text-muted-foreground truncate">
                    {{ p.endpoint }}
                  </span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" @click="newProfile">
            <Plus :size="14" />
            <span class="ml-1.5">{{ t("profiles.newProfileOption") }}</span>
          </Button>
        </div>
      </div>

      <div
        v-if="loading"
        class="py-8 text-center text-sm text-muted-foreground"
      >
        {{ t("profiles.loadingProfiles") }}
      </div>

      <template v-else>
        <!-- The page is full width now: the form column stays readable at a
             fixed maximum and the JSON editor takes every remaining pixel. -->
        <div
          class="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]"
        >
          <!-- LEFT: Visual form + model mapping table -->
          <section class="space-y-5">
            <div class="space-y-2">
              <Label for="profile-name">{{ t("profiles.profileNameLabel") }}</Label>
              <Input
                id="profile-name"
                v-model="form.name"
                placeholder="9Router"
                class="font-mono text-sm"
              />
            </div>

            <div class="space-y-2">
              <Label for="profile-endpoint">{{ t("profiles.apiEndpointLabel") }}</Label>
              <Input
                id="profile-endpoint"
                v-model="form.endpoint"
                placeholder="http://192.168.2.3:20128"
                class="font-mono text-sm"
              />
            </div>

            <div class="space-y-2">
              <Label for="profile-apiKey">{{ t("profiles.apiKeyLabel") }}</Label>
              <Input
                id="profile-apiKey"
                v-model="form.apiKey"
                type="password"
                autocomplete="off"
                :placeholder="
                  keepExistingKey
                    ? t('profiles.apiKeyEmptyKeepStored')
                    : t('profiles.apiKeyEmptyNoKey')
                "
                class="font-mono text-sm"
              />
              <p
                v-if="keepExistingKey"
                class="text-xs text-muted-foreground"
              >
                {{ t("profiles.apiKeyStoredNotice") }}
              </p>
            </div>

            <div class="space-y-2">
              <Label for="profile-authField">{{ t("profiles.authHeaderFieldLabel") }}</Label>
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
              <div class="mb-2 flex items-end justify-between gap-2">
                <Label>{{ t("profiles.modelMappingLabel") }}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  class="gap-1.5 text-xs"
                  :disabled="modelsLoading"
                  :title="t('profiles.loadModelsBtn')"
                  @click="void loadModels(true)"
                >
                  <Loader2 v-if="modelsLoading" :size="12" class="animate-spin" />
                  <RefreshCw v-else :size="12" />
                  <span>{{ modelsLoading ? t("profiles.loadingModelsBtn") : t("profiles.loadModelsBtn") }}</span>
                </Button>
              </div>
              <p v-if="modelsError" class="mb-2 text-[11px] text-destructive">
                {{ modelsError }}
              </p>
              <p v-else-if="availableModels.length > 0" class="mb-2 text-[11px] text-muted-foreground">
                {{ t("profiles.modelsFilterNotice", { count: availableModels.length }) }}
              </p>
              <div class="overflow-hidden rounded-md border border-border">
                <div
                  class="flex items-center gap-3 border-b border-border bg-muted/40 px-2 py-1.5 text-[11px] uppercase text-muted-foreground"
                >
                  <span class="min-w-0 flex-1">{{ t("profiles.roleEnvVarHeader") }}</span>
                  <span class="w-[52%] shrink-0">{{ t("profiles.upstreamModelHeader") }}</span>
                </div>
                <div
                  v-for="m in MODEL_ROLES"
                  :key="m.role"
                  class="flex items-center gap-3 border-t border-border px-2 py-1.5 first:border-t-0"
                >
                  <div class="min-w-0 flex-1">
                    <div class="font-medium capitalize">{{ m.role }}</div>
                    <code
                      :title="m.envVar"
                      class="block truncate font-mono text-[10px] text-muted-foreground"
                    >
                      {{ m.envVar }}
                    </code>
                  </div>
                  <div class="w-[52%] shrink-0">
                    <ModelCombobox
                      :model-value="form.modelMapping[m.role] ?? ''"
                      :models="availableModels"
                      :loading="modelsLoading"
                      placeholder="—"
                      @update:model-value="onModelChange(m.role, String($event ?? ''))"
                    />
                  </div>
                </div>
              </div>
            </div>

            <p class="text-xs text-muted-foreground">
              {{ t("profiles.formJsonSyncNotice") }}
            </p>
          </section>

          <!-- RIGHT: JSON editor -->
          <section class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <div>
                <Label for="profile-json">{{ t("profiles.configJsonLabel") }}</Label>
                <p class="text-[11px] text-muted-foreground">
                  {{ t("profiles.configJsonDesc") }}
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
                    {{ t("profiles.formatJsonBtn") }}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t("profiles.formatJsonTooltip") }}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </div>

            <div
              class="relative flex-1 overflow-hidden rounded-xl border border-border bg-[#09090b] min-h-[420px]"
            >
              <MonacoCodeEditor
                :content="json"
                path="settings.json"
                :minimap="false"
                :options="{
                  fontSize: 12,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  renderLineHighlight: 'all',
                  padding: { top: 8, bottom: 8 },
                }"
                class="size-full"
                @update:content="json = $event"
              />
              <div
                v-if="!jsonValidation.valid"
                class="pointer-events-none absolute right-3 top-2.5 z-10 rounded border border-destructive/30 bg-destructive/90 px-2 py-0.5 text-[10px] font-medium text-destructive-foreground shadow-sm"
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
                <span class="ml-1">{{ t("profiles.deleteProfileBtn") }}</span>
              </Button>
              <Button :disabled="saveDisabled" @click="save">
                <Save :size="14" />
                <span class="ml-1.5">{{ t("profiles.saveProfileBtn") }}</span>
              </Button>
            </div>
          </section>
        </div>
      </template>
    </div>
  </ScrollArea>

  <ConfirmDeleteDialog
    v-model:open="deleteDialogOpen"
    :title="t('profiles.deleteProfileBtn')"
    :description="t('profiles.profileDeleteConfirm', { name: deleteProfileTargetName })"
    :warning="t('profiles.profileDeleteWarning')"
    :confirm-label="t('profiles.deleteProfileBtn')"
    :busy="deleteBusy"
    @confirm="confirmDelete"
  />
</template>
