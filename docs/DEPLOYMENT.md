# Deployment

Production deployment of the control plane as a single Docker image behind the
operator's existing TLS reverse proxy. Architecture context: §20.1 (topology),
§20.3 (service management), §20.5 (backups).

The Runner is **not** part of this stack. Production Runners are host-native
(§20.3): they inherit the operator's Claude config and provider credentials,
which a container does not have. `infra/docker/compose.runners.yml` is the
multi-Runner integration harness, not a deployment.

## What runs

```text
Browser ── TLS ──> existing reverse proxy ──> 127.0.0.1:8080
                                                 │
                                           cc-web container
                                 ┌──────────────────────────────┐
                                 │ Caddy :80 — SPA + proxy      │
                                 │   └──> 127.0.0.1:8787        │
                                 │        control server (Bun)  │
                                 └──────────────────────────────┘
                                                 │
                                          control-data volume
                                              (SQLite)
```

One image, one container, two processes:

- **Caddy** is the only network edge. It serves the built Vue client from
  `/srv`, proxies `/api/*`, `/auth/*`, `/ws/*` and `/healthz` to the control
  server on loopback, and sets the security headers.
- **The control server** (Bun) owns the SQLite database on the `control-data`
  named volume. It is never published; the compose file maps only Caddy's port,
  on loopback by default.

The entrypoint ties the two together: if either process exits, the other is
stopped and the container exits, so the restart policy starts a clean pair. The
image healthcheck probes both — the control server's `/healthz` and Caddy's
admin API — so a half-dead container is replaced instead of serving errors.

One origin is also what keeps the same-origin `cc_session` cookie and the Origin
allowlist working unchanged from development.

## Prerequisites

- Docker with Compose v2 (`docker compose version`).
- The files in `infra/docker/` — `compose.prod.yml` for a source build, or
  `compose.ghcr.yml` for the published image, plus `.env`. The GHCR file is
  standalone: two files, no checkout.
- An existing TLS reverse proxy on the host (Caddy, nginx, Traefik, …) if the
  stack is reachable from outside the machine.
- A free loopback port for the stack; the default is `127.0.0.1:8080`.

## First deployment (build from source)

```sh
cp infra/docker/.env.example infra/docker/.env
```

Edit `infra/docker/.env`:

1. `CC_WEB_JWT_SECRET` — at least 32 bytes. `openssl rand -base64 48` prints a
   suitable value. Changing it later invalidates every session.
2. `CC_WEB_ALLOWED_ORIGINS` — the exact browser origin the proxy publishes,
   scheme included, no trailing slash (for example `https://cc.example.com`).
   This one list gates login, the browser socket and runner-token minting; a
   mismatch turns into `403` responses, not a startup failure.

Then build and start:

```sh
docker compose -f infra/docker/compose.prod.yml up -d --build
docker compose -f infra/docker/compose.prod.yml ps
docker compose -f infra/docker/compose.prod.yml logs -f app
```

The container runs migrations on boot; every migration is idempotent, so
restarts and upgrades are safe.

Health check from the host:

```sh
curl -fsS http://127.0.0.1:8080/healthz
# {"ok":true,"protocolVersion":1}
```

## Deploy from prebuilt images (GHCR)

`.github/workflows/images.yml` publishes the image to GHCR on every push to
`main` that touches an app, a workspace package, the seed script or the Docker
inputs. Each tag is a multi-arch manifest — `linux/amd64` and `linux/arm64` — so
the host pulls its own architecture with no platform flag.

`infra/docker/compose.ghcr.yml` is a standalone file for this path: it has no
`build` section, so `docker compose` is the only tool the host needs.

```sh
mkdir -p /opt/cc-web && cd /opt/cc-web
# copy infra/docker/compose.ghcr.yml here as compose.yml, and create .env
docker compose pull
docker compose up -d
```

A deploy host needs those two files and nothing else: no repository, no Bun
toolchain. The file reads `.env` next to itself and refuses to start with a
clear message when `CC_WEB_JWT_SECRET` or `CC_WEB_ALLOWED_ORIGINS` is missing.
The rest of this document applies unchanged — the same `control-data` volume,
the same seeding and proxy steps — with `compose.yml` in place of
`infra/docker/compose.prod.yml` in the commands.

### The `.env` on the deploy host

```sh
cat > .env <<'EOF'
CC_WEB_JWT_SECRET=<output of: openssl rand -base64 48>
CC_WEB_ALLOWED_ORIGINS=https://cc.example.com
EOF
```

