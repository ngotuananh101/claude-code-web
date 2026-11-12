# Runner build variants: bundled vs. externally installed Claude Code

Status: Draft for review, 2026-11-10.

## 1. Intent and why

Every runner build today embeds the Claude Agent SDK's native CLI binary
(`@anthropic-ai/claude-agent-sdk-<platform>`, ~293 MB) into the compiled
executable. `dist/cc-web-runner` on this machine is 386 MB. Operators
download that binary to every runner host, even hosts that already have
Claude Code installed for their own use.

The owner wants two build variants from the same source:

- **slim (new default)** — no embedded CLI; the runner uses the `claude`
  already installed on the host.
- **bundled** — today's behavior, for offline or fully self-contained hosts.

And a user-facing consequence the owner asked for explicitly: when a slim
runner is set up on a host without Claude Code, the `setup` command must say
so and print the official install instructions instead of silently writing
an identity that can never run anything.

## 2. Goals

- `bun run build:runner` produces the slim binary by default;
  `bun run build:runner --with-cli` produces the bundled binary.
- The slim binary never contains the ~293 MB CLI and still runs a real agent
  when the host has a supported `claude` on disk.
- `setup` on a slim runner refuses to write an identity when no usable CLI is
  found, printing platform-correct install commands and the minimum version.
- `connect`, and `service install` (which writes the systemd/Windows task),
  refuse to run when a slim runner's CLI is missing, with the same guidance
  and the same `--skip-cli-check` escape hatch.
- The CLI path is resolved deterministically for a service process too, where
  `PATH` does not include `~/.local/bin`.
- A Claude Code older than the SDK's own bundled CLI version is refused with
  an upgrade instruction (`claude update`).
- Both variants advertise the same protocol, capabilities, models and
  behavior on the wire. Nothing about the control plane changes.

## 3. Non-goals

- Advertising the CLI mode/version in the runner hello. The wire protocol is
  unchanged; mode is visible in the boot log and in `--version` output only.
  If operators later need it on the Runners page, that is a separate protocol
  change.
- Bundling a CLI *downloader* into the slim binary (fetching `claude` on first
  boot). The slim build stays offline-installable and predictable.
- Changing the Docker integration image (`infra/docker/Dockerfile.runner`),
  which runs from source with the mounted workspace and keeps using the
  embedded/bundled path.
- Changing the web setup instructions in `RunnersView.vue`. It already says
  to run `cc-web-runner setup`; the guidance lives in the CLI's output.
- Auto-detecting or installing Claude Code for the user.

## 4. Constraints

- `packages/agent-adapter` stays the only module importing
  `@anthropic-ai/claude-agent-sdk` (§4.2).
- The generated shim (`packages/agent-adapter/src/claude-asset.generated.ts`)
  is gitignored and regenerated on every `bun install` and every
  `build:runner`; the asset specifier must remain static for the bundler.
- The compiled binary cannot let the SDK resolve its own packaged CLI
  (`$bunfs` resolution fails), so any non-embedded mode must pass an explicit
  `pathToClaudeCodeExecutable`.
- No new dependency; `Bun.which` and `node:child_process` are enough.
- Company docs and code stay English (repo convention); conversation is
  Vietnamese.

## 5. Decisions the owner made

| Decision | Choice |
| --- | --- |
| Slim `setup` with no CLI | Block setup, print install guidance, exit 1; `--skip-cli-check` escape hatch for "install the CLI later" |
| Build naming/UX | Default is slim; `--with-cli` opts into the bundled build. Artifacts: `cc-web-runner-<os>-<arch>` (slim) and `cc-web-runner-bundled-<os>-<arch>` |
| Version gate | Refuse a CLI below the SDK's bundled version; tell the operator to run `claude update` |
| `service install` with no CLI | Refuse like `setup`, with the same `--skip-cli-check` escape hatch |

## 6. Design

### 6.1. Build-time switch: the generated shim carries the mode

`scripts/claude-asset.ts` currently writes one line per target:

```ts
import binPath from "@anthropic-ai/claude-agent-sdk-linux-x64/claude" with { type: "file" };
export default binPath;
```

It becomes a discriminated union with two shapes:

```ts
// bundled
import binPath from "@anthropic-ai/claude-agent-sdk-linux-x64/claude" with { type: "file" };
export const asset = { kind: "embedded", binPath } as const;
```

```ts
// slim
export const asset = { kind: "external" } as const;
```

`generateShim(target, variant)` gains the variant parameter. Keeping the
import out of the slim shim is what makes the bundler exclude the platform
package at all — a static import would embed it regardless of any runtime
flag.

`packages/agent-adapter/src/claude-asset.ts` exposes:

- `claudeCliKind(): "embedded" | "external"`
- `embeddedCliPath(): string | undefined` — `extractFromBunfs` for the
  embedded case, `undefined` otherwise.

