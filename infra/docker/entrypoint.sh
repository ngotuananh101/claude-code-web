#!/bin/bash
# One container, two processes.
#
# Caddy is the only network edge: it serves the SPA from /srv and proxies /api/*,
# /auth/*, /ws/* and /healthz to the control server on loopback. Both are needed
# for the container to do its job, so whichever exits first stops the other and
# the container exits — the restart policy then brings up a clean pair. A
# half-dead container would keep failing requests in ways a healthcheck cannot
# repair.

set -eu

# The control server writes the SQLite database, so it runs as `bun`, not root.
su-exec bun:bun bun run /app/apps/control-server/src/index.ts &
bun_pid=$!

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

shutdown() {
    # Caddy first: stop accepting before the control server goes away.
    kill -TERM "$caddy_pid" "$bun_pid" 2>/dev/null || true
    wait "$caddy_pid" 2>/dev/null || true
    wait "$bun_pid" 2>/dev/null || true
}

trap 'shutdown; exit 0' INT TERM

# bash's `wait -n` returns as soon as either child exits. (busybox ash has the
# flag but not the semantics: it keeps waiting when the second child dies.)
status=0
wait -n || status=$?

shutdown
exit "$status"