The optional variables (`CC_WEB_SITE_ADDRESS`, `CC_WEB_BIND_ADDR`,
`CC_WEB_HTTP_PORT`, `CC_WEB_IMAGE_TAG`) have defaults; see the configuration
reference below.

### Registry authentication

GHCR packages are private unless their visibility is changed in the package
settings. For a private package, create a token with `read:packages` (classic
PAT) and log in once on the deploy host:

```sh
read -rsp "GHCR token: " CR_PAT; echo
printf %s "$CR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
unset CR_PAT
```

Making the package public (Package settings → Change visibility) removes this
step from every deploy host.

### Tags: `latest` versus `sha-<short>`

Every build publishes `latest` (follows `main`) and `sha-<short>` (one commit,
immutable). The file defaults to `latest`; pin a release in `.env` when
reproducibility matters:

```sh
CC_WEB_IMAGE_TAG=sha-1a2b3c4
```

Rolling the tag back redeploys the older image, but the database schema does not
roll back — take a backup (below) before a release you may need to undo.

## Create the owner account

The password arrives on stdin, never argv (a process listing is world-readable):

```sh
read -rsp "Password for owner: " CC_WEB_PASSWORD; echo
printf %s "$CC_WEB_PASSWORD" | docker compose -f infra/docker/compose.prod.yml \
  exec -T --user bun app bun scripts/seed-user.ts owner
unset CC_WEB_PASSWORD
```

`--user bun` is not cosmetic: the database and its WAL files must stay owned by
the account the control server runs as, or the server loses write access on the
next connection.

The script creates the schema if needed and refuses a duplicate username.
Nothing else in the stack seeds users — a fresh volume has no logins until this
runs.

## Point the reverse proxy at the stack

Caddy on the host, with automatic TLS and WebSocket support:

```caddyfile
cc.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

nginx, with the WebSocket upgrade and long-lived connections the sockets need:

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}

server {
	listen 443 ssl;
	server_name cc.example.com;

	location / {
		proxy_pass http://127.0.0.1:8080;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;
		proxy_set_header X-Forwarded-Proto $scheme;

		# /ws/browser and /ws/runner are long-lived and mostly idle; the nginx
		# default of 60s would cut them.
		proxy_read_timeout 1h;
		proxy_buffering off;
	}
}
```

Both `/ws/browser` (owner socket) and `/ws/runner` (runner transport) must reach
the control server. A proxy that drops the `Upgrade` header looks like a server
bug from the browser: the socket never opens while HTTP calls work.

## Connect a Runner

On the machine that will run agents (not necessarily the compose host):

```sh
bun run build:runner                       # produces dist/cc-web-runner
```

Mint a runner token in the web UI, then on the runner host:

```sh
echo -n "$RUNNER_TOKEN" | ./dist/cc-web-runner setup \
  --server https://cc.example.com --runner-id <name>
./dist/cc-web-runner connect               # foreground smoke test
./dist/cc-web-runner service install       # systemd unit, no secret in it
```

`--server` is the public origin the proxy publishes; the runner derives
`wss://…/ws/runner` from it. A `401` on connect means the credential is unknown
or revoked — mint a new token.

## Operating the stack

```sh
# Upgrade, building from the checkout; migrations run on boot.
git pull
docker compose -f infra/docker/compose.prod.yml up -d --build

# Upgrade, pulling the image CI published (see "Deploy from prebuilt images").
docker compose -f infra/docker/compose.ghcr.yml pull
docker compose -f infra/docker/compose.ghcr.yml up -d

# Restart the stack.
docker compose -f infra/docker/compose.prod.yml restart app

# Stop without touching the database volume.
docker compose -f infra/docker/compose.prod.yml down
```

A restart closes runner sockets; runners reconnect on their own and the outbox
drains on reconnect. Active runs continue on the runner — the server does not
stop them (§20.4).

Do not run the container without Compose names: the named volume and the image
entrypoint are part of the file.

## Backup and restore

SQLite with WAL must be copied with SQLite's backup API, not by copying the main
file (§20.5). The image ships `sqlite3` for exactly this:

```sh
# Consistent snapshot while the server is running.
docker compose -f infra/docker/compose.prod.yml exec -T app \
  sqlite3 /data/control.sqlite ".backup '/data/control-backup.sqlite'"
docker compose -f infra/docker/compose.prod.yml cp \
  app:/data/control-backup.sqlite "./control-backup-$(date +%F).sqlite"
docker compose -f infra/docker/compose.prod.yml exec -T app \
  rm -f /data/control-backup.sqlite
```

