import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AttachmentInfo } from "@cc-web/protocol";
import ts from "typescript5";
import { computed, ref } from "vue";
import { buildRunRequest } from "../features/composer/composer-logic.ts";

// Run the actual submission handler and Stop-target projection without mounting
// the application or opening its singleton socket.
const source = readFileSync(new URL("./SessionView.vue", import.meta.url), "utf8");
const script = source.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
const ast = ts.createSourceFile("SessionView.ts", script, ts.ScriptTarget.Latest, true);
const selected = ast.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === "onStarted") ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(ast) === "liveRunId",
      )),
);
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
  selected.map((node) => node.getText(ast)).join("\n"),
);

function sessionView(activeRun: string | null) {
  const startedRun = ref<{ sessionId: string; runId: string } | null>(
    activeRun === null ? null : { sessionId: "session-1", runId: activeRun },
  );
  const pendingRun = ref<{
    sessionId: string;
    runId: string;
    prompt: string;
    attachments?: AttachmentInfo[];
  } | null>(
    activeRun === null
      ? null
      : { sessionId: "session-1", runId: activeRun, prompt: "active prompt" },
  );
  const refreshed: string[] = [];
  const routes: string[] = [];
  const scope = {
    startedRun,
    pendingRun,
    active: ref({ sessionId: "session-1" }),
    routeSession: ref<string | null>("session-1"),
    loadedEvents: ref(activeRun === null ? [] : [{ type: "run.started", runId: activeRun }]),
    computed,
    loadSessions: async () => {},
    refreshQueue: async (sessionId: string) => {
      refreshed.push(sessionId);
    },
    router: {
      push: (path: string) => {
        routes.push(path);
      },
    },
  };
  const create = new Function(
    "scope",
    `const { ${Object.keys(scope).join(", ")} } = scope;
     ${compiled}
     return { onStarted, liveRunId };`,
  ) as (bindings: typeof scope) => {
    onStarted: (
      sessionId: string,
      runId: string,
      prompt?: string,
      attachments?: AttachmentInfo[],
      queued?: boolean,
    ) => void;
    liveRunId: { readonly value: string | null };
  };
  return { ...scope, ...create(scope), refreshed, routes };
}

const composerSource = readFileSync(new URL("../components/Composer.vue", import.meta.url), "utf8");
const composerScript = composerSource.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
const composerAst = ts.createSourceFile(
  "Composer.ts",
  composerScript,
  ts.ScriptTarget.Latest,
  true,
);
const sendHandler = composerAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "send",
)!;
const compiledSend = new Bun.Transpiler({ loader: "ts" }).transformSync(
  sendHandler.getText(composerAst),
);

for (const queued of [true, false]) {
  test(`Composer forwards queued=${queued} from the API into the session handler`, async () => {
    const state = sessionView("run-active");
    const scope = {
      canSend: ref(true),
      sending: ref(false),
      props: { sessionId: "session-1" },
      selectedFolder: ref(null),
      attachments: ref([]),
      prompt: ref("submitted prompt"),
      permission: ref("default"),
      model: ref("default"),
      effort: ref(null),
      ultracode: ref(false),
      profileId: ref(null),
      runnerId: ref("runner-1"),
      selectedSession: ref("new"),
      buildRunRequest,
      startRun: async () => ({ ok: true, runId: "run-new", queued }),
      saveComposerSettings: () => {},
      toast: { success: () => {} },
      t: (key: string) => key,
      emit: (_event: string, ...args: Parameters<typeof state.onStarted>) =>
        state.onStarted(...args),
    };
    const send = new Function(
      "scope",
      `const { ${Object.keys(scope).join(", ")} } = scope; ${compiledSend}; return send;`,
    )(scope) as () => Promise<void>;
    await send();

    expect(state.liveRunId.value).toBe(queued ? "run-active" : "run-new");
    expect(state.pendingRun.value?.prompt).toBe(queued ? "active prompt" : "submitted prompt");
    expect(state.refreshed).toEqual(["session-1"]);
    expect(scope.prompt.value).toBe("");
    expect(scope.sending.value).toBe(false);
  });
}

describe("SessionView run submission", () => {
  test("a queued submission does not replace the active Stop target or pending bubble", () => {
    const state = sessionView("run-active");
    state.onStarted("session-1", "run-queued", "waiting prompt", undefined, true);

    expect(state.liveRunId.value).toBe("run-active");
    expect(state.pendingRun.value?.runId).toBe("run-active");
    expect(state.refreshed).toEqual(["session-1"]);
  });

  test("a queued submission without an active run does not invent a Stop target", () => {
    const state = sessionView(null);
    state.onStarted("session-1", "run-queued", "waiting prompt", undefined, true);

    expect(state.liveRunId.value).toBeNull();
    expect(state.pendingRun.value).toBeNull();
  });

  test("a queued submission from the new-session page still opens the session", () => {
    const state = sessionView(null);
    state.routeSession.value = null;
    state.onStarted("session-1", "run-queued", "waiting prompt", undefined, true);

    expect(state.routes).toEqual(["/sessions/session-1"]);
    expect(state.refreshed).toEqual(["session-1"]);
    expect(state.liveRunId.value).toBeNull();
  });

  test("an admitted submission remains immediately stoppable before journal events arrive", () => {
    const state = sessionView(null);
    state.onStarted("session-1", "run-new", "new prompt", undefined, false);

    expect(state.liveRunId.value).toBe("run-new");
    expect(state.pendingRun.value?.prompt).toBe("new prompt");
  });
});
