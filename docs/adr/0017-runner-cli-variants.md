# ADR-0017 — Runner build variants: slim and bundled Claude Code

- Status: accepted
- Date: 2026-11-12
- Refines: ARCHITECTURE.md §7.1, §20.3; ADR-003

## Context

Every compiled runner binary previously embedded the Claude Agent SDK's native
platform CLI package (`@anthropic-ai/claude-agent-sdk-<platform>`, ~293 MB) via
a compile-time file asset import, producing binaries exceeding 380 MB. Operators
had to download this large binary to every runner host, including developer
machines and servers that already had Claude Code installed and authenticated.

Furthermore, single-executable binaries compiled with Bun (`bun build --compile`)
run inside an embedded virtual filesystem (`$bunfs`) where the SDK cannot
automatically resolve its packaged CLI at runtime. The runner must explicitly
provide `pathToClaudeCodeExecutable` to the SDK, either pointing to an extracted
asset or to a binary on the host.

While self-contained binaries are valuable for offline, air-gapped, or minimal
hosts, forcing a ~293 MB download onto hosts that already maintain their own
Claude Code installation wastes bandwidth, storage, and deployment time.

## Decision

The runner provides two build variants from the same codebase:

1. **slim (default)**: `bun run build:runner`. The compiled executable embeds
   no CLI binary. The generated shim (`claude-asset.generated.ts`) exports
   `{ kind: "external" }`, excluding the platform package from the bundle. The
   runner locates and uses the host's existing `claude` executable.
2. **bundled**: `bun run build:runner --with-cli`. The compiled executable embeds
   the target platform's SDK CLI package as a static file asset
   (`{ kind: "embedded", binPath }`) and extracts it at first use to a per-user
   cache directory (`0700`) via `extractFromBunfs`, identical to previous
   behavior. The `--with-cli` flag takes no value (`--with-cli=value` is
   rejected).

### Runtime host CLI resolution (slim variant)

When running the slim variant, the runner resolves the host CLI in strict
order:

1. `CC_WEB_CLAUDE_BIN` environment variable (an absolute path or bare command
   name). If set, this path is checked; if not found or not executable, the
   resolver immediately fails with an error and never falls through to subsequent
   steps (preventing accidental fallback caused by typos).
2. `Bun.which("claude")` on system `PATH`. A Windows `.cmd`, `.ps1`, or `.bat`
   wrapper (what `npm install -g @anthropic-ai/claude-code` creates) is
   recorded and skipped, not accepted: the SDK spawns the CLI as a native
   binary and cannot execute a script shim. Resolution continues to step 3.
3. Well-known standard installation directories. This covers service managers
   like systemd where the default `PATH` excludes `~/.local/bin`:
   - Linux and macOS: `~/.local/bin/claude`, `~/.claude/local/claude`,
     `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/bin/claude`.
   - Windows: `%USERPROFILE%\.local\bin\claude.exe`,
     `%LOCALAPPDATA%\Programs\claude\claude.exe`.

Bundled builds skip host resolution entirely, extract their embedded asset, and
report `cli embedded`.

### Version gate

The host CLI must meet or exceed `MIN_CLAUDE_CLI_VERSION = "2.1.309"`, which
matches the CLI version bundled by the installed `@anthropic-ai/claude-agent-sdk`
(derived from its `manifest.json`). A unit test asserts that this constant
remains synchronized with the SDK manifest across dependency upgrades.

If the host CLI is older than the minimum version, execution is refused with
guidance to run `claude update`. A newer CLI version is expected and accepted.

### Refusal semantics and escape hatch

`runner setup`, `runner connect` (alias `run`), and `runner service install`
enforce the CLI check:

- If no usable CLI is found or the CLI is below the minimum version, the
  command exits 1 with platform-specific installation instructions:
  - macOS / Linux: `curl -fsSL https://claude.ai/install.sh | bash`
  - Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`
  - npm: `npm install -g @anthropic-ai/claude-code` — with a caveat: on Windows
    npm creates a `claude.cmd` wrapper, which the SDK cannot spawn. A host whose
    only `claude` is that wrapper is refused with a distinct `shim-found`
    reason and guidance to install the native build; a host carrying both the
    wrapper and a native `claude.exe` resolves the native one.
- `runner setup` checks before saving `identity.json`, leaving no half-configured
  state on failure.
- `runner service install` checks before writing systemd unit or Windows task
  files.
- `service print` and `service uninstall` never check for a CLI, preserving
  side-effect-free unit generation and uninstallation.
- Passing `--skip-cli-check` or setting `CC_WEB_SKIP_CLI_CHECK=1` downgrades
  missing or outdated CLI refusals to a `warning:` on stderr (saying what was
  skipped), allowing operators to set up the runner prior to installing Claude
  Code or knowingly test unsupported versions.

The check reads the environment of the **invoking shell**, not the service
environment file. `CC_WEB_CLAUDE_BIN` must therefore be exported before
`setup` / `connect` / `service install`, or the check is refused before the
unit is ever written; recording it in `/etc/cc-web-runner.env` alone only
covers the daemon, not the check.

### Diagnostics and release matrix

`runner --version` reports the CLI mode alongside the protocol version:
`cc-web-runner (protocol v1, cli external)` for slim builds, or
`cc-web-runner (protocol v1, cli embedded)` for bundled builds.

The GitHub release workflow (`.github/workflows/runner-build.yml`) publishes
eight artifacts across four targets:
`cc-web-runner-<os>-<arch>` and `cc-web-runner-bundled-<os>-<arch>` for
`linux-x64`, `linux-arm64`, `windows-x64`, and `windows-arm64` (Windows
artifacts retain the `.exe` extension).

## Consequences

- **Binary size**: Slim runner executables avoid embedding ~293 MB of platform
  assets, drastically reducing artifact download time and bandwidth usage.
  Measured on linux-x64: slim 111,003,824 B (106 MiB; ~50–52 MB compressed),
  bundled 404,474,032 B.
- **Upgrading an existing runner is a breaking change for hosts without a CLI.**
  The artifact published under the old name (`cc-web-runner-<os>-<arch>`) is
  now slim. Replacing a bundled binary in place without installing Claude Code
  makes `connect` exit 1, and a systemd unit with `Restart=on-failure` turns
  that into a restart loop rather than a single visible error. Operators take
  `cc-web-runner-bundled-<os>-<arch>` to keep the old behaviour, or install a
  CLI (`>= 2.1.309`) before swapping. The environment file trick does not help
  the check itself — see Refusal semantics.
- **Host prerequisites**: Hosts running slim binaries must install and update
  Claude Code independently (`claude update`). Bundled binaries remain available
  for self-contained or offline deployments.
- **Service environment**: Systemd services resolve the host CLI via well-known
  installation directories even when `~/.local/bin` is absent from `PATH`.
  Custom binary locations can be provided via `CC_WEB_CLAUDE_BIN` in the service
  environment file.
- **CI and verification**: CI verifies both paths without installing Claude Code
  on the runner: `runner-binary.ts` verifies slim default builds and
  refusal semantics, while `runner-agent-e2e.ts` compiles with `--with-cli` to
  prove asset extraction and execution.
- **Protocol compatibility**: Both variants expose identical protocol
  capabilities, wire messages, and configuration inheritance semantics.
