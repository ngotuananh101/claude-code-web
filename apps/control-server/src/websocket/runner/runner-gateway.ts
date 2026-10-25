/**
 * Runner gateway (§6.2, §6.3, §14.3).
 *
 * The single place where a Runner connection becomes state. It is deliberately
 * transport-agnostic: `Bun.serve`'s websocket handlers are thin adapters around
 * these four methods, so the fencing logic is testable without a socket.
 *
 * Four rules, in order:
 *
 *  1. **Authenticate on open, before any message.** A socket that fails this is
 *     closed immediately; nothing it sends is parsed.
 *  2. **Every message is fenced by generation.** A superseded socket cannot
 *     affect state, even while it is still open (§6.3).
 *  3. **A hello yields `connected`, not `ready`.** Only a successful
 *     reconciliation promotes the connection (§14.3).
 *  4. **Revocation is terminal.** A revoked runner cannot reconnect with the
 *     credential it still holds.
 */

import {
  ConnectionRegistry,
  type DeclaredWorkspace,
  EVENT_TYPES,
  negotiateHello,
  PROTOCOL_VERSION,
  parseDeclaredWorkspaces,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerRunState,
  RunRegistry,
  reconcile,
  type ServerPolicy,
  toServerRunState,
} from "@cc-web/protocol";

export type RunnerSocketData = {
  connectionId: string;
  generation: number;
  runnerId: string;
  authenticated: boolean;
};

export type CredentialCheck =
  | { ok: true; runnerId: string; ownerId: string }
  | { ok: false; reason: "unknown" | "revoked" };

export type GatewayState = "offline" | "connected" | "ready" | "revoked";

export type RefusalReason =
  | "not_negotiated"
  | "already_negotiated"
  | "not_ready"
  | "unknown_message";

export type HandleResult =
  | { ok: true }
  | {
      ok: false;
      reason: "unauthorized" | "malformed" | "stale_generation" | "unknown_command" | RefusalReason;
    };

export type SendCommandResult =
  | { ok: true }
  | { ok: false; reason: "offline" | "not_ready" | "revoked" };

/** A runner's answer to a command (§9.4). Only the inbox has been reached yet. */
export type CommandReceipt = {
  commandId: string;
  attemptId: string;
  accepted: boolean;
  reason?: string;
};

type Connection = {
  connectionId: string;
  generation: number;
  socket: RunnerSocket;
  negotiated: boolean;
  state: "connected" | "ready";
};

/** The subset of `ServerWebSocket` used here; keeps tests free of a real server. */
export type RunnerSocket = {
  readonly data: RunnerSocketData;
  send(payload: string): unknown;
  close(code?: number): unknown;
};

type GatewayOptions = {
  policy: ServerPolicy;
  verifyCredential: (credential: string) => CredentialCheck;
  /** Injected so the default `ConnectionRegistry` can be shared with other modules. */
  connections?: ConnectionRegistry;
  /**
   * The server's own view of the work. Reconciliation reads it, so a runner
   * cannot talk the server into a different inventory than the one it holds.
   */
  runs?: RunRegistry;
  /**
   * Called after a successful reconciliation promotes the runner, and only
   * then: §14.3 step 6 says ready first, dispatch second. The hook exists so the
   * drain lives in the dispatcher rather than in the gateway's message loop.
   */
  onReady?: (runnerId: string) => void;
  /**
   * Called for every receipt a runner sends. Injected rather than handled here
   * because delivery state belongs to the outbox, and this class deliberately
   * knows nothing about a database.
   */
  onReceipt?: (runnerId: string, receipt: CommandReceipt) => void;
  /**
   * Called with a validated batch of runner events (§12.2). Returns the
   * per-attempt watermarks the journal can acknowledge through, which the
   * gateway relays as `events.ack` frames. The hook owns the journal because
   * this class deliberately knows nothing about a database.
   */
  onEvents?: (
    runnerId: string,
    events: RunnerEvent[],
  ) => Array<{ attemptId: string; through: number }>;
  /**
   * Called when reconciliation decides a run's approval gate is gone while the
   * projection still says pending (`abandon_approval`, §14.3). The projection
   * owns the rows, so — like every other hook here — this class deliberately
   * knows nothing about a database.
   */
  onAbandonApproval?: (runnerId: string, action: { runId: string; attemptId: string }) => void;
  /**
   * Called with the workspaces a runner declares (§15.1) on every successful
   * hello and reconcile. The projection replaces the runner's rows wholesale,
   * so a boot that stops declaring a workspace loses its row.
   */
  onWorkspaces?: (runnerId: string, workspaces: DeclaredWorkspace[]) => void;
};

