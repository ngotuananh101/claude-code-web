/**
 * Runner daemon entrypoint.
 *
 * Coordinates connection, inbox/outbox, workspace locks and the process
 * supervisor. SDK invocations run in separate worker processes (§3.3, §10).
 */

import { claudeCliKind } from "@cc-web/agent-adapter";
import { PROTOCOL_VERSION } from "@cc-web/protocol";

export const runnerInfo = {
  name: "cc-web-runner",
  protocolVersion: PROTOCOL_VERSION,
  cliMode: claudeCliKind(),
} as const;
