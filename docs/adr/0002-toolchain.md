# ADR-0002 — Phase 0 target platform and toolchain pinning policy

- Status: accepted
- Date: 2026-10-23
- Refines: ARCHITECTURE.md §4.1, §23 Phase 0, §24.2.

## Context

§4.1 asks for a pinned toolchain and says not to assert a version that has not
been verified. §24.2 lists the OS, SDK/Bun versions and provider auth as gates
to settle before implementation. The operator decided: no hard version pinning;
first target is the development host.

## Decision

**Target**: Fedora Linux on x86_64, the host where the Runner is developed.
Linux is the first OS because it fixes supervisor and process-containment
semantics (systemd, process groups, cgroup escalation) before any portability
work.

**Observed toolchain at scaffolding time** (recorded, not pinned as a range):

| Component | Version |
| --- | --- |
| Bun | 1.4.3 |
| Node (tooling only) | v24.21.0 |
| Git | 2.56.0 |

**Pinning policy**: dependency ranges are not pinned by hand. Reproducibility
comes from committing the lockfile (`bun.lock`) and recording the exact resolved
versions in this table when they change. `package.json` keeps permissive ranges;
the lockfile is the source of truth.

**Tool version pinning (added when CI was introduced)**: `package.json` carries
`packageManager: "bun@1.4.3"` and the workflows read it through `setup-bun`'s
`bun-version-file`. This is not a dependency pin — it is the one place the *tool*
version is written down, so CI installs with the same Bun the lockfile was
resolved with instead of whatever the runner image happens to ship. Moving to a
new Bun is then a deliberate edit to that field, not a silent drift.

Revisit and move to explicit dependency pins if any of these occur: a dependency
ships a breaking change that alters protocol behaviour, two Runners end up on
versions that must interoperate, or an SDK update breaks the compatibility matrix
in §22.1.

## Consequences

- A fresh clone installs whatever the lockfile resolves — reproducible, but not
  auditable against a human-chosen version list. The table above is the audit
  trail.
- Upgrading the SDK is a deliberate action that re-runs the §22.1 matrix, not a
  side effect of `bun install`.
- If this repo later ships to other operators, each Runner must report its actual
  versions in `RunnerHello` (§6.2) rather than assume the control plane's.
- No second OS is supported until the Linux semantics are proven.