`createSdkStream` sets `pathToClaudeCodeExecutable` only when a path is
known: the caller's explicit path, else `embeddedCliPath()`. In external mode
with no explicit path the option is omitted so the SDK's own resolution keeps
working when the adapter runs from source (dev, Docker probe). A compiled
slim binary always passes an explicit path (see 6.2), because the SDK's
resolution cannot see the host there anyway.

### 6.2. Runtime resolution of the host CLI

New module `apps/runner/src/execution/claude-cli.ts`, pure and injected:

```ts
export type ResolveClaudeCliInput = {
  kind: "embedded" | "external";
  env: Record<string, string | undefined>;
  home: string;
  platform: string;
  /** Injected: Bun.which in production, a fake in tests. */
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
};

export type ResolvedClaudeCli =
  | { ok: true; mode: "embedded" | "external"; path: string }
  | { ok: false; reason: "missing" | "override-invalid"; guidance: string };
```

Resolution order (external mode only):

1. `CC_WEB_CLAUDE_BIN` — an explicit path or command name. If set but not
   found, fail with `override-invalid`; never fall through, because a typo'd
   override that silently uses a different CLI is worse than an error.
2. `which("claude")` — the interactive shell's CLI.
3. Well-known install locations, because a systemd service has no
   `~/.local/bin` on `PATH`:
   - linux/macOS: `~/.local/bin/claude`, `~/.claude/local/claude`,
     `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/bin/claude`
   - Windows: `%USERPROFILE%\.local\bin\claude.exe`,
     `%LOCALAPPDATA%\Programs\claude\claude.exe`

In embedded mode the resolved path is the extracted asset and no host check
runs — a bundled runner is self-contained by definition.

### 6.3. Version gate

