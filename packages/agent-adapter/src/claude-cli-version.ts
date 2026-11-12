/**
 * The oldest Claude Code CLI a slim runner accepts.
 *
 * The Agent SDK and the CLI it bundles release in lockstep (SDK 0.3.309 ships
 * CLI 2.1.309, per the SDK's own manifest.json), and the adapter sets options
 * — `effort`, `forwardSubagentText` — that older CLIs do not understand. A
 * host CLI newer than this floor is normal (native installs auto-update) and
 * is accepted; only older is refused.
 *
 * `claude-cli-version.test.ts` compares this constant with the installed SDK's
 * manifest, so an SDK bump that forgets it fails the suite instead of shipping.
 */
export const MIN_CLAUDE_CLI_VERSION = "2.1.309";
