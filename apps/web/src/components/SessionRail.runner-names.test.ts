import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ref } from "vue";
import { groupSessions } from "../features/sessions/session-groups.ts";
import { fetchRunners } from "../services/runners-api.ts";
import { fetchWorkspaces } from "../services/workspaces-api.ts";
import { runnerNames } from "../stores/runner-names.ts";

// Execute the rail's production refresh and group expression: a missing registry
// fetch or an omitted runnerNames argument must leave the heading showing an ID.
const source = readFileSync(new URL("./SessionRail.vue", import.meta.url), "utf8");
const refreshBody = source.match(
  /async function refreshWorkspaces\(\): Promise<void> \{([\s\S]*?)\n\}/,
)?.[1];
const groupExpression = source.match(/const groups = computed\(\(\) =>([\s\S]*?)\n\);/)?.[1];
if (refreshBody === undefined || groupExpression === undefined) {
  throw new Error("SessionRail navigation metadata handlers not found");
}
const refresh = new Function(
  "fetchWorkspaces",
  "fetchRunners",
  "workspaces",
  `return (async () => {${refreshBody}})();`,
);
const groups = new Function(
  "groupSessions",
  "sessions",
  "workspaces",
  "grouping",
  "sort",
  "runnerNames",
  `return (${groupExpression.trim().replace(/,$/, "")});`,
);
const realFetch = globalThis.fetch;
const previousNames = new Map(runnerNames);
afterEach(() => {
  globalThis.fetch = realFetch;
  runnerNames.clear();
  for (const [id, name] of previousNames) runnerNames.set(id, name);
});

test("rail metadata refresh feeds assigned runner names into its displayed groups", async () => {
  runnerNames.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/workspaces") return Response.json({ workspaces: [] });
    if (String(input) === "/api/runners")
      return Response.json({
        runners: [{ runnerId: "runner-1", name: "Workstation", revokedAt: null, models: [] }],
      });
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;
  const workspaces = ref([]);
  await refresh(fetchWorkspaces, fetchRunners, workspaces);
  const result = groups(
    groupSessions,
    {
      sessions: [
        {
          sessionId: "session-1",
          watermark: 1,
          eventCount: 1,
          lastEventType: null,
          lastIngestedAt: 100,
          live: false,
          runnerId: "runner-1",
          workspaceId: "ws-1",
          sdkSessionId: null,
        },
      ],
    },
    workspaces,
    ref("runner"),
    ref("recent"),
    runnerNames,
  );
  expect(result[0]?.label).toBe("Workstation");
});
