# ROUND production deployment

This stack runs one in-memory Java signaling replica behind Caddy and a
host-networked coturn relay. Caddy serves the Vite build, terminates HTTPS/WSS,
and proxies only `/signal`, `/healthz`, and `/api/turn-credentials` to the
unpublished signaling port. The standalone pilot places one shared Caddy Basic
Auth gate in front of the static app, WebSocket upgrade, and TURN credential
endpoint; only `/healthz` remains public.

## Production prerequisites

- A Linux host with Docker Engine and Docker Compose. Coturn uses
  `network_mode: host`; Docker Desktop is useful for image validation but is
  not a production TURN topology.
- At least two logical CPUs, with capacity reserved for signaling and TURN.
  The edge CPU quota is a ceiling, not a dedicated or reserved core.
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

- `TURN_USER_QUOTA=20` permits up to 20 concurrent allocations for one issued
  user. A six-person mesh can gather against three advertised TURN transports
  for five peer connections (up to 15 allocations), leaving five for overlap
  during ICE recovery.
- `TURN_TOTAL_QUOTA=100` matches the default 100-port relay range and caps
  allocations across the server. Six fully relayed participants can consume up
  to 90 allocations while gathering all three transports, leaving ten for
  short recovery overlap.
- `TURN_MAX_BPS=2000000` caps each TURN session at 2,000,000 bytes/s per input
  and output stream.
- `TURN_BPS_CAPACITY=30000000` caps capacity allocated across all sessions at
  30,000,000 bytes/s per direction.

Tune these four values from observed bitrate and concurrency. The total quota
must be at least the user quota and no higher than the usable relay-port
capacity unless the port range is expanded; total bandwidth capacity must be
at least the per-session limit.

## Configure secrets and certificates

Create the runtime environment from the tracked sample:

