# Single production image: the built Vue client, Caddy as the front door, and
# the control server, all in one container (§20.1).
#
# Scope is the control plane only. Runners stay host-native: a Runner inherits
# the operator's Claude config and provider credentials, which a container does
# not have (§20.3).
#
# Deployed by infra/docker/compose.prod.yml; operating notes in
# docs/DEPLOYMENT.md.

# ---- Stage 1: build the SPA -------------------------------------------------

FROM oven/bun:1.4.3-debian AS web-build

WORKDIR /app

# Dependency layer first, so a source edit does not invalidate the install.
# Every workspace package.json is copied because the root `workspaces` globs and
# the lockfile name all of them.
COPY package.json bun.lock ./
COPY apps/control-server/package.json apps/control-server/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
COPY packages/agent-adapter/package.json packages/agent-adapter/
COPY packages/control-db/package.json packages/control-db/
COPY packages/protocol/package.json packages/protocol/
COPY packages/runner-db/package.json packages/runner-db/
COPY packages/shared/package.json packages/shared/

# The build needs devDependencies (Vite, @vitejs/plugin-vue, the `typescript5`
# alias), so this is a full install. The Claude asset postinstall is skipped:
# nothing the web client imports needs it.
RUN bun install --ignore-scripts

COPY . .

RUN cd apps/web && bun run build

# ---- Stage 2: runtime -------------------------------------------------------

# Caddy owns the only network edge, so it is the base. Bun is copied from its
# Alpine image so both processes share musl. The binary needs libstdc++; the
# `bun --version` below proves that at build time instead of at first request.
FROM caddy:2.10-alpine

COPY --from=oven/bun:1.4.3-alpine /usr/local/bin/bun /usr/local/bin/bun

# libstdc++       — Bun's runtime dependency.
# sqlite          — the CLI (binary name `sqlite3`) for consistent backups (§20.5).
# su-exec         — runs the control server as `bun`; Caddy keeps root for :80.
# bash            — the entrypoint's supervisor: busybox ash's `wait -n` does not
#                   return when the second background child exits.
# ca-certificates — Bun's package downloads below, and any future outbound TLS.
RUN apk add --no-cache libstdc++ sqlite ca-certificates su-exec bash \
    && bun --version \
    && addgroup -S bun \
    && adduser -S -G bun bun

WORKDIR /app

# Production dependencies only, filtered to the control server and its workspace
# dependencies: a plain `--production` install would also pull the web client's
# runtime dependencies into an image that never serves them. `--ignore-scripts`
# skips the postinstall that embeds the Claude Code binary: that asset belongs
# to the Runner, and the control plane never imports @cc-web/agent-adapter.
# Reproducibility comes from the pinned base images, not `--frozen-lockfile`
# (the lockfile names optional platform binaries that a different host would
# skip).
COPY package.json bun.lock ./
COPY apps/control-server/package.json apps/control-server/
COPY apps/runner/package.json apps/runner/
COPY apps/web/package.json apps/web/
COPY packages/agent-adapter/package.json packages/agent-adapter/
COPY packages/control-db/package.json packages/control-db/
COPY packages/protocol/package.json packages/protocol/
COPY packages/runner-db/package.json packages/runner-db/
COPY packages/shared/package.json packages/shared/

RUN bun install --production --ignore-scripts --filter '@cc-web/control-server'

# A filtered install links the workspace packages into the workspace's own
# node_modules, not the root. The seed script runs from /app/scripts, so point
# the root at the same links instead of duplicating the packages.
RUN mkdir -p /app/node_modules \
    && ln -sfn /app/apps/control-server/node_modules/@cc-web /app/node_modules/@cc-web

COPY . .

# The SPA built in stage 1; Caddy serves it from /srv. The Caddyfile proxies the
# control surfaces to the Bun process the entrypoint starts.
COPY --from=web-build /app/apps/web/dist /srv
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The database and file attachments live on the volume mount, and the control
# server listens on a fixed loopback port inside the container; Caddy reaches it there.
ENV CC_WEB_DATA_DIR=/data \
    CC_WEB_ATTACHMENTS_DIR=/data/attachments \
    CC_WEB_DB=/data/control.sqlite \
    CC_WEB_PORT=8787

RUN mkdir -p /data/attachments && chown -R bun:bun /data

VOLUME ["/data"]
EXPOSE 80 443

# Both processes must answer: the control server's health endpoint and Caddy's
# admin API. If either died, the entrypoint exits and the restart policy
# replaces the container.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz \
        && wget -q -O /dev/null http://127.0.0.1:2019/config/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
