<script setup lang="ts">
import type { RunnerCapabilities, RunnerMcpServer } from "@cc-web/protocol";
import { computed, ref } from "vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/index.ts";

const props = defineProps<{
  open: boolean;
  runnerName?: string | null;
  runnerId: string;
  capabilities?: RunnerCapabilities | null;
}>();

const emit = defineEmits<(e: "update:open", value: boolean) => void>();

const { t } = useI18n();

type Tab = "plugins" | "mcp" | "agents";
const activeTab = ref<Tab>("plugins");

const plugins = computed(() => props.capabilities?.plugins ?? []);
const commands = computed(() => props.capabilities?.commands ?? []);
const mcpServers = computed(() => props.capabilities?.mcpServers ?? []);
const agents = computed(() => props.capabilities?.agents ?? []);

const hasPluginsOrCommands = computed(() => plugins.value.length > 0 || commands.value.length > 0);
const hasMcp = computed(() => mcpServers.value.length > 0);
const hasAgents = computed(() => agents.value.length > 0);

function mcpStatusClass(status: RunnerMcpServer["status"]): string {
  if (status === "connected") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (status === "failed") return "bg-destructive/15 text-destructive";
  return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
}

function mcpStatusLabel(status: RunnerMcpServer["status"]): string {
  if (status === "connected") return t("runners.mcpStatusConnected");
  if (status === "failed") return t("runners.mcpStatusFailed");
  return t("runners.mcpStatusConfigured");
}

function setOpen(value: boolean): void {
  emit("update:open", value);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="setOpen">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ t("runners.capabilitiesDialogTitle") }}</DialogTitle>
        <DialogDescription>
          {{ runnerName || runnerId }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex gap-2 border-b border-border pb-2">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
          :class="
            activeTab === 'plugins'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          "
          @click="activeTab = 'plugins'"
        >
          {{ t("runners.tabPlugins") }}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
          :class="
            activeTab === 'mcp'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          "
          @click="activeTab = 'mcp'"
        >
          {{ t("runners.tabMcp") }}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
          :class="
            activeTab === 'agents'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          "
          @click="activeTab = 'agents'"
        >
          {{ t("runners.tabAgents") }}
        </button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto py-2">
        <div v-if="activeTab === 'plugins'">
          <div v-if="!hasPluginsOrCommands" class="py-6 text-center text-sm text-muted-foreground">
            {{ t("runners.noPlugins") }}
          </div>
          <div v-else class="space-y-4">
            <section v-if="plugins.length > 0">
              <h3 class="mb-2 text-sm font-semibold text-foreground">
                {{ t("runners.installedPlugins") }}
              </h3>
              <ul class="space-y-2">
                <li
                  v-for="plugin in plugins"
                  :key="plugin.name"
                  class="rounded-md border border-border bg-card p-3"
                >
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-foreground">{{ plugin.name }}</span>
                    <span v-if="plugin.version" class="text-xs text-muted-foreground">
                      v{{ plugin.version }}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span v-if="plugin.scope">{{ plugin.scope }}</span>
                    <span v-if="plugin.source">{{ plugin.source }}</span>
                    <span v-if="plugin.installPath" class="truncate">{{ plugin.installPath }}</span>
                  </div>
                </li>
              </ul>
            </section>

            <section v-if="commands.length > 0">
              <h3 class="mb-2 text-sm font-semibold text-foreground">
                {{ t("runners.availableCommands") }}
              </h3>
              <ul class="space-y-2">
                <li
                  v-for="command in commands"
                  :key="command.name"
                  class="rounded-md border border-border bg-card p-3"
                >
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-sm font-medium text-foreground">/{{ command.name }}</span>
                    <span v-if="command.argumentHint" class="text-xs text-muted-foreground">
                      {{ command.argumentHint }}
                    </span>
                  </div>
                  <p v-if="command.description" class="mt-1 text-xs text-muted-foreground">
                    {{ command.description }}
                  </p>
                </li>
              </ul>
            </section>
          </div>
        </div>

        <div v-if="activeTab === 'mcp'">
          <div v-if="!hasMcp" class="py-6 text-center text-sm text-muted-foreground">
            {{ t("runners.noMcpServers") }}
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="server in mcpServers"
              :key="server.name"
              class="rounded-md border border-border bg-card p-3"
            >
              <div class="flex items-center gap-2">
                <span class="font-medium text-foreground">{{ server.name }}</span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="mcpStatusClass(server.status)"
                >
                  {{ mcpStatusLabel(server.status) }}
                </span>
              </div>
              <div v-if="server.command" class="mt-1 truncate font-mono text-xs text-muted-foreground">
                {{ server.command }}
              </div>
              <div v-if="server.tools && server.tools.length > 0" class="mt-2">
                <p class="mb-1 text-xs font-medium text-muted-foreground">
                  {{ t("runners.toolsExposed") }}
                </p>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="tool in server.tools"
                    :key="tool"
                    class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {{ tool }}
                  </span>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <div v-if="activeTab === 'agents'">
          <div v-if="!hasAgents" class="py-6 text-center text-sm text-muted-foreground">
            {{ t("runners.noAgents") }}
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="agent in agents"
              :key="agent.name"
              class="rounded-md border border-border bg-card p-3"
            >
              <div class="flex items-center gap-2">
                <span class="font-medium text-foreground">{{ agent.name }}</span>
                <span v-if="agent.model" class="text-xs text-muted-foreground">
                  {{ agent.model }}
                </span>
              </div>
              <p v-if="agent.description" class="mt-1 text-xs text-muted-foreground">
                {{ agent.description }}
              </p>
            </li>
          </ul>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