/** What a successful authorization hands to the socket that carries it. */
export type Grant = RunnerSocketData;

export type AuthorizeResult =
  | { ok: true; grant: Grant }
  | { ok: false; reason: "unauthorized" | "revoked"; closeCode: number };

const CLOSE_POLICY = 1008;
const CLOSE_UNSUPPORTED = 1003;
/** Superseded by a newer connection; the runner should not reconnect with this socket. */
const CLOSE_SUPERSEDED = 4000;
/** Credential revoked; reconnecting with the same credential will not help. */
const CLOSE_REVOKED = 4001;

export class RunnerGateway {
  readonly #policy: ServerPolicy;
  readonly #verifyCredential: (credential: string) => CredentialCheck;
  readonly #connections: ConnectionRegistry;
  readonly #runs: RunRegistry;
  readonly #onReady: ((runnerId: string) => void) | undefined;
  readonly #onReceipt: ((runnerId: string, receipt: CommandReceipt) => void) | undefined;
  readonly #onEvents:
    | ((runnerId: string, events: RunnerEvent[]) => Array<{ attemptId: string; through: number }>)
    | undefined;
  readonly #onAbandonApproval:
    | ((runnerId: string, action: { runId: string; attemptId: string }) => void)
    | undefined;
  readonly #onWorkspaces: ((runnerId: string, workspaces: DeclaredWorkspace[]) => void) | undefined;
  readonly #live = new Map<string, Connection>();

  constructor(options: GatewayOptions) {
    this.#policy = options.policy;
    this.#verifyCredential = options.verifyCredential;
    this.#connections = options.connections ?? new ConnectionRegistry();
    this.#runs = options.runs ?? new RunRegistry();
    this.#onReady = options.onReady;
    this.#onReceipt = options.onReceipt;
    this.#onEvents = options.onEvents;
    this.#onAbandonApproval = options.onAbandonApproval;
    this.#onWorkspaces = options.onWorkspaces;
  }

