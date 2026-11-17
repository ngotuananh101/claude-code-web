import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createMemoryHistory, createRouter } from "vue-router";
import { createSessionStream } from "../services/session-stream.ts";
import { closeSession, sessions } from "../stores/sessions.ts";

/**
 * Bun cannot compile SFCs. Execute the rail's actual, dependency-free handler
 * body against a real memory router and session store, rather than asserting
 * source text or copying the action into the test. Reintroducing a premature
 * closeSession() must lose the journal while the guard is still pending.
 */
const source = readFileSync(new URL("./SessionRail.vue", import.meta.url), "utf8");
const handler = source.match(/function newSession\(\): void \{([\s\S]*?)\n\}/)?.[1];
if (handler === undefined) throw new Error("SessionRail newSession handler not found");
const newSession = new Function("router", "closeSession", handler) as (
  router: ReturnType<typeof createRouter>,
  close: typeof closeSession,
) => void;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const previous = { activeId: sessions.activeId, stream: sessions.stream };
afterEach(() => {
  sessions.activeId = previous.activeId;
  sessions.stream = previous.stream;
});

async function fixture(allow: boolean) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/sessions/:sessionId?", component: { render: () => null } }],
  });
  await router.push("/sessions/session-old");
  sessions.activeId = "session-old";
  sessions.stream = createSessionStream({ sessionId: "session-old", send: () => {} }).state();
  const stream = sessions.stream;
  const entered = deferred();
  const release = deferred();
  router.beforeEach(async () => {
    entered.resolve();
    await release.promise;
    return allow;
  });
  const finished = deferred();
  router.afterEach(() => finished.resolve());
  return { router, stream, entered, release, finished };
}

describe("SessionRail new-session navigation", () => {
  test("keeps the current journal while the navigation guard is pending", async () => {
    const fixtureState = await fixture(true);
    const { router, stream, entered, release, finished } = fixtureState;
    try {
      newSession(router, closeSession);
      await entered.promise;
      expect(router.currentRoute.value.path).toBe("/sessions/session-old");
      expect(sessions.activeId).toBe("session-old");
      expect(sessions.stream).toBe(stream);
    } finally {
      release.resolve();
      await finished.promise;
    }
    expect(router.currentRoute.value.path).toBe("/sessions");
  });

  test("keeps the current journal when navigation is cancelled", async () => {
    const { router, stream, entered, release, finished } = await fixture(false);
    try {
      newSession(router, closeSession);
      await entered.promise;
    } finally {
      release.resolve();
      await finished.promise;
    }
    expect(router.currentRoute.value.path).toBe("/sessions/session-old");
    expect(sessions.activeId).toBe("session-old");
    expect(sessions.stream).toBe(stream);
  });
});