```bash
cp ops/production.env.example ops/production.env
chmod 0600 ops/production.env
openssl rand -hex 32
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

Paste the generated 64-character value into `TURN_SHARED_SECRET`. This file is
ignored by both Git and the Docker build context. The secret is passed only at
container runtime to signaling and coturn; it is never compiled into the web
bundle or an image layer.

The Caddy command prompts without echoing the plaintext password. Paste its
entire `$2a$12$...` or `$2b$12$...` output between the single quotes in
`ROUND_ACCESS_PASSWORD_HASH=''`; the quotes prevent Compose from interpreting
the hash's dollar signs as environment interpolation. Keep the chosen plaintext
password out of the env file, shell history, Git, images, and logs. Set
`ROUND_ACCESS_USER` to a simple shared pilot username without a colon, then
choose a random 24–32 character ASCII password (bcrypt considers at most 72
input bytes), and deliver the username and plaintext password to the intended
study members over a separate trusted channel.

Set these values carefully:

- `ROUND_DOMAIN` must be served through HTTPS. HTTP Basic Auth only encodes
  credentials and is unsafe without TLS; deployed browser media and signaling
  also require HTTPS/WSS.
- `ROUND_ACCESS_USER` and `ROUND_ACCESS_PASSWORD_HASH` protect every external
  route except `/healthz`. Caddy verifies the explicit bcrypt cost-12 hash and
  removes `Authorization` before proxying to signaling. Requests carrying an
  `Authorization` header are limited before authentication to 96 per client
  network in a five-minute sliding window. Headerless browser challenges are
  not counted because they do not run a password hash. There is intentionally
  no anonymous global quota: a shared pre-authentication bucket would let one
  caller consume the budget and lock every participant out. Caddy uses a
  cost-14 fake bcrypt comparison for unknown usernames, so the client budget is
  sized against that more expensive failure path rather than only the configured
  cost-12 hash. IPv6 clients are grouped by `/64`, and the public health check
  does not consume the budget. The current four-file bundle uses about 36
  credential-bearing requests when six fresh browsers share one NAT; all six
  rounds of simultaneous signaling retries add another 36, leaving 24 requests
  for limited recovery traffic. This sliding-window budget limits request count,
  not concurrent bcrypt work. One client network can therefore submit many
  syntactically valid credentials with distinct nonexistent usernames
  concurrently, force the cost-14 fake-hash path, and temporarily saturate the
  edge's CPU before the 96-request budget is exhausted. The edge container is
  limited to one CPU worth of scheduler time, 256 MiB of memory, and 128
  processes. Those ceilings bound edge resource consumption on a host with
  spare capacity, but they do not reserve a CPU or guarantee availability. A
  one-CPU host can still be saturated, and existing WebSocket traffic can be
  delayed because every public signaling connection traverses the same edge.
  Run the checklist's measured burst gate against a six-person representative
  peak on the actual multi-CPU pilot host before accepting this risk. This is
  not sufficient protection for an unrestricted public service. A distributed
  attack from many client networks is likewise a residual risk. Upstream
  network filtering or BATON identity, a session login boundary, and a bounded
  pre-authentication work queue are needed before broader exposure. The shared
  credential is a temporary
  standalone-pilot boundary: it cannot identify participants, enforce study
  membership, or revoke one member. BATON authentication and meeting membership
  authorization must replace it before broader access.
- `ROUND_DOMAIN` and `ALLOWED_ORIGINS` must describe the same exact HTTPS
  origin. Do not use a wildcard origin.
- `TURN_URLS` should advertise UDP, TCP, and TLS routes for the TURN hostname.
  The signaling endpoint uses the same shared secret as coturn to issue
  expiring HMAC credentials.
- `TURN_CREDENTIAL_TTL_SECONDS` defaults to 600 seconds and can be adjusted
  without rebuilding an image. The endpoint and external probe issue or fetch
  a fresh credential on every request. If the TTL changes, review and normally
  align the issuance window so credentials do not outlive the intended
  rate-limit horizon.
- `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`,
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`,
  `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`, and
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS` bound credential endpoint abuse.
  With the ten-minute credential TTL, the matching ten-minute default window
  permits 12 requests per client and 24 requests across the standalone server
  while tracking up to 10,000 clients. Twelve covers both the initial issue and
  the scheduled eight-minute refresh for six room participants behind one NAT.
  The global quota must be at least twice the per-client quota. If the browser
  refresh timing changes, review these values together.
  Browser requests must be exact same-origin POST requests. Origin and Fetch
  Metadata validation is browser abuse mitigation, not authentication; a
  non-browser client that knows or steals the shared Caddy credential can
  construct those headers, spend the global issuance quota, or accumulate live
  credentials that consume coturn relay allocations and bandwidth. The edge
  gate blocks anonymous internet callers, while the standalone quotas limit but
  do not eliminate abuse by a credential holder until BATON identity and study
  membership are connected.
- `MAX_SIGNALING_CONNECTIONS=1000` and
  `MAX_SIGNALING_CONNECTIONS_PER_CLIENT=12` bound concurrent WebSocket
  handshakes. `SIGNALING_ABUSE_WINDOW_MS=10000` applies frame limits of 600 per
  session, 1,200 per effective client address, and 3,600 globally through
  `SIGNALING_MAX_FRAMES_PER_SESSION`, `SIGNALING_MAX_FRAMES_PER_CLIENT`, and
  `SIGNALING_MAX_FRAMES_GLOBAL`. Session overages close only that connection;
  client and global overages drop the frame. The global frame limit must be at
  least twice the client limit. Disconnecting and reconnecting from the same
  address does not reset its current client window. Expired inactive windows
  are cleaned on connect and by the periodic sweep; the bounded map evicts only
  inactive entries and never active client state.
- `VITE_ICE_TRANSPORT_POLICY=all` is the normal release setting. The tag-based
  release workflow also publishes a separate `-relay` edge image to prove media
  crosses TURN rather than a direct candidate. Never use that relay-only image
  as the normal study-room release.
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

## Publish immutable release images

Set the non-secret GitHub Actions repository variable `ROUND_STUN_URLS` to the
comma-separated production STUN URLs compiled into the browser bundle. Use the
production TURN hostname, for example `stun:turn.example.com:3478`. The release
workflow fails before publishing if this variable is missing.

After the release candidate is merged and its normal branch CI is green, create
and push an annotated SemVer tag:

```bash
git tag -a v0.1.0-rc.1 -m "ROUND v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

`.github/workflows/release-images.yml` reruns repository and deployment checks,
then publishes Linux AMD64 and ARM64 images to GHCR:

```text
ghcr.io/<owner>/round-edge:<tag>
ghcr.io/<owner>/round-edge:<tag>-relay
ghcr.io/<owner>/round-signaling:<tag>
ghcr.io/<owner>/round-turn:<tag>
```