  /**
   * Authenticate without a socket. Called before `upgrade()` so an unauthorized
   * client gets an HTTP 401 rather than an established connection that is closed
   * a moment later.
   *
   * Opening a generation is part of authorizing — a successful check is what
   * makes this connection the current one.
   */
  authorize(headers: Record<string, string | undefined>): AuthorizeResult {
    const credential = bearerToken(headers);
    if (!credential) {
      return { ok: false, reason: "unauthorized", closeCode: CLOSE_POLICY };
    }

    const check = this.#verifyCredential(credential);
    if (!check.ok) {
      // Deliberately one reason for "unknown" and "expired": the client learns
      // that the credential is useless, not which half of it was wrong.
      return { ok: false, reason: "unauthorized", closeCode: CLOSE_POLICY };
    }

    const opened = this.#connections.open({
      runnerId: check.runnerId,
      // Not known until hello; the generation, not the bootId, is what fences.
      bootId: "",
      connectionId: newConnectionId(),
    });

    if (!opened.ok) {
      return { ok: false, reason: "revoked", closeCode: CLOSE_REVOKED };
    }

    return {
      ok: true,
      grant: {
        connectionId: this.#connections.current(check.runnerId)!.connectionId,
        generation: opened.generation,
        runnerId: check.runnerId,
        authenticated: true,
      },
    };
  }

  handleOpen(socket: RunnerSocket, headers: Record<string, string | undefined>): HandleResult {
    const authorized = this.authorize(headers);
    if (!authorized.ok) {
      this.#reject(socket, authorized.reason, authorized.closeCode);
      return { ok: false, reason: "unauthorized" };
    }

    this.attach(socket, authorized.grant);
    return { ok: true };
  }

  /** Register a socket whose grant came from `authorize()` during the upgrade. */
  attach(socket: RunnerSocket, grant: Grant): void {
    Object.assign(socket.data, grant);

    const previous = this.#live.get(grant.runnerId);

    this.#live.set(grant.runnerId, {
      connectionId: grant.connectionId,
      generation: grant.generation,
      socket,
      negotiated: false,
      state: "connected",
    });

    // Close the socket this one replaced, rather than waiting for it to speak.
    // A stale runner that never sends another message would otherwise stay
    // connected and believe it is ready, while the server has already given its
    // identity to someone else (§6.3). Close code 4000 tells it not to retry.
    if (previous && previous.connectionId !== grant.connectionId) {
      this.#reject(previous.socket, "stale_generation", CLOSE_SUPERSEDED);
    }
  }

  handleMessage(socket: RunnerSocket, raw: string | Uint8Array): HandleResult {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      // A peer that cannot produce JSON is not going to recover mid-connection.
      this.#reject(socket, "malformed", CLOSE_UNSUPPORTED);
      return { ok: false, reason: "malformed" };
    }

    if (!socket.data.authenticated || socket.data.runnerId === "") {
      this.#reject(socket, "unauthorized", CLOSE_POLICY);
      return { ok: false, reason: "unauthorized" };
    }

    const fence = this.#connections.checkTraffic({
      runnerId: socket.data.runnerId,
      connectionId: socket.data.connectionId,
      generation: socket.data.generation,
    });

    if (!fence.ok) {
      // The old socket is alive but no longer authoritative. Tell it why so a
      // well-behaved runner stops reconnecting with a dead connection.
      this.#reject(socket, "stale_generation", CLOSE_SUPERSEDED);
      return { ok: false, reason: "stale_generation" };
    }

    const connection = this.#live.get(socket.data.runnerId);
    if (!connection || connection.connectionId !== socket.data.connectionId) {
      this.#reject(socket, "stale_generation", CLOSE_SUPERSEDED);
      return { ok: false, reason: "stale_generation" };
    }

    if (typeof message !== "object" || message === null) {
      this.#reject(socket, "malformed", CLOSE_UNSUPPORTED);
      return { ok: false, reason: "malformed" };
    }

    const record = message as Record<string, unknown>;

    // Before negotiation, `hello` is the only legal message. Checking this here
    // rather than per-branch keeps the ordering unambiguous: a pre-hello
    // `reconcile` is refused for the right reason, not as an unknown type.
    if (!connection.negotiated && record["type"] !== "hello") {
      return this.#refuse(connection, "not_negotiated");
    }

    switch (record["type"]) {
      case "hello":
        return this.#handleHello(connection, record["hello"]);

      case "reconcile":
        return this.#handleReconcile(connection, record);

      case "command.receipt":
        return this.#handleReceipt(connection, record);

      case "events":
        return this.#handleEvents(connection, record["events"]);

      default:
        // Unknown message types are refused rather than ignored: silently
        // dropping one is how a command goes unexecuted while looking delivered.
        return this.#refuse(connection, "unknown_message");
    }
  }

  handleClose(socket: RunnerSocket): void {
    if (!socket.data.authenticated) return;

    this.#connections.close({
      runnerId: socket.data.runnerId,
      connectionId: socket.data.connectionId,
      generation: socket.data.generation,
    });

    // Only drop the live entry if it is this socket; a stale close must not
    // evict the connection that replaced it.
    const live = this.#live.get(socket.data.runnerId);
    if (live?.connectionId === socket.data.connectionId) {
      this.#live.delete(socket.data.runnerId);
    }
  }

  /**
   * How many times each runner has been promoted to `ready`. A reconnect that
   * reaches `ready` and then drops is invisible to a later `stateOf()` — it
   * reads `offline` — so the fact has to be counted as it happens.
   */
  readonly promotions = new Map<string, number>();

  /** Revocation is driven by the control plane, not by the runner. */
  revoke(runnerId: string): void {
    this.#connections.revoke(runnerId);

    const live = this.#live.get(runnerId);
    this.#live.delete(runnerId);
    if (live) {
      this.#reject(live.socket, "revoked", CLOSE_REVOKED);
    }
  }

  stateOf(runnerId: string): GatewayState {
    if (this.#connections.isRevoked(runnerId)) return "revoked";
    const live = this.#live.get(runnerId);
    if (!live) return "offline";
    return live.state;
  }

  /**
   * The generation currently owning this runner, or undefined when nothing is
   * connected. Exposed because the generation is the only way to tell "the
   * runner reconnected" from "the same socket is still talking".
   */
  generationOf(runnerId: string): number | undefined {
    return this.#connections.current(runnerId)?.generation;
  }

  /**
   * Hand a command to a runner's current socket (§9.2).
   *
   * Refuses anything that is not `ready`. The distinction matters: a `connected`
   * runner has negotiated but not reconciled, so its view of what is running may
   * differ from the server's, and work sent there can land on state neither side
   * can vouch for (§6.2).
   *
   * A successful return means the bytes were handed to the socket. It is not a
   * receipt: the write can still be lost, which is why the caller keeps the
   * command deliverable.
   */
  sendCommand(runnerId: string, command: RunnerCommand): SendCommandResult {
    if (this.#connections.isRevoked(runnerId)) return { ok: false, reason: "revoked" };

    const connection = this.#live.get(runnerId);
    if (!connection) return { ok: false, reason: "offline" };
    if (connection.state !== "ready") return { ok: false, reason: "not_ready" };

    // The frame carries the envelope under `command`, matching the message shape
    // the runner's loop already switches on.
    const payload = JSON.stringify({ type: "command", command });
    try {
      connection.socket.send(payload);
    } catch {
      // The socket died between the state check and the write. Report it as
      // offline so the caller leaves the command pending rather than marking a
      // send that never happened.
      return { ok: false, reason: "offline" };
    }

    return { ok: true };
  }

  #handleHello(connection: Connection, hello: unknown): HandleResult {
    if (connection.negotiated) {
      // A second hello on one connection would silently re-scope the policy
      // mid-session; require a new connection instead.
      return this.#refuse(connection, "already_negotiated");
    }

    const result = negotiateHello(hello, this.#policy);
    if (!result.ok) {
      this.#send(connection, { type: "error", reason: result.reason, detail: result.detail });
      return { ok: false, reason: "malformed" };
    }

    connection.negotiated = true;
    // Still `connected`: §14.3 requires reconciliation before any dispatch.
    connection.state = "connected";

    // §15.1: the hello carries the boot's full declaration. Handed over before
    // hello.ok — a declaration the server refused to store must not be visible
    // in a frame that says "negotiated".
    this.#onWorkspaces?.(connection.socket.data.runnerId, result.workspaces);

    this.#send(connection, {
      type: "hello.ok",
      negotiation: result.negotiation,
      generation: connection.generation,
      connectionState: result.connectionState,
    });

    return { ok: true };
  }

  /**
   * The runner sends its inventory; the server contributes its own. Reconciling
   * against the server's registry rather than the runner's payload is what stops
   * a reconnecting runner from rewriting server state (§14.3).
   */
  #handleReconcile(connection: Connection, message: Record<string, unknown>): HandleResult {
    const runnerId = connection.socket.data.runnerId;
    const runner = asArray<RunnerRunState>(message["runner"]);

    if (!runner) {
      this.#send(connection, { type: "error", reason: "malformed" });
      return { ok: false, reason: "malformed" };
    }

    // §15.1: every reconcile re-carries the boot's declaration, so a changed
    // one takes effect on the next reconnect without a restart. Malformed is
    // refused before promotion — placement must never read a partial sync.
    const workspaces = parseDeclaredWorkspaces(message["workspaces"]);
    if (workspaces === undefined) {
      this.#send(connection, { type: "error", reason: "malformed" });
      return { ok: false, reason: "malformed" };
    }
    this.#onWorkspaces?.(runnerId, workspaces);

    // Stored even when reconciliation then blocks (contradictory_inventory):
    // a blocked runner is never `ready`, so placement cannot act on it.

    const result = reconcile({
      server: this.#serverInventory(connection),
      runner,
    });

    if (!result.ready) {
      // Do not promote, and do not apply: contradictory evidence must not be
      // resolved by picking a side. The runner stays connected so an operator
      // can resolve it without a reconnect.
      this.#send(connection, { type: "reconcile.blocked", reason: result.blockedReason });
      return { ok: true };
    }

    for (const action of result.actions) {
      this.#runs.apply(action);
      // The registry's apply covers run state; an abandoned approval is the
      // projection's to close, and it reaches the projection through the hook.
      if (action.kind === "abandon_approval") {
        this.#onAbandonApproval?.(runnerId, { runId: action.runId, attemptId: action.attemptId });
      }
    }

    connection.state = "ready";
    this.promotions.set(runnerId, (this.promotions.get(runnerId) ?? 0) + 1);
    // Only the promotion is sent back. Actions are server-side; echoing them
    // would invite the runner to act on decisions it did not make.
    this.#send(connection, { type: "reconcile.ok", ready: true });

    // §14.3 step 6: ready first, dispatch second. The hook runs after the
    // promotion message, so a command can never overtake the promotion on the
    // wire — the runner would otherwise receive work before it is dispatchable.
    this.#onReady?.(runnerId);

    return { ok: true };
  }

  /**
   * A runner's answer to a command (§9.4).
   *
   * `accepted` only proves the inbox persisted it; execution is a later event.
   * The delivery state still has to move, or the outbox would offer the same
   * command forever and the runner would keep returning the same receipt.
   */
  #handleReceipt(connection: Connection, message: Record<string, unknown>): HandleResult {
    const commandId = message["commandId"];
    const attemptId = message["attemptId"];
    const accepted = message["accepted"];

    if (
      typeof commandId !== "string" ||
      commandId === "" ||
      typeof attemptId !== "string" ||
      attemptId === "" ||
      typeof accepted !== "boolean"
    ) {
      this.#send(connection, { type: "error", reason: "malformed" });
      return { ok: false, reason: "malformed" };
    }

    const reason = typeof message["reason"] === "string" ? message["reason"] : undefined;

    if (this.#onReceipt) {
      // An unknown command id is a protocol error rather than something to
      // record: accepting it would create delivery state for a command nothing
      // enqueued. The handler decides, because it owns the outbox.
      try {
        this.#onReceipt(connection.socket.data.runnerId, {
          commandId,
          attemptId,
          accepted,
          ...(reason === undefined ? {} : { reason }),
        });
      } catch {
        this.#send(connection, { type: "error", reason: "unknown_command" });
        return { ok: false, reason: "unknown_command" };
      }
    }

    return { ok: true };
  }

  /**
   * A batch of events from a ready runner (§12.2).
   *
   * Validation is structural and about identity: every field the journal keys
   * on must be present and typed, the event type must be one the protocol
   * defines, and the claimed runner id must be the authenticated one — a
   * journal is a durable public record (§12.3), so nothing unvalidated is
   * written into it and nobody writes under someone else's name (§19.2).
   */
  #handleEvents(connection: Connection, raw: unknown): HandleResult {
    if (connection.state !== "ready") {
      // Same stance as dispatch: a runner whose reconciliation has not
      // succeeded cannot vouch for what it reports.
      return this.#refuse(connection, "not_ready");
    }

    const runnerId = connection.socket.data.runnerId;
    const events = asValidatedEvents(raw, runnerId);
    if (!events) {
      this.#send(connection, { type: "error", reason: "malformed_event" });
      return { ok: false, reason: "malformed" };
    }

    if (!this.#onEvents) {
      return this.#refuse(connection, "unknown_message");
    }

    let acks: Array<{ attemptId: string; through: number }>;
    try {
      acks = this.#onEvents(runnerId, events);
    } catch {
      // The journal refused the batch. No ACK: the runner keeps the rows
      // pending and resends, which is exactly the at-least-once contract.
      this.#send(connection, { type: "error", reason: "ingest_failed" });
      return { ok: false, reason: "malformed" };
    }

    for (const ack of acks) {
      this.#send(connection, {
        type: "events.ack",
        attemptId: ack.attemptId,
        through: ack.through,
      });
    }
    return { ok: true };
  }

  #serverInventory(connection: Connection): Array<ReturnType<typeof toServerRunState>> {
    // Scoped to this runner's sessions. A registry shared across runners would
    // otherwise reconcile work belonging to someone else.
    const inventory: Array<ReturnType<typeof toServerRunState>> = [];
    for (const run of this.#runs.runsFor(connection.socket.data.runnerId)) {
      inventory.push(toServerRunState(run));
    }
    return inventory;
  }

  #refuse(connection: Connection, reason: RefusalReason): HandleResult {
    this.#send(connection, { type: "error", reason });
    return { ok: false, reason };
  }

  #reject(socket: RunnerSocket, reason: string, code: number): void {
    try {
      socket.send(JSON.stringify({ type: "error", reason }));
    } catch {
      // The socket may already be gone; the close below is what matters.
    }
    try {
      socket.close(code);
    } catch {
      // Idempotent from the caller's point of view.
    }
  }

  #send(connection: Connection, payload: Record<string, unknown>): void {
    try {
      connection.socket.send(JSON.stringify(payload));
    } catch {
      // A failed send surfaces as a close; nothing to do here.
    }
  }
}

