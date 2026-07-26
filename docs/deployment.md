# ROUND production deployment

This stack runs one in-memory Java signaling replica behind Caddy and a
host-networked coturn relay. Caddy serves the Vite build, terminates HTTPS/WSS,
and proxies only `/signal`, `/healthz`, and `/api/turn-credentials` to the
unpublished signaling port.

## Production prerequisites

- A Linux host with Docker Engine and Docker Compose. Coturn uses
  `network_mode: host`; Docker Desktop is useful for image validation but is
  not a production TURN topology.
- One static public IPv4 address.
- `A` records for the web hostname (for example `round.example.com`) and the
  TURN hostname (for example `turn.example.com`). Point TURN directly at the
  host; do not put it behind an HTTP CDN or proxy.
- A PEM full chain and private key whose SAN covers the TURN hostname. Caddy
  obtains and renews the web certificate separately through ACME.
- NAT port forwarding, if the Docker host does not own the public address.

The included coturn configuration is IPv4-only. Do not publish an `AAAA` record
for the TURN hostname without adding and testing an IPv6 relay configuration.

### Firewall

Open these inbound ports on both the host firewall and any upstream
security group or router:

| Port          | Protocol    | Owner  | Purpose                                |
| ------------- | ----------- | ------ | -------------------------------------- |
| `80`          | TCP         | Caddy  | ACME HTTP challenge and HTTPS redirect |
| `443`         | TCP         | Caddy  | HTTPS and WSS                          |
| `443`         | UDP         | Caddy  | HTTP/3                                 |
| `3478`        | UDP and TCP | coturn | STUN/TURN                              |
| `5349`        | TCP and UDP | coturn | TURN TLS and DTLS                      |
| `49160-49259` | UDP         | coturn | Media relay allocations                |

The default relay range provides 100 ports. A TURN allocation consumes a relay
port, so expand `TURN_MIN_PORT`/`TURN_MAX_PORT` and the firewall rule together
when hosting more concurrent rooms. Allow coturn outbound UDP to arbitrary peer
addresses and ports; stateful return traffic must also be allowed.

The sample also limits abuse and overload:

- `TURN_USER_QUOTA=12` permits up to 12 concurrent allocations for one issued
  user. A six-person mesh needs at most five peer allocations per participant.
- `TURN_TOTAL_QUOTA=120` caps allocations across the server.
- `TURN_MAX_BPS=2000000` caps each TURN session at 2,000,000 bytes/s per input
  and output stream.
- `TURN_BPS_CAPACITY=30000000` caps capacity allocated across all sessions at
  30,000,000 bytes/s per direction.

Tune these four values from observed bitrate and concurrency. The total quota
must be at least the user quota, and total bandwidth capacity must be at least
the per-session limit.

## Configure secrets and certificates

Create the runtime environment from the tracked sample:

```bash
cp ops/production.env.example ops/production.env
chmod 0600 ops/production.env
openssl rand -hex 32
```

Paste the generated 64-character value into `TURN_SHARED_SECRET`. This file is
ignored by both Git and the Docker build context. The secret is passed only at
container runtime to signaling and coturn; it is never compiled into the web
bundle or an image layer.

Set these values carefully:

- `ROUND_DOMAIN` and `ALLOWED_ORIGINS` must describe the same exact HTTPS
  origin. Do not use a wildcard origin.
- `TURN_URLS` should advertise UDP, TCP, and TLS routes for the TURN hostname.
  The signaling endpoint uses the same shared secret as coturn to issue
  expiring HMAC credentials.
- `TURN_CREDENTIAL_TTL_SECONDS` defaults to 3,600 seconds and can be adjusted
  without rebuilding an image. The endpoint and external probe issue or fetch
  a fresh credential on every request.
- `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`,
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`, and
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS` bound credential endpoint abuse.
  The defaults permit 12 requests per client in 60 seconds while tracking up
  to 10,000 clients.
- `VITE_ICE_TRANSPORT_POLICY=all` is the normal release setting. Build a
  dedicated image with `relay` to prove media crosses TURN rather than a direct
  candidate, then restore `all` and rebuild the release image.
- `TURN_EXTERNAL_IP` is the public IPv4 address.
- `TURN_RELAY_IP` is the host interface address used for relay sockets. Set it
  equal to `TURN_EXTERNAL_IP` when the public address belongs directly to the
  host; behind NAT, use the private interface address.
- `TURN_REALM` should be the TURN DNS hostname.

Place the TURN certificate files at the paths configured by
`TURN_TLS_CERT_FILE` and `TURN_TLS_KEY_FILE`, for example:

```text
ops/certs/fullchain.pem
ops/certs/privkey.pem
```

