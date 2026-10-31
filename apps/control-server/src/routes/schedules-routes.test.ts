import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelScheduleForOwner,
  ensureSessionPin,
  migrate,
  projectScheduleEvent,
} from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The browser-facing schedule surface (§11.5): list a session's active
 * schedules, cancel one by id. Both are owner-scoped — a foreign owner gets the
 * same 404 an unknown id gets, so neither route leaks existence.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function start() {
  const db = new Database(":memory:");
  migrate(db);
  for (const id of ["user-1", "user-2"]) {
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, id, "hash", 1, Date.now());
  }

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: () => ({ ok: false, reason: "unknown" }),
    // The scheduling loop's immediate first tick sees no rows: the fixtures
    // are seeded after the server exists, and the interval is out of reach.
    scheduleTickMs: 60_000,
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie, auth };
}

function pin(db: Database, sessionId = "session-1", ownerId = "user-1"): void {
  ensureSessionPin(db, {
    sessionId,
    ownerId,
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
}

type SeedOverrides = {
  sessionId?: string;
  attemptId?: string;
  toolCallId?: string;
};

function seedSchedule(db: Database, overrides: SeedOverrides = {}): string {
  const attemptId = overrides.attemptId ?? "attempt-1";
  const toolCallId = overrides.toolCallId ?? "toolu_1";
  projectScheduleEvent(
    db,
    {
      type: "schedule.created",
      sessionId: overrides.sessionId ?? "session-1",
      attemptId,
      payload: {
        toolCallId,
        cliTaskId: "af5c4b05",
        cron: "58 17 31 10 *",
        recurring: false,
        prompt: "Kiểm tra dung lượng ổ đĩa",
        nextFireAt: 1793444280000,
        timezone: "Asia/Ho_Chi_Minh",
      },
    },
    "runner-a",
  );
  return `sched_${attemptId}_${toolCallId}`;
}

function list(url: string, sessionId: string, headers: Record<string, string>) {
  return fetch(`${url}/api/sessions/${sessionId}/schedules`, { headers });
}

function cancel(url: string, scheduleId: string, headers: Record<string, string>) {
  return fetch(`${url}/api/schedules/${scheduleId}`, { method: "DELETE", headers });
}

describe("GET /api/sessions/:id/schedules", () => {
  test("lists the owner's active schedules for a session", async () => {
    const { db, url, cookie } = await start();
    pin(db);
    const scheduleId = seedSchedule(db);

    const response = await list(url, "session-1", { Origin: origin, Cookie: cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { schedules: Array<Record<string, unknown>> };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toMatchObject({
      scheduleId,
      sessionId: "session-1",
      cron: "58 17 31 10 *",
      timezone: "Asia/Ho_Chi_Minh",
      recurring: false,
      prompt: "Kiểm tra dung lượng ổ đĩa",
      nextFireAt: 1793444280000,
      state: "active",
    });
  });

  test("answers 404 for a session the caller does not own", async () => {
    const { db, url, cookie } = await start();
    pin(db, "session-2", "user-2");
    seedSchedule(db, { sessionId: "session-2" });

    const response = await list(url, "session-2", { Origin: origin, Cookie: cookie });

    expect(response.status).toBe(404);
  });

  test("answers 401 without a cookie and 403 for a foreign Origin", async () => {
    const { db, url, cookie } = await start();
    pin(db);

    expect((await list(url, "session-1", { Origin: origin })).status).toBe(401);
    expect(
      (await list(url, "session-1", { Origin: "https://evil.example.test", Cookie: cookie }))
        .status,
    ).toBe(403);
  });

  test("excludes cancelled and done rows", async () => {
    const { db, url, cookie } = await start();
    pin(db);
    const cancelledId = seedSchedule(db, { attemptId: "attempt-1", toolCallId: "toolu_1" });
    const activeId = seedSchedule(db, { attemptId: "attempt-2", toolCallId: "toolu_2" });
    expect(cancelScheduleForOwner(db, cancelledId, "user-1")).toBe(true);

    const response = await list(url, "session-1", { Origin: origin, Cookie: cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { schedules: Array<{ scheduleId: string }> };
    expect(body.schedules.map((schedule) => schedule.scheduleId)).toEqual([activeId]);
  });
});

describe("DELETE /api/schedules/:id", () => {
  test("cancels an active schedule", async () => {
    const { db, url, cookie } = await start();
    pin(db);
    const scheduleId = seedSchedule(db);

    const response = await cancel(url, scheduleId, { Origin: origin, Cookie: cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const row = db
      .query("SELECT state FROM scheduled_tasks WHERE schedule_id = ?")
      .get(scheduleId) as { state: string };
    expect(row.state).toBe("cancelled");
  });

  test("answers 404 for an unknown or foreign schedule", async () => {
    const { db, url, cookie } = await start();
    pin(db);
    pin(db, "session-2", "user-2");
    const foreignId = seedSchedule(db, { sessionId: "session-2" });

    const unknown = await cancel(url, "sched_never_seen", { Origin: origin, Cookie: cookie });
    const foreign = await cancel(url, foreignId, { Origin: origin, Cookie: cookie });

    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    const row = db
      .query("SELECT state FROM scheduled_tasks WHERE schedule_id = ?")
      .get(foreignId) as { state: string };
    expect(row.state).toBe("active");
  });
});