function bearerToken(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (typeof raw !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

function newConnectionId(): string {
  return `conn_${crypto.randomUUID()}`;
}

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Structural + identity validation of an events frame body. Returns the typed
 * events, or undefined when anything the journal keys on is missing, mistyped,
 * invented, or claimed under another runner's identity.
 */
function asValidatedEvents(raw: unknown, authenticatedRunnerId: string): RunnerEvent[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const events: RunnerEvent[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;

    if (
      record["protocolVersion"] !== PROTOCOL_VERSION ||
      typeof record["eventId"] !== "string" ||
      record["eventId"] === "" ||
      typeof record["bootId"] !== "string" ||
      record["bootId"] === "" ||
      typeof record["sessionId"] !== "string" ||
      record["sessionId"] === "" ||
      typeof record["runId"] !== "string" ||
      record["runId"] === "" ||
      typeof record["attemptId"] !== "string" ||
      record["attemptId"] === "" ||
      typeof record["localSequence"] !== "number" ||
      !Number.isInteger(record["localSequence"]) ||
      record["localSequence"] < 1 ||
      typeof record["occurredAt"] !== "string" ||
      record["occurredAt"] === "" ||
      typeof record["type"] !== "string" ||
      !EVENT_TYPE_SET.has(record["type"])
    ) {
      return undefined;
    }

    // The credential authenticated this connection; the payload's claim about
    // who is speaking must agree with it or the event is someone else's.
    if (record["runnerId"] !== authenticatedRunnerId) return undefined;

    events.push({
      protocolVersion: PROTOCOL_VERSION,
      eventId: record["eventId"],
      runnerId: record["runnerId"] as string,
      bootId: record["bootId"],
      sessionId: record["sessionId"],
      runId: record["runId"],
      attemptId: record["attemptId"],
      localSequence: record["localSequence"],
      occurredAt: record["occurredAt"],
      type: record["type"] as RunnerEvent["type"],
      payload: record["payload"] ?? null,
    });
  }
  return events;
}