The certificate directory is ignored by Git and the Docker build context.
Compose mounts the files as read-only runtime secrets. Coturn starts only long
enough to read those files, then drops to the image's `nobody` account with no
effective capabilities. Arrange certificate renewal with the host's ACME client
and recreate the TURN container after renewal:

```bash
docker compose --env-file ops/production.env up -d --no-deps --force-recreate turn
```

## Validate, build, and start

Validate interpolation without printing the rendered secret:

```bash
docker compose --env-file ops/production.env config --quiet
```

CI runs the same interpolation against temporary dummy credentials and
certificates, validates all deployment scripts and the Caddyfile, checks every
Dockerfile runtime target, and builds all three images:

```bash
bash ops/ci/validate-deployment.sh
```

For a local syntax and target check that does not build final images, add
`--check-only`.

Build the three target images and start the stack:

```bash
docker compose --env-file ops/production.env build --pull
docker compose --env-file ops/production.env up -d --wait --wait-timeout 120
docker compose --env-file ops/production.env ps
```

Do not run plain `docker compose config` in shared logs: its rendered output
contains `TURN_SHARED_SECRET`.

The sample uses unique release tags for a single-host source build. In CI,
publish `web-runtime`, `signaling-runtime`, and `turn-runtime` under immutable
release tags, then set `ROUND_EDGE_IMAGE`, `ROUND_SIGNALING_IMAGE`, and
`ROUND_TURN_IMAGE` to registry digests. Pin the optional base-image variables to
digests as well. A digest-based host deployment can use:

```bash
docker compose --env-file ops/production.env pull
docker compose --env-file ops/production.env up -d --no-build
```

Only Caddy uses Docker port publishing; coturn binds its documented ports
directly through the Linux host network. Signaling listens on `8787` solely on
the internal Compose network. Its room membership is held in memory, so
`deploy.replicas` is intentionally fixed at one; horizontal scaling requires a
shared room registry and cross-node signaling before it is safe.

## Verify the running service

```bash
curl --fail --silent --show-error https://round.example.com/healthz
openssl s_client -connect turn.example.com:5349 -servername turn.example.com </dev/null
docker compose --env-file ops/production.env logs --tail=100 edge signaling turn
```

The Compose TURN healthcheck is a local unauthenticated STUN listener check. It
is useful for container liveness and makes `docker compose up --wait` fail when
coturn is not listening, but it does not prove that public TURN allocation,
authentication, NAT forwarding, or relay media works. Likewise, a passing edge
`/healthz` proves only Caddy-to-signaling reachability.

Run the authenticated relay probe from a Linux monitoring host outside the TURN
server and its NAT:

```bash
ROUND_URL=https://round.example.com \
TURN_PROBE_HOST=turn.example.com \
TURN_PROBE_IMAGE=coturn/coturn:4.14.0-r0-alpine \
ops/turn/probe.sh
```

The monitor needs `curl`, `jq`, GNU `timeout`, and Docker. Pin
`TURN_PROBE_IMAGE` to the same reviewed coturn digest as the deployment. The
probe fetches a fresh short-lived credential without printing it, verifies the
advertised URLs and expiry, and creates authenticated client-to-client relay
traffic over UDP, TCP, and TLS. Treat a nonzero exit as a deployment failure.
Run it every one to five minutes from the external network and alert after an
appropriate number of consecutive failures.

The credential response contains `urls`, `username`, `credential`, and
`expiresAt` (epoch seconds), but never the shared secret. Confirm separately in
two browser/network combinations that WebSocket signaling connects and that
`chrome://webrtc-internals` or the equivalent browser diagnostics shows a
`relay` ICE candidate.

Caddy emits access logs only for `/signal`, `/healthz`, and
`/api/turn-credentials`. Request headers are removed and query strings are
redacted before encoding the log, so invite paths, referrers, cookies, and
credential-like query data do not enter Caddy access logs. Application and TURN
logs must follow the same no-room-code and no-credential rule. Caddy error logs
omit request headers and URIs entirely.

## Operations

- Caddy ACME state lives in the `caddy_data` and `caddy_config` named volumes;
  include them in host backups.
- Signaling and coturn runtime files are ephemeral. Restarting signaling drops
  active rooms and WebSocket sessions.
- Rotate `TURN_SHARED_SECRET` by updating the env file and recreating signaling
  and turn together. Previously issued credentials stop working after coturn
  switches secrets, so plan a short maintenance window.
- Keep the relay range consistent in the env file, coturn firewall, router
  forwarding, and cloud security group.
- Roll back by restoring all three prior immutable image references and running
  `docker compose ... up -d --no-build`. Do not scale signaling above one.