Each image also receives a full `sha-<commit>` tag. The workflow summary records
the manifest digest for every image. Copy the normal edge, signaling, and TURN
digest references into `ops/production.env`; use the relay-only edge digest
only for the relay gate. Never move or overwrite an existing release or SHA
tag.

Ensure the production host can pull the packages before deployment. Public
packages need no registry credential. A private package requires a narrowly
scoped GHCR credential with package read access stored in the host's Docker
credential store, not in `ops/production.env`.

## Validate, build, and start

Validate interpolation without printing the rendered secret:

```bash
docker compose --env-file ops/production.env config --quiet
```

CI runs the same interpolation against temporary dummy credentials and
certificates, builds the pinned custom Caddy runtime, verifies that its
rate-limit module is present, validates the Caddyfile with that exact binary,
checks every Dockerfile runtime target, and builds all three images:

```bash
bash ops/ci/validate-deployment.sh
```

For a local syntax and target check that does not build the three final Compose
images, add `--check-only`. That mode still builds the smaller custom Caddy
validation target because a stock Caddy binary cannot parse or validate the
rate-limit directive.

Build the three target images and start the stack:

```bash
docker compose --env-file ops/production.env build --pull
docker compose --env-file ops/production.env up -d --wait --wait-timeout 120
docker compose --env-file ops/production.env ps
```

Do not run plain `docker compose config` in shared logs: its rendered output
contains `TURN_SHARED_SECRET`.

The tracked sample uses GHCR release tags so the same file remains usable for a
local source build. For production, set `ROUND_EDGE_IMAGE`,
`ROUND_SIGNALING_IMAGE`, and `ROUND_TURN_IMAGE` to the manifest digests from the
release workflow. Pin the optional base-image variables to digests as well. A
digest-based host deployment can use:

```bash
docker compose --env-file ops/production.env pull
docker compose --env-file ops/production.env up -d --no-build
```

Only Caddy uses Docker port publishing; coturn binds its documented ports
directly through the Linux host network. Signaling listens on `8787` solely on
the internal Compose network. Its room membership is held in memory, so
`deploy.replicas` is intentionally fixed at one; horizontal scaling requires a
shared room registry and cross-node signaling before it is safe.

The edge binary includes the community `github.com/mholt/caddy-ratelimit`
module pinned to commit
`5625512f24f6f59d6f64fb3aafe5eecff0b286db`. It is not an official Caddy
module. Treat changes to that pin like any other security-sensitive dependency:
review upstream code and compatibility, rebuild the validation target, and let
the release workflow produce a fresh SBOM instead of tracking a moving branch.

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
read -r -p 'ROUND access user: ' ROUND_ACCESS_USER
read -r -s -p 'ROUND access password: ' ROUND_ACCESS_PASSWORD
printf '\n'
export ROUND_ACCESS_USER ROUND_ACCESS_PASSWORD
ROUND_URL=https://round.example.com \
TURN_PROBE_HOST=turn.example.com \
TURN_PROBE_IMAGE=coturn/coturn:4.14.0-r0-alpine \
ops/turn/probe.sh
unset ROUND_ACCESS_PASSWORD
```

The monitor needs `curl`, `jq`, GNU `timeout`, and Docker. Pin
`TURN_PROBE_IMAGE` to the same reviewed coturn digest as the deployment. The
probe uses the shared access credential without printing the password, fetches
a fresh short-lived TURN credential without printing it, verifies the
advertised URLs and expiry, and creates authenticated client-to-client relay
traffic over UDP, TCP, and TLS. Store the monitor's plaintext password in its
secret manager, not in the deployment env file or command arguments. Treat a
nonzero exit as a deployment failure. Run it every one to five minutes from the
external network and alert after an appropriate number of consecutive failures.

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
- Treat disclosure of the shared pilot password as disclosure of every room.
  Generate a new password and bcrypt cost-12 hash, update
  `ROUND_ACCESS_PASSWORD_HASH`, recreate only `edge`, redistribute the new
  plaintext out of band, and revoke the old credential immediately.
- Keep the relay range consistent in the env file, coturn firewall, router
  forwarding, and cloud security group.
- Roll back by restoring all three prior immutable image references and running
  `docker compose ... up -d --no-build`. Do not scale signaling above one.