Restore (the server must be stopped, and the old `-wal`/`-shm` files must go —
replaying a stale WAL over a replaced database corrupts it). `--entrypoint sh`
bypasses the supervisor, and `--user bun` keeps the restored file owned by the
account that writes it at runtime. On a GHCR deploy host, use `compose.yml` in
place of `infra/docker/compose.prod.yml` below:

```sh
docker compose -f infra/docker/compose.prod.yml stop app
docker compose -f infra/docker/compose.prod.yml run --rm --no-deps -T \
  --user bun --entrypoint sh app \
  -c 'rm -f /data/control.sqlite-wal /data/control.sqlite-shm && cat > /data/control.sqlite' \
  < ./control-backup-2026-10-27.sqlite
docker compose -f infra/docker/compose.prod.yml start app
```

Runner identities are not in this database. Restoring a Runner means minting a
new token and running `setup` again on a host where the old instance is
definitely stopped (§20.5) — never two live copies of one identity.

## Configuration reference

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CC_WEB_JWT_SECRET` | yes | — | HS256 key for `cc_session`; ≥ 32 bytes |
| `CC_WEB_ALLOWED_ORIGINS` | yes | — | Comma-separated exact browser origins |
| `CC_WEB_DB` | set by image | `/data/control.sqlite` | SQLite path on the volume |
| `CC_WEB_PORT` | set by image | `8787` | Control server port inside the container |
| `CC_WEB_SITE_ADDRESS` | no | `:80` | Caddy site address inside the container |
| `CC_WEB_BIND_ADDR` | no | `127.0.0.1` | Host interface the published port binds |
| `CC_WEB_HTTP_PORT` | no | `8080` | Host port mapped to the container's 80 |
| `CC_WEB_IMAGE_TAG` | no | `latest` | GHCR image tag for `compose.ghcr.yml` |

`CC_WEB_SITE_ADDRESS` can be a bare domain instead of `:80`: Caddy then obtains
certificates itself, and `CC_WEB_HTTP_PORT` should become `80` with `443`
published as well. The external-proxy layout above is the default because most
hosts already run one.

## Security notes

- **Only Caddy's port is published.** The control server shares the container's
  network namespace and listens on loopback; the compose file maps only Caddy's
  port, loopback by default. Keep the proxy → container hop on loopback or a
  private network.
- **Cookie `Secure` flag behind TLS termination.** `auth-routes.ts` sets
  `Secure` only when the request URL is `https`, and behind a TLS-terminating
  proxy the control server sees plain HTTP. The cookie is still `HttpOnly` and
  `SameSite=Lax`, and it only travels inside the loopback hop to the browser
  over TLS, but it is not marked `Secure`. Enable HSTS at the external proxy.
  Teaching `auth-routes` to honour `X-Forwarded-Proto` is a tracked follow-up.
- **Single instance only.** SQLite plus in-memory gateways mean one control
  server; do not scale the service horizontally (§21.1 stage C is the
  PostgreSQL work, not a compose flag).
- **One database, one writer.** The entrypoint owns both processes. Do not
  replace it or start a second control server against the same volume.
- **Secret rotation logs everyone out.** `CC_WEB_JWT_SECRET` rotation makes
  every existing token unverifiable; the owner signs in again.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `required variable CC_WEB_JWT_SECRET is missing a value` / `missing required environment variable: CC_WEB_JWT_SECRET` | `.env` missing next to the compose file, or the key is empty |
| Login answers `403` | Browser origin not in `CC_WEB_ALLOWED_ORIGINS` (scheme/port must match exactly) |
| Browser socket closes immediately / never opens | Proxy drops `Upgrade`; see the nginx block above |
| Runner connect answers `401` | Token unknown or revoked — mint a new one |
| `up` fails: address already in use | Change `CC_WEB_HTTP_PORT` |
| Container restarts shortly after starting | One of the two processes died; `docker compose logs app` shows which. The supervisor exits on purpose |
| `pull` answers `unauthorized` / `denied` | The GHCR package is private — `docker login ghcr.io` with a `read:packages` token, or make the package public |
| Database permission error | The volume was created by another user, or a seed/restore ran as root instead of `--user bun` (the WAL files become unwritable) |

## Related

- `docs/ARCHITECTURE.md` §20 — deployment, shutdown, backup, observability.
- `.github/workflows/images.yml` — builds the multi-arch GHCR image.
- `infra/docker/README.md` — the integration harness (`compose.runners.yml`,
  `Dockerfile.runner`). Its `CONTROL_*` variable names predate the current
  `CC_WEB_*` configuration and it is not a deployment path.
