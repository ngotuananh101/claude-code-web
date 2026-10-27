# Deployment

Production deployment of the control plane with Docker Compose, behind the
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
                                              web (Caddy: SPA + reverse proxy)
                                                 │ compose network
                                              control (Bun + SQLite on a volume)
```

- `web` — Caddy serving the built Vue client and proxying `/api/*`, `/auth/*`,
  `/ws/*` and `/healthz` to the control server. Only this service publishes a
  port, on loopback by default.
- `control` — the control server. Not published; reachable only on the compose
  network. Its SQLite database lives on the `control-data` named volume.

## Prerequisites

- Docker with Compose v2 (`docker compose version`).
- A checkout of this repository — images are built from source, not pulled.
- An existing TLS reverse proxy on the host (Caddy, nginx, Traefik, …) if the
  stack is reachable from outside the machine.
- A free loopback port for the stack; the default is `127.0.0.1:8080`.

## First deployment

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
docker compose -f infra/docker/compose.prod.yml logs -f control
```

`control` runs migrations on boot; every migration is idempotent, so restarts
and upgrades are safe. The `web` service waits for the control healthcheck
before starting.

Health check from the host:

```sh
curl -fsS http://127.0.0.1:8080/healthz
# {"ok":true,"protocolVersion":1}
```

## Create the owner account

The password arrives on stdin, never argv (a process listing is world-readable):

```sh
read -rsp "Password for owner: " CC_WEB_PASSWORD; echo
printf %s "$CC_WEB_PASSWORD" | docker compose -f infra/docker/compose.prod.yml exec -T control \
  bun scripts/seed-user.ts owner
unset CC_WEB_PASSWORD
```

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

Both `/ws/browser` (owner socket) and `/ws/runner` (runner transport) must
reach the control server. A proxy that drops the `Upgrade` header looks like a
server bug from the browser: the socket never opens while HTTP calls work.

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
# Upgrade: rebuild from the updated checkout; migrations run on boot.
git pull
docker compose -f infra/docker/compose.prod.yml up -d --build

# Restart one service.
docker compose -f infra/docker/compose.prod.yml restart control

# Stop without touching the database volume.
docker compose -f infra/docker/compose.prod.yml down
```

A control-server restart closes runner sockets; runners reconnect on their own
and the outbox drains on reconnect. Active runs continue on the runner — the
server does not stop them (§20.4).

Do not run the two services without Compose names: the named volume and the
`control` upstream name are part of the file.

## Backup and restore

SQLite with WAL must be copied with SQLite's backup API, not by copying the
main file (§20.5). The image ships `sqlite3` for exactly this:

```sh
# Consistent snapshot while the server is running.
docker compose -f infra/docker/compose.prod.yml exec -T control \
  sqlite3 /data/control.sqlite ".backup '/data/control-backup.sqlite'"
docker compose -f infra/docker/compose.prod.yml cp \
  control:/data/control-backup.sqlite "./control-backup-$(date +%F).sqlite"
docker compose -f infra/docker/compose.prod.yml exec -T control \
  rm -f /data/control-backup.sqlite
```

Restore (the server must be stopped, and the old `-wal`/`-shm` files must go —
replaying a stale WAL over a replaced database corrupts it):

```sh
docker compose -f infra/docker/compose.prod.yml stop control
docker compose -f infra/docker/compose.prod.yml run --rm --no-deps -T control \
  sh -c 'rm -f /data/control.sqlite-wal /data/control.sqlite-shm && cat > /data/control.sqlite' \
  < ./control-backup-2026-10-27.sqlite
docker compose -f infra/docker/compose.prod.yml start control
```

Runner identities are not in this database. Restoring a Runner means minting a
new token and running `setup` again on a host where the old instance is
definitely stopped (§20.5) — never two live copies of one identity.

## Configuration reference

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CC_WEB_JWT_SECRET` | yes | — | HS256 key for `cc_session`; ≥ 32 bytes |
| `CC_WEB_ALLOWED_ORIGINS` | yes | — | Comma-separated exact browser origins |
| `CC_WEB_DB` | set by compose | `/data/control.sqlite` | SQLite path on the volume |
| `CC_WEB_PORT` | set by compose | `8787` | Control server listen port |
| `CC_WEB_SITE_ADDRESS` | no | `:80` | Caddy site address inside the web container |
| `CC_WEB_BIND_ADDR` | no | `127.0.0.1` | Host interface the web port binds |
| `CC_WEB_HTTP_PORT` | no | `8080` | Host port mapped to the web container's 80 |

`CC_WEB_SITE_ADDRESS` can be a bare domain instead of `:80`: Caddy then obtains
certificates itself, and `CC_WEB_HTTP_PORT` should become `80` with `443`
published as well. The external-proxy layout above is the default because most
hosts already run one.

## Security notes

- **The control server is never published.** Only Caddy's port is, loopback by
  default. Keep the proxy → Caddy hop on loopback or a private network.
- **Cookie `Secure` flag behind TLS termination.** `auth-routes.ts` sets
  `Secure` only when the request URL is `https`, and behind a TLS-terminating
  proxy the control server sees plain HTTP. The cookie is still `HttpOnly` and
  `SameSite=Lax`, and it only travels inside the loopback hop to the browser
  over TLS, but it is not marked `Secure`. Enable HSTS at the external proxy.
  Teaching `auth-routes` to honour `X-Forwarded-Proto` is a tracked follow-up.
- **Single instance only.** SQLite plus in-memory gateways mean one control
  server; do not scale the service horizontally (§21.1 stage C is the
  PostgreSQL work, not a compose flag).
- **Secret rotation logs everyone out.** `CC_WEB_JWT_SECRET` rotation makes
  every existing token unverifiable; the owner signs in again.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `missing required environment variable: CC_WEB_JWT_SECRET` at boot | `.env` missing next to the compose file, or the key is empty |
| Login answers `403` | Browser origin not in `CC_WEB_ALLOWED_ORIGINS` (scheme/port must match exactly) |
| Browser socket closes immediately / never opens | Proxy drops `Upgrade`; see the nginx block above |
| Runner connect answers `401` | Token unknown or revoked — mint a new one |
| `up` fails: address already in use | Change `CC_WEB_HTTP_PORT` |
| Database permission error | The volume was created by another user; `docker compose down` (without `-v`) then `up` recreates ownership |

## Related

- `docs/ARCHITECTURE.md` §20 — deployment, shutdown, backup, observability.
- `infra/docker/README.md` — the integration harness (`compose.runners.yml`,
  `Dockerfile.runner`). Its `CONTROL_*` variable names predate the current
  `CC_WEB_*` configuration and it is not a deployment path.