`claude --version` prints `2.1.322 (Claude Code)`. The resolver runs it with
a 5 s timeout, parses the first `x.y.z`, and compares numerically against
`MIN_CLAUDE_CLI_VERSION` (exported from
`packages/agent-adapter/src/claude-cli-version.ts`, currently `2.1.309` — the
version the installed SDK bundles, per the SDK's own `manifest.json`).

A unit test reads `node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`
and fails when the SDK is upgraded without bumping the constant. That is the
drift alarm: the SDK and its bundled CLI release in lockstep, so the constant
must move with the dependency.

Outcomes:

- CLI runs and is `>= MIN` → ok.
- CLI runs but is older → fail with `claude update` guidance.
- CLI missing / not executable / `--version` fails → fail with install
  guidance.

`CC_WEB_SKIP_CLI_CHECK=1` downgrades both failures to a printed warning and
lets the runner continue. `setup` also accepts `--skip-cli-check` as sugar
for that env var. The override exists so an operator can install the CLI
after the identity, or knowingly run an older CLI; it is documented in the
message that refuses them.

### 6.4. Where the checks fire

- `setup` (`apps/runner/src/bootstrap/main.ts` `case "setup"`): resolve
  before `runSetup`. In external mode with no usable CLI, print the guidance
  to stderr and exit 1 **without** writing `identity.json`. Order matters:
  the check precedes `saveIdentity` so a failed check leaves no half
  configuration.
- `connect` / `run`: resolve before the boot probes and `startDaemon`.
  Missing or too old → same guidance, exit 1 unless `--skip-cli-check`
  (or `CC_WEB_SKIP_CLI_CHECK=1`) was given.
- `service install`: same check, same refusal, same escape hatch. It runs
  before any unit/task file is written, so a refused install leaves nothing
  behind. `service print` never checks — it is pure text with no side
  effects.
- `startDaemon` receives the resolved path as a new optional
  `claudeCliPath?: string` and passes it to `createSdkStream`. The two boot
  probes (`discoverModels`, `discoverCapabilities`) are called from
  `main.ts` exactly where they are today and gain the same optional field;
  `daemon.ts` does not gain discovery, and `daemon.test.ts` is untouched.
  One resolution per process; the probes never re-resolve.

### 6.5. Guidance text (English, printed verbatim)

```
cc-web-runner (slim) needs Claude Code installed on this host.

  macOS / Linux:   curl -fsSL https://claude.ai/install.sh | bash
  Windows (PS):    irm https://claude.ai/install.ps1 | iex
  or npm:          npm install -g @anthropic-ai/claude-code

Then run `claude` once and log in, and re-run this command.
Installed somewhere else? Set CC_WEB_CLAUDE_BIN=/path/to/claude.
Minimum supported version: 2.1.309 — upgrade with `claude update`.
```

The version sentence appears only with the actual minimum substituted, so
there is one guidance builder, not two texts that drift.

### 6.6. Build script and release workflow

`scripts/build-runner.ts`:

- `parseArgs` gains `--with-cli` (boolean). Default `variant: "slim"`.
- `generateShim(target, variant)` runs before `bun build --compile`, exactly
  as today; the compile step is otherwise unchanged.
- Usage/comment updated to show both invocations.

`.github/workflows/runner-build.yml`:

- Matrix gains `variant: slim | bundled`; artifact names become
  `cc-web-runner-<os>-<arch>` and `cc-web-runner-bundled-<os>-<arch>`.
- "Install the target platform's SDK CLI" runs only for `variant == bundled`
  (`claude-target-asset.ts` is pointless for slim and would waste minutes
  downloading 293 MB).
- The smoke step stays on linux-x64 slim (the new default artifact).

CI (`.github/workflows/ci.yml`, `bun run test:integration`) has two probes
that compile the runner, and they serve different purposes:

- `scripts/integration/runner-binary.ts` exercises connector behaviors on the
  **default (slim)** artifact. Its `setup` assertions now pass
  `--skip-cli-check`, and it gains one assertion of its own: without the flag
  and with `PATH` cleared of `claude`, `setup` exits 1 and writes no identity.
- `scripts/integration/runner-agent-e2e.ts` exists specifically to prove the
  embedded-CLI path (docstring: "the asset is embedded at build time and
  extracted at first use"), so it compiles with `--with-cli` explicitly. No
  CI job installs Claude Code; nothing about CI's setup changes.

`postinstall` keeps generating the host **bundled** shim: dev machines and
tests run with the embedded CLI available, and only an explicit slim build
switches the shim. After a slim build the shim on disk stays `external`
until the next `bun install` or `build:runner`; both regenerate it, so the
switch cannot persist silently across a dependency change.

### 6.7. `--version` output

`runner --version` gains the mode so a host operator can tell which artifact
is installed:

```
cc-web-runner (protocol v1, cli bundled)
cc-web-runner (protocol v1, cli external)
```

## 7. Files touched (implementation inventory)

| File | Change |
| --- | --- |
| `scripts/claude-asset.ts` | `generateShim(target, variant)`; two shim shapes |
| `scripts/build-runner.ts` | `--with-cli`; default slim; pass variant |
| `scripts/claude-asset.test.ts` | both shim shapes |
| `packages/agent-adapter/src/claude-asset.ts` | `claudeCliKind`, `embeddedCliPath` |
| `packages/agent-adapter/src/claude-asset.test.ts` | branch on kind |
| `packages/agent-adapter/src/claude-cli-version.ts` | **new** — `MIN_CLAUDE_CLI_VERSION` |
| `packages/agent-adapter/src/claude-cli-version.test.ts` | **new** — drift vs SDK manifest |
| `packages/agent-adapter/src/index.ts` | omit `pathToClaudeCodeExecutable` when unknown |
| `packages/agent-adapter/src/index.test.ts` | updated default-path expectations |
| `apps/runner/src/execution/claude-cli.ts` | **new** — resolution + version gate |
| `apps/runner/src/execution/claude-cli.test.ts` | **new** |
| `apps/runner/src/execution/model-catalog.ts` | optional `claudeCliPath` |
| `apps/runner/src/execution/capability-catalog.ts` | optional `claudeCliPath` |
| `apps/runner/src/daemon.ts` | optional `claudeCliPath` → `createSdkStream` only |
| `apps/runner/src/bootstrap/main.ts` | setup/connect/service checks, resolve once, `--version` mode |
| `apps/runner/src/setup/setup.ts` | check injected as a dep, before `saveIdentity` |
| `apps/runner/src/setup/setup.test.ts` | blocked and skipped cases |
| `scripts/integration/runner-binary.ts` | default (slim) binary: setup refuses without CLI, and accepts with `--skip-cli-check` |
| `scripts/integration/runner-agent-e2e.ts` | builds with `--with-cli` explicitly — this probe exists to prove the embedded-CLI path |
| `.github/workflows/runner-build.yml` | variant matrix, artifact names |
| `docs/ARCHITECTURE.md` §7.1, §20.3, ADR table | revised decision + operational notes |
| `docs/adr/0017-runner-cli-variants.md` | **new** ADR |
| `docs/DEPLOYMENT.md` | build/download section, `CC_WEB_CLAUDE_BIN`, service PATH note |

## 8. Risks and how they are handled

- **Shim state leaks between builds.** A slim build leaves the shim
  `external`; a developer then runs `bun test` against a bundled expectation.
  Handled by: `claude-asset.test.ts` branching on kind, and both `bun
  install` and `build:runner` regenerating the shim.
- **Service cannot find the CLI.** systemd does not put `~/.local/bin` on
  `PATH`. Handled by the well-known-path fallback and the documented
  `CC_WEB_CLAUDE_BIN` override in `EnvironmentFile`.
- **SDK/CLI drift.** Guarded by the manifest-comparison test.
- **Host CLI newer than the SDK expects.** Not blocked: the docs' rule is
  "same patch or later", and a newer CLI is the normal state of an
  auto-updating install. Only older is refused.
- **Operator unknowingly runs a slim binary.** `setup`, `connect` and
  `service install` all refuse loudly; `--version` names the mode.

## 9. What is left to the builder

- Exact placement of the `service install` refusal message relative to its
  existing output (it must not print a half-written path list).
- Wording polish on the guidance block, as long as the commands and the
  `CC_WEB_CLAUDE_BIN` escape hatch stay.
