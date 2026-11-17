import { reactive } from "vue";

/** Shared display metadata; runner IDs remain the registry and grouping identity. */
export const runnerNames = reactive(new Map<string, string | null>());
