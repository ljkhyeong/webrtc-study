# ROUND standalone production deployment

This stack runs one in-memory Java signaling replica behind Caddy and a
host-networked coturn relay. Caddy serves the Vite build, terminates HTTPS/WSS,
and proxies only `/signal`, `/healthz`, and `/api/turn-credentials` to the
unpublished signaling port. The standalone pilot places one shared Caddy Basic
Auth gate in front of the static app, WebSocket upgrade, and TURN credential
endpoint; only `/healthz` remains public.

The tracked `compose.yml`, `ops/caddy/Caddyfile`, and
`ops/production.env.example` are one standalone deployment contract.
`compose.yml` intentionally injects `ROUND_AUTH_MODE=standalone` as a literal;
an operator cannot turn this stack into a BATON deployment by adding an
environment variable. BATON integration needs its own edge configuration and
deployment manifest as described in [BATON deployment contract](#baton-deployment-contract).
Do not copy the shared Basic Auth edge unchanged and switch only the Java
process to BATON mode.

## BATON deployment contract

ROUND remains a separately deployed service when BATON embeds a study room.
BATON owns user identity, study membership, participation-grant issuance, and
the public same-origin edge. ROUND owns only its in-memory room and peer state,
WebSocket signaling, and TURN credential issuance. The services do not share a
database, and ROUND verifies each participation grant locally rather than
calling BATON for every signaling frame.

The BATON integration branches now implement the authenticated identity,
active study-membership, refresh, edge, and JWK boundaries described here and
have passed the local production-like rehearsal below. That rehearsal is not a
public production deployment approval. Continue deriving `sub` only from the
verified BATON account; never derive it from a shared access key, client-supplied
display name, or another self-asserted value.

The BATON-owned ROUND signaling manifest must configure all of these values:

```dotenv
SPRING_PROFILES_ACTIVE=production
ROUND_AUTH_MODE=baton
ROUND_AUTH_COOKIE_NAME=__Secure-round_access
ROUND_AUTH_ISSUER=https://baton.example.com
ROUND_AUTH_AUDIENCE=round
ROUND_AUTH_JWK_SET_URI=https://baton.example.com/.well-known/jwks.json
ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS=300
ALLOWED_ORIGINS=https://baton.example.com
```

The BATON-owned web bundle must separately be built with:

```dotenv
VITE_ROUND_AUTH_MODE=baton
VITE_SIGNALING_URL=
VITE_TURN_CREDENTIALS_URL=
```

Vite embeds these non-secret values at build time. The browser then derives
all three public room paths from the current origin and the canonical room ID. BATON
mode rejects non-empty endpoint overrides instead of silently bypassing the
room-scoped cookie path. The tracked standalone image remains built for
`VITE_ROUND_AUTH_MODE=standalone`.

Build the dedicated BATON runtime image with the browser contract and isolated
`/round-ui/` asset base:

```bash
docker build \
  --target baton-web-runtime \
  --tag round-baton-web:local \
  .
```

The target hard-codes BATON mode, serves `/room/*` and `/round-ui/*` on port
8080, and carries both `io.round.auth-mode=baton` image metadata and an internal
mode marker. The release workflow publishes it separately as
`round-baton-web`; do not substitute the standalone `round-edge` image. BATON's
outer edge remains responsible for the public-to-private routes below.

Use the exact issuer and JWK Set URI from the BATON environment. Production
issuer and JWK URLs must use HTTPS. `ROUND_AUTH_AUDIENCE` must equal the
participation grant's `aud`; keep `round` unless both services deliberately
version this contract. ROUND needs only BATON's public JWK Set and must never
receive BATON's private signing key. Missing verifier configuration must stop a
BATON-mode instance from starting rather than downgrade it to standalone.
`ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS` defaults to 300, may be configured only
between 30 and 900 seconds, and is enforced against `exp - iat`. ROUND also
rejects an `iat` more than 60 seconds in the future.

BATON sets the participation grant as an `HttpOnly`, `Secure`,
`SameSite=Strict` cookie named `__Secure-round_access` by default. Its path is
scoped to `/round/rooms/{roomId}`, and the `Domain` attribute must be omitted
so the cookie remains host-only. The grant must not be put in a query string,
browser storage, proxy log, or client-visible JavaScript. The public and internal
routes are a versioned integration contract:

| Operation                   | Browser-facing BATON path                           | Processing boundary                    |
| --------------------------- | --------------------------------------------------- | -------------------------------------- |
| Participation-grant refresh | `/round/rooms/{roomId}/participation-grant/refresh` | BATON-owned; never proxied to ROUND    |
| WebSocket signaling         | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`               |
| TURN credential POST        | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials` |

For signaling, the BATON edge removes the leading `/round` segment. For TURN
credentials, it rewrites the public path to the table's `/api/rooms/...`
endpoint. Both rewrites must preserve the same `roomId`. The edge must preserve
the WebSocket upgrade and the browser's `Origin` header; it must not synthesize
a trusted Origin. Configure `ALLOWED_ORIGINS` to BATON's exact HTTPS origin and
keep the existing Origin and Fetch Metadata checks in addition to JWT
verification. The edge must also allow camera, microphone, and `display-capture` for the BATON page
through `Permissions-Policy` and include the room-scoped WSS path in its
`connect-src` policy.

BATON handles the refresh POST itself. It must require an authenticated session,
recheck current study membership, require the exact same-origin `Origin` and
`Sec-Fetch-Site: same-origin`, expose no CORS policy, and apply a dedicated
abuse limit. Success rotates the host-only room cookie with a fresh `jti` and
expiry, sets `Cache-Control: no-store`, and returns exactly:

```json
{
  "expiresAt": 1780000000,
  "refreshAfterSeconds": 240
}
```

No JWT or other token material may enter the response body or browser-visible
JavaScript.

BATON mode rejects wildcard, `null`, and non-loopback HTTP WebSocket origins
even if the `production` profile is accidentally absent. The deployment must
still set `SPRING_PROFILES_ACTIVE=production` so the rest of ROUND's production
configuration validation remains active.

The BATON edge must discard client-supplied `Forwarded` and
`X-Forwarded-*` values, then set the canonical host, client address, and HTTPS
scheme itself. Only that trusted edge may reach the signaling port. Apply a
bounded pre-auth rate limit to all three room-scoped public paths so membership
lookups, signing, invalid JWT signature checks, and WebSocket upgrades cannot
be used as an unbounded CPU workload; size the burst for normal refreshes and
reconnects by all six participants.

Do not expose the Java signaling port on a host interface, load balancer, or
public security group. Bind it only to a private container or service network
reachable from the BATON edge and the monitoring plane. Keep exactly one ROUND
signaling replica while room state is in memory; a generic round-robin load
balancer would split one room across independent processes.

Health and metrics have a narrower trust boundary than room traffic:

- `GET /healthz` is transport-only and contains no BATON, room, or participant
  state. Prefer an internal readiness probe. If an external uptime check is
  required, expose only this exact path through a dedicated edge rule.
- `/actuator/prometheus` and `/actuator/metrics/**` are for the private
  monitoring network only. Never map them below BATON's public `/round/**`
  prefix or expose the signaling port to collect them.
- Only signaling and TURN in the table are public ROUND operations in BATON
  mode. Participation-grant refresh remains in BATON. Do not proxy standalone
  `/signal` or `/api/turn-credentials`.

The BATON web flow is participation-grant refresh, TURN issuance, then
WebSocket creation. It uses the server's relative `refreshAfterSeconds` on a
monotonic browser clock, rejects values outside `1..300` seconds, and refreshes
before TURN renewal and every initial or reconnect WebSocket creation. Refresh
rotates only the cookie and does not force an early socket reconnect.

ROUND binds each socket to the grant used at its handshake. It checks expiry
before inbound quota use and outbound enqueue, during heartbeat, and in a
one-second sweep. At that grant's `exp`, or its connection-time monotonic
deadline if the wall clock moves backwards, ROUND performs the normal
idempotent disconnect and closes with `4001 / Participation grant expired`.
An idle or unjoined expired socket is therefore closed no later than one sweep
interval after expiry. The bounded browser reconnect then uses the refreshed
cookie. Standalone sockets remain unbounded. A BATON-mode TURN credential is
still capped at the participation grant's `exp` even when the configured TURN
TTL is longer. Key rotation needs an overlap window in which the JWK Set
publishes both the retiring and new public key until every short-lived grant
signed by the retiring key has expired.

ROUND counts both in-progress handshakes and active sockets in BATON mode. The
same `jti` may own one reservation, and the same
`(room_id, sub)` may own two so that one reconnect with a freshly issued grant
can overlap the old socket. Reusing the same grant concurrently or opening a
third participant-room socket returns HTTP 429 without evicting an established
connection. Closing the owning socket releases the slot; merely sending
`room.leave` does not. These counters are process-local and therefore rely on
the current single-replica deployment. Scale-out requires a shared admission
registry together with shared room state and routing.

BATON TURN issuance adds a process-local fixed-window quota for each
`(room_id, sub)` alongside the existing effective-client and server-wide
limits. A newly issued `jti`, role or study claim change, or client-address
change does not reset that participant window. The default is six issues per
ten minutes while tracking at most 10,000 participant-room identities. Set
`TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` and
`TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS` in the BATON signaling manifest;
the bundled standalone manifest intentionally omits them because its endpoint
does not have a verified participant.

`round.turn.credentials.rate_limited` has a bounded `scope` label:
`client`, `participant`, `global`, `client_state_capacity`, or
`participant_state_capacity`. Alert on the total and investigate scope ratios,
but never add `sub`, room ID, `jti`, or client address as monitoring labels.
The participant quota complements rather than replaces coturn's user and total
allocation limits.

Collect `round.signaling.authorization.closes` as an identity-free counter.
Never add participant, room, `jti`, role, or address tags to it.

This repository's `ops/turn/probe.sh` authenticates with the standalone shared
Basic credential and therefore is not a BATON authentication probe. A BATON
deployment needs an integration probe that obtains a real short-lived grant
through BATON, refreshes it without exposing the JWT, verifies a fresh `jti`
cookie and no-store metadata response, keeps the cookie out of command
arguments and logs, and calls the room-scoped TURN endpoint. The TURN
allocation and TLS checks after credential issuance remain the same.

### Compatible BATON rollout

Deploy in this order:

1. BATON authenticated identity, study-membership checks, the refresh endpoint,
   and all three edge routes and limits.
2. The BATON web bundle with proactive refresh and the pre-connect guard.
3. ROUND signaling with active grant-lease closure.

Deploying the web bundle before the refresh endpoint makes explicit entry fail
closed. Deploying ROUND lease closure before the new web bundle makes old
clients lose signaling at each short grant expiry without a refreshed cookie.
Rollback in reverse order: ROUND lease closure, web bundle, then the BATON
refresh route and identity boundary.

The complete claims and ownership decision are recorded in
[ADR 0001](adr/0001-round-independent-service.md).

### Local production-like BATON rehearsal

On 2026-07-31 the integration branches completed an isolated BATON-owned-edge
rehearsal with production images, Caddy local-CA HTTPS, mock Google OIDC, real
MySQL sessions and memberships, RS256/JWK verification, BATON-mode ROUND web
and Java signaling, and a loopback-published coturn instance. Run its managed
lifecycle from the BATON repository:

```bash
ROUND_REPOSITORY_ROOT=/absolute/path/to/round \
  ./ops/tests/round-local-tls-stack.sh up
./ops/tests/round-local-tls-stack.sh status
./ops/tests/round-local-tls-stack.sh down
```

Two isolated Chromium profiles used different OIDC accounts with active OWNER
and MEMBER memberships. Both completed refresh, TURN credential issuance, and
WSS entry. With `iceTransportPolicy=relay`, both selected nominated, succeeded
UDP pairs whose local and remote candidate types were `relay`; candidate bytes,
inbound audio packets/bytes, and inbound video frames/bytes all increased in
both directions. Bidirectional DataChannel chat reached `sent`, remote
microphone/camera-off state propagated, and normal member then owner leave
updated the room state.

The hardened lifecycle was then repeated with one mode-`0600` TURN shared-secret
file mounted read-only for Spring `configtree`; the coturn wrapper read the same
mount and wrote its runtime configuration into tmpfs.
All seven long-running services were healthy, the BATON JWK Set returned 200,
an anonymous canonical refresh returned JSON 401 with `no-store` and a request
ID, a query-bearing refresh returned 404, Caddy validated its live config, and
the random TURN secret was absent from signaling/coturn argv, environment, and
logs. The managed cleanup removed its containers, networks, volumes, keys, and
fixture data only after verifying the Compose project was empty.

This rehearsal does **not** prove real Google OIDC, public DNS or ACME, physical
camera/microphone devices, a public TURN address through NAT/firewalls,
UDP-blocked TCP/TLS fallback, an external network, dual-key rotation, two full
grant lifetimes, long-session stability, or six-person load. Keep the production
gate open until those checks pass in the deployment environment.

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

### Linux host bootstrap and preflight

Use a dedicated, patched Linux host with systemd, NTP synchronization, at least
5 GiB free on the deployment filesystem, Docker Engine, and Docker Compose
2.24.4 or later. Install Docker from its operating-system-specific official
repository rather than piping an unreviewed installer into a shell. Restrict
SSH to the operator network. Install `jq`, OpenSSL, `age`, Certbot, util-linux
(`flock`), and GNU coreutils (`timeout`) from the distribution repositories.
The lifecycle scripts deliberately target only the rootful local Docker socket
at `unix:///var/run/docker.sock`; remote contexts and rootless endpoints are not
an accepted production topology. Expose only this ROUND data plane:

| Port           | Protocol | Owner  |
| -------------- | -------- | ------ |
| `80`, `443`    | TCP      | Caddy  |
| `443`          | UDP      | Caddy  |
| `3478`, `5349` | TCP/UDP  | coturn |
| `49160-49259`  | UDP      | coturn |

Keep signaling port `8787` private to the Compose backend network. Apply the
same relay range to the host firewall, upstream security group, and NAT/router;
a mismatch in any one layer causes intermittent TURN allocation failures.

The checked-in systemd templates assume this layout:

```text
/opt/round/                         reviewed ROUND checkout
/etc/round/production.env          mode-0600 runtime configuration
/etc/round/backup-recipients.txt   public age recipient(s), when backup is configured
/var/lib/round/                     non-secret release/certificate state
/var/backups/round/                 local encrypted backup staging only
```

Use absolute `TURN_TLS_CERT_FILE` and `TURN_TLS_KEY_FILE` paths in the host env.
The preflight never sources that file as shell code and never renders Compose
configuration to the terminal. It rejects mutable image tags, a non-Linux host,
an unsynchronized clock, low disk on the checkout, Docker data root, or release
state filesystem, non-`0600` env permissions, a TURN secret shorter than 64
hexadecimal characters, an invalid single-replica topology, and a TURN
certificate that mismatches its mode-`0400`/`0600` private key, hostname, or
minimum remaining lifetime:

```bash
cd /opt/round
sudo install -d -m 0700 \
  /etc/round \
  /var/lib/round \
  /var/lib/round/releases \
  /var/lib/round/certificates \
  /var/backups/round
sudo install -m 0600 ops/production.env /etc/round/production.env
sudo ops/linux/preflight.sh /etc/round/production.env
```

`preflight.sh` cannot prove the public IPv4, router/NAT mappings, security-group
rules, DNS propagation, or off-host relay path. Record those separately with
the external probe and browser network matrix.

### Temporary macOS study pilot

The Linux Compose topology remains the production contract. For a short-lived
study test on Docker Desktop, layer `compose.macos-pilot.yml` on top of
`compose.yml` and use `ops/macos-pilot.env`. The override publishes coturn and
its relay range explicitly on Docker Desktop, gives coturn a fixed bridge
address, and binds Caddy to alternate Mac host ports so another local service
can keep port 80.

The override uses the Compose-specific `!override` and `!reset` merge tags, so
Docker Compose **2.24.4 or later** is required. The deployment validator rejects
an older or unparseable version before it renders the override. Docker documents
the version requirement in its
[Compose merge reference](https://docs.docker.com/reference/compose-file/merge/#replace-value).

```bash
docker compose version --short
cp ops/macos-pilot.env.example ops/macos-pilot.env
chmod 0600 ops/macos-pilot.env
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

The Caddy command prompts without echoing the plaintext. Paste the complete
`$2a$12$...` or `$2b$12$...` output between the single quotes in
`ROUND_ACCESS_PASSWORD_HASH=''`, then fill every other blank value. Before
rendering Compose, run this prefix check. It returns success only when exactly
one assignment has a single-quoted cost-12 bcrypt prefix, and it never prints
the hash or plaintext:

```bash
if awk -F "'" '
  /^ROUND_ACCESS_PASSWORD_HASH=/ {
    seen += 1
    if (NF == 3 && $2 ~ /^\$2[ab]\$12\$/) valid += 1
  }
  END { exit !(seen == 1 && valid == 1) }
' ops/macos-pilot.env; then
  printf 'macOS pilot bcrypt cost is 12\n'
else
  printf 'macOS pilot bcrypt hash is missing, malformed, or not cost 12\n' >&2
  exit 1
fi

docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  config --quiet
```

Before starting the stack, reserve the Mac's LAN address in DHCP and configure
the router with these mappings. The left side is the public port and the right
side is the Mac destination:

| Public port   | Protocol | Mac destination                          |
| ------------- | -------- | ---------------------------------------- |
| `80`          | TCP      | `ROUND_HTTP_BIND_PORT` (default `8080`)  |
| `443`         | TCP      | `ROUND_HTTPS_BIND_PORT` (default `8443`) |
| `443`         | UDP      | `ROUND_HTTPS_BIND_PORT` (default `8443`) |
| `3478`        | TCP/UDP  | `3478`                                   |
| `5349`        | TCP/UDP  | `5349`                                   |
| `49160-49259` | UDP      | same range                               |

The HTTP and HTTPS translations still deliver the public ACME ports to Caddy's
container ports 80 and 443. `turn.b4ton.com` must remain DNS-only at Cloudflare,
and coturn still requires a publicly trusted certificate at the configured
`TURN_TLS_CERT_FILE` and `TURN_TLS_KEY_FILE` paths. Keep the Mac awake, disable
automatic sleep for the test window, and stop the stack afterward. This Docker
Desktop topology is a pilot convenience only; it is not evidence for the Linux
production gate or a substitute for the external TURN probe.

The macOS override also mounts `ops/caddy/Caddyfile.macos-pilot`. Mobile Safari
and some Android browsers do not consistently reuse a page's HTTP Basic Auth
credential for the `/signal` WebSocket upgrade, so this pilot-only policy keeps
the UI and static assets behind Basic Auth while excluding `/signal` and
`/api/turn-credentials` from that coarse edge gate. Those two routes still pass
through the signaling service's exact-origin validation, connection and frame
limits, and TURN issuance quotas. This is a short-lived compatibility tradeoff:
non-browser clients can forge an Origin header, so do not copy the exception to
the Linux production Caddyfile or treat it as user authentication.

For the same reason, a TURN probe that happens to send the shared Basic Auth
credential through this macOS edge does **not** prove that the credential was
checked for `/api/turn-credentials`; that route deliberately bypasses the edge
gate. Such a probe proves only that an exact-origin-shaped request obtained a
short-lived credential and that coturn authenticated that credential while
relaying traffic. Record the static UI's `401`, the transport Origin rejection,
and the TURN relay result as three separate pieces of evidence.

If either default host port is already occupied, set a free value in
`ops/macos-pilot.env` and change the router destination to the same value. Do
not stop an unrelated local service merely to preserve the example port.

The included coturn configuration is IPv4-only. Do not publish an `AAAA` record
for the TURN hostname without adding and testing an IPv6 relay configuration.

#### Build, start, inspect, and stop the macOS pilot

Run every Compose operation with the same base file, macOS override, and env
file. Omitting any one of them changes the topology or project identity.

Build the three local images from the current checkout, then start the stack and
wait for every Compose health check:

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  build --pull

docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  up -d --wait --wait-timeout 120
```

Inspect container state and both the internal signaling health endpoint and the
public HTTPS edge. Replace the example origin if the env uses another domain:

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  ps

docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  exec -T signaling wget -q -T 2 -O - http://127.0.0.1:8787/healthz

ROUND_PILOT_ORIGIN=https://round.b4ton.com
curl --fail --silent --show-error "$ROUND_PILOT_ORIGIN/healthz"
```

Show a bounded diagnostic snapshot, or follow logs during the study. Pressing
Ctrl-C exits only the `logs --follow` command; it does not stop the containers.

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  logs --tail=200 edge signaling turn

docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  logs --follow --tail=100 edge signaling turn
```

After the study, stop and remove the pilot containers and network:

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  down --remove-orphans
```

This deliberately preserves the `caddy_data` and `caddy_config` named volumes,
including Caddy's ACME state. Do not add `--volumes` unless permanent certificate
state removal is explicitly intended.

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

For a standalone host, generate a second, unrelated secret with at least 32 random bytes; a
64-character hexadecimal value from `openssl rand -hex 32` is the recommended shape. Give its
plaintext only to people who should receive disable-only media controls, and put only its lowercase
SHA-256 digest in `ROUND_STANDALONE_HOST_TOKEN_SHA256`. The sample env shows a hidden-input command
that computes the digest without writing the plaintext to a file. One digest grants host powers in
every standalone room on that signaling instance. Rotating it therefore means changing the digest,
restarting signaling, and having existing hosts reconnect; already admitted hosts retain their
resolved role until disconnect. Leave the value blank when no host controls are needed. BATON
deployments do not accept this key because their signed participation-grant `role` is authoritative.

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
- `ROUND_STANDALONE_HOST_TOKEN_SHA256` grants only same-room, disable-only microphone and camera
  controls after a successful join. It is not a substitute for site access, participant identity,
  or membership authorization. Store only the digest in the runtime env and distribute the
  plaintext separately from the Basic Auth password.
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
- BATON deployments also set
  `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` and
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`. The defaults allow six
  credential issues per `(room_id, sub)` in the same window and keep at most
  10,000 live participant windows. Size the client and server-wide quotas
  together so the intended number of legitimate participants can each use
  their participant budget. These maps are process-local and fail closed at
  capacity without evicting an active quota window; scale-out requires a shared
  quota registry.
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
effective capabilities. The host ACME client owns issuance. ROUND's deploy hook
only accepts the resulting files after checking the private key, TURN hostname,
and seven-day lifetime floor, recreates only coturn from
`/var/lib/round/releases/current.env`, and immediately proves the trusted
hostname and leaf fingerprint actually served on `127.0.0.1:5349`:

```bash
sudo /opt/round/ops/linux/reload-turn-certificate.sh /etc/round/production.env
```

For unattended Linux renewal, use an ACME DNS plugin backed by a narrowly
scoped Cloudflare API token stored outside the repository with mode `0600`.
The currently used interactive manual DNS-01 challenge is not an unattended
renewal method. Let the distribution-provided Certbot timer remain the single
renewal scheduler. Install ROUND's persistent deploy hook, then prove the
selected authenticator and the hook together; `--run-deploy-hooks` is required
because a plain dry run skips deploy hooks:

```bash
sudo install -m 0755 \
  ops/linux/certbot/round-turn-deploy-hook \
  /etc/letsencrypt/renewal-hooks/deploy/round-turn
sudo certbot renew --dry-run --run-deploy-hooks
sudo install -m 0644 \
  ops/linux/systemd/round-turn-certificate-reconcile.* \
  ops/linux/systemd/round-ops-failure@.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now round-turn-certificate-reconcile.timer
systemctl list-timers round-turn-certificate-reconcile.timer
sudo systemctl start round-turn-certificate-reconcile.service
```

The hook stores only the listener-verified fingerprint under
`/var/lib/round/certificates`; it does not copy the certificate or key. An
unchanged fingerprint skips recreation but still verifies the live listener.
Certbot does not make its overall renewal exit status a reliable assertion that
every deploy hook applied successfully, so the independent reconciliation
timer retries idempotently after a missed hook and then runs the same live
listener check. The service allows the full Compose health budget, retries a
failure after five minutes up to the unit start limit, then marks a persistent
failure and emits a `daemon.crit` `round-ops` record through its `OnFailure`
unit. Connect systemd unit failures or those records to the host's external
alerting agent; the local journal alone is not an off-host notification. Once
enabled, the external TURN monitor is an additional public-path alert.

`certbot renew --dry-run --run-deploy-hooks` invokes the hook with the currently
active certificate, so it proves hook permissions, locking, and the current
listener check but does not prove that a newly issued certificate required a
coturn recreation. Preserve the first real unattended renewal log and its
successful reconciliation result as that evidence. Monitor both timers and
public certificate expiry.

## Publish immutable release images

After the release candidate is merged and its normal branch CI is green, create
an annotated SemVer tag. Put the comma-separated production STUN URLs compiled
into the browser bundle in exactly one `ROUND_STUN_URLS=` line in the tag
message. Use the production TURN hostname, for example:

```bash
git tag -a v0.1.0-rc.1 \
  -m "ROUND v0.1.0-rc.1" \
  -m "ROUND_STUN_URLS=stun:turn.example.com:3478"
git push origin v0.1.0-rc.1
```

The release workflow rejects lightweight tags, tags that no longer resolve to
the triggering commit, forced tag updates, malformed STUN URI lists, and release
or full SHA image tags that already exist. It records the annotated tag object's
Git ID and verifies that the object is unchanged immediately before promotion.
Keeping the browser build input in that object prevents a mutable repository
variable from silently changing a run's output. Protect `v*` tags from updates
and deletion with a repository tag ruleset so queued and manually rerun
workflows cannot observe a replaced tag object.

`.github/workflows/release-images.yml` reruns repository and deployment checks,
then builds Linux AMD64 and ARM64 manifests under digest-only references. It
checks that every build completed and that all final tags are still unused
before promoting the four digests, then verifies that all eight promoted tags
resolve to the expected build digests. Release workflow runs are serialized per
repository and retained in the release queue. The user-facing production edge
is promoted last so an earlier promotion failure does not expose the entrypoint
tag:

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
tag. GHCR cannot promote tags across multiple image repositories atomically, so
an infrastructure failure during the final promotion can leave only a subset
of tags visible. Treat every visible tag as consumed, do not rerun over it, and
publish a new SemVer tag only after investigating the failed release.

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
checks every Dockerfile runtime target, builds and inspects the BATON-mode web
runtime, and builds all three standalone images:

```bash
bash ops/ci/validate-deployment.sh
```

For a local syntax and target check that does not build the three final Compose
images, add `--check-only`. That mode still builds the smaller custom Caddy
validation target and BATON web runtime because a stock Caddy binary cannot
parse the rate-limit directive and a Dockerfile syntax check cannot verify the
embedded auth flavor or `/round-ui/` asset base.

For a local image-validation host, build the three targets and start the stack:

```bash
docker compose --env-file ops/production.env build --pull
docker compose --env-file ops/production.env up -d --wait --wait-timeout 120
docker compose --env-file ops/production.env ps
```

Do not run plain `docker compose config` in shared logs: its rendered output
contains `TURN_SHARED_SECRET`.

The tracked sample uses GHCR release tags so the same file remains usable for a
local source build. `ops/linux/preflight.sh` intentionally rejects that sample.
For production, set `ROUND_EDGE_IMAGE`,
`ROUND_SIGNALING_IMAGE`, and `ROUND_TURN_IMAGE` to the manifest digests from the
release workflow. Pin the optional base-image variables to digests as well. A
digest-based Linux deployment uses the guarded wrapper:

```bash
sudo ops/linux/deploy.sh /etc/round/production.env
```

All mutating Linux lifecycle commands require the reviewed clean checkout;
tracked, staged, or untracked repository changes make them fail before touching
Docker. Ignored secret and certificate files remain outside that Git
cleanliness check. The deploy command runs the read-only preflight, clears
ambient Compose/build interpolation
variables, pulls exactly the three configured digests, uses Compose's health
wait, confirms `edge`, `signaling`, and `turn` are running, and only then records
`/var/lib/round/releases/current.env`. The state records the three digests
together with the checked-out source commit, `compose.yml` digest,
runtime-config digest, Compose project, ROUND domain, and fixed local Docker
endpoint. This is an auditable operator association, not proof that the images
were built from that checkout; retain the release workflow's manifest evidence
separately. Image lines are deliberately excluded from the runtime-config
digest because the immutable image identities are stored as separate fields.
On the next successful deployment, the old complete state moves to
`previous.env`.

Once pull/up begins, the candidate is retained as `in-progress.env` until the
deployment succeeds. Any failure therefore blocks another deploy. Inspect the
logs and run the explicit rollback: it detects the marker and redeploys
`current.env`, rather than incorrectly skipping back two releases. If the very
first deployment failed and no verified `current.env` exists, rollback instead
runs Compose down, confirms that no project container remains, and clears the
marker while leaving the host stopped. A rollback attempt also writes its own
target/origin journal; failure blocks deploy, backup, and certificate reload
until another rollback invocation restores a stable verified state. If Compose
or non-image runtime configuration changed between releases, restore the saved
checkout and matching secret-manager version before rollback; the command
fails closed on either digest mismatch.

ROUND does not negotiate the additive `chat.ack` DataChannel capability. After
the new stack passes the checks below, require every participant with an active
ROUND tab to reload and rejoin before resuming chat. Do not treat a mixed
old/new web-client room as a valid rollout: an old receiver may display a
message without acknowledging it, causing the new sender to fail closed after
the 45-second delivery deadline.

Only Caddy uses Docker port publishing; coturn binds its documented ports
directly through the Linux host network. Signaling listens on `8787` solely on
the internal Compose network. Its room membership is held in memory, so
`deploy.replicas` is intentionally fixed at one; horizontal scaling requires a
shared room registry and cross-node signaling before it is safe.

This statement applies to the bundled standalone stack. BATON deployments must
provide the same private-port and single-replica guarantees in their own
orchestrator rather than reusing this Compose file with an auth-mode override.

The edge binary includes the community `github.com/mholt/caddy-ratelimit`
module pinned to commit
`5625512f24f6f59d6f64fb3aafe5eecff0b286db`. It is not an official Caddy
module. Treat changes to that pin like any other security-sensitive dependency:
review upstream code and compatibility, rebuild the validation target, and let
the release workflow produce a fresh SBOM instead of tracking a moving branch.

## Verify the running service

```bash
curl --fail --silent --show-error https://round.example.com/healthz
openssl s_client \
  -connect turn.example.com:5349 \
  -servername turn.example.com \
  -verify_hostname turn.example.com \
  -verify_return_error \
  </dev/null >/dev/null
docker compose --env-file ops/production.env logs --tail=100 edge signaling turn
```

The Compose TURN healthcheck is a local unauthenticated STUN listener check. It
is useful for container liveness and makes `docker compose up --wait` fail when
coturn is not listening, but it does not prove that public TURN allocation,
authentication, NAT forwarding, or relay media works. Likewise, a passing edge
`/healthz` proves only Caddy-to-signaling reachability. Keep both
`-verify_hostname` and `-verify_return_error` on the manual TLS check: a plain
`s_client` connection can complete even when certificate verification reports
an error.

Run the authenticated relay probe from a Linux monitoring host outside the TURN
server and its NAT:

```bash
read -r -p 'ROUND access user: ' ROUND_ACCESS_USER
read -r -s -p 'ROUND access password: ' ROUND_ACCESS_PASSWORD
printf '\n'
export ROUND_ACCESS_USER ROUND_ACCESS_PASSWORD
ROUND_URL=https://round.example.com \
TURN_PROBE_HOST=turn.example.com \
TURN_PROBE_IMAGE=coturn/coturn@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4 \
ops/turn/probe.sh
unset ROUND_ACCESS_PASSWORD
```

The monitor needs `curl`, `jq`, `openssl`, GNU `timeout`, and Docker. Pin
`TURN_PROBE_IMAGE` to the same reviewed coturn digest as the deployment. The
probe uses the shared access credential without printing the password, fetches
a fresh short-lived TURN credential without printing it, verifies the
advertised URLs and expiry, verifies the TLS certificate chain and DNS hostname
with the monitor host's OpenSSL trust store, and only then creates authenticated
client-to-client relay traffic over UDP, TCP, and TLS. For an intentionally
private TURN CA, set `TURN_PROBE_CA_FILE` to its readable regular PEM CA bundle;
the probe snapshots it into a mode-`0600` temporary file and uses the same bytes
for the host TLS check and the read-only coturn utility container mount. Do not
disable verification. Store the monitor's plaintext password in its secret
manager, not in the deployment env file or command arguments. Treat a nonzero
exit as a deployment failure.

### Protected external TURN workflow

The manual `External TURN pilot probe` GitHub Actions workflow runs the same
probe from a GitHub-hosted Linux runner outside the TURN host and its NAT. Before
the first run:

1. Protect the default branch with required pull-request review. Require code
   owner review for `.github/workflows/external-turn-probe.yml`,
   `ops/turn/probe.sh`, `ops/turn/verify-tls.sh`, both
   `ops/turn/resolve-external-*.sh` scripts,
   `ops/turn/external-pilot-target.properties`, and
   `ops/ci/*external-turn-workflow*.mjs`. Where the repository plan supports
   them, prevent self-review and administrator bypass.
2. Review `ops/turn/external-pilot-target.properties` through that protected
   pull request. It currently targets `round.b4ton.com` and `turn.b4ton.com`;
   reserved example hosts are rejected at runtime. The file must contain the
   exact public ROUND origin, public TURN hostname, and reviewed
   `coturn/coturn@sha256` image. Updating any destination or digest therefore
   leaves a reviewable Git history entry.
3. Create a `round-pilot` environment restricted to the default branch. Add a
   required reviewer and prevent self-review where the repository plan supports
   those controls. Store only these environment secrets:

| Secret                  | Value                                              |
| ----------------------- | -------------------------------------------------- |
| `ROUND_ACCESS_USER`     | Standalone shared-access username                  |
| `ROUND_ACCESS_PASSWORD` | Standalone shared-access plaintext password        |
| `TURN_PROBE_CA_PEM`     | Optional private TURN CA PEM; omit for a public CA |

Dispatch the workflow from the default branch and provide the annotated release
tag that the operator believes is deployed to the pilot. A secret-free first
job rejects other branches, malformed or lightweight tags, releases not
reachable from the current default branch, example destinations, and images
outside the reviewed `coturn/coturn` repository. Only then does the
`round-pilot` job read credentials and exercise UDP, TCP, and TLS.

The run summary records the operator-declared tag, tag object SHA, release
commit, workflow commit, public targets, and probe image digest. It does **not**
query the running service revision, so it does not prove that the declared
release is deployed. Before accepting the run as pilot evidence, compare those
identifiers with the deployment platform or immutable image publication record,
and protect release tags against update and deletion with a `v*` tag ruleset.
Record the workflow run URL and that independent deployment-identity evidence.
Until promotion is automated, operators must treat a nonzero probe result as a
manual stop condition rather than claiming that GitHub blocked promotion.

Keep this release-evidence workflow manual until its first public-host run
succeeds and the responsible maintainer confirms that GitHub Actions failure
notifications are received. After that gate, create a separate `round-monitor`
environment restricted to the default branch and copy only the same three probe
secrets. Scheduled jobs cannot wait for a human environment reviewer, so this
environment relies on the protected default branch, code-owned workflow and
target files, empty top-level permissions, pinned checkout action, and
environment branch restriction. Enable the schedule only by setting the
repository variable `ROUND_EXTERNAL_TURN_MONITOR_ENABLED=true`.

`.github/workflows/external-turn-monitor.yml` then probes the reviewed
`round.b4ton.com`/`turn.b4ton.com` target every six hours. One transient result
does not alert: a run fails only after three consecutive full UDP/TCP/TLS probe
attempts with 20- and 40-second backoff. Confirm that the repository owner
receives that failed-workflow notification; setting the variable to any other
value leaves scheduled runs secret-free and skipped. The threshold is within
one run rather than persisted across runs, which avoids granting write
permissions merely to store monitor state. The monitor is availability evidence
only; the manual annotated-tag workflow remains the release evidence. Neither
standalone Basic Auth workflow proves the BATON participation-grant boundary,
and the coturn utility probe does not replace a browser UDP-blocked fallback
test.

The credential response contains `urls`, `username`, `credential`, and
`expiresAt` (epoch seconds), but never the shared secret. Confirm separately in
two browser/network combinations that WebSocket signaling connects and that
`chrome://webrtc-internals` or the equivalent browser diagnostics shows a
`relay` ICE candidate.

Caddy emits an access record for every route so shared-auth failures and
rate-limit responses remain observable. Request headers and the complete URI are
removed before encoding, while client and remote addresses are replaced with a
short stable hash. This preserves status-level correlation for `401` and `429`
without storing invite room codes, referrers, cookies, query credentials, or raw
IP addresses. Application and TURN logs must follow the same no-room-code and
no-credential rule. Caddy error logs omit request headers and URIs entirely.

## Operations

- Caddy ACME state lives in the `caddy_data` and `caddy_config` named volumes.
  `ops/linux/backup-caddy.sh` locks the same lifecycle boundary as deploy and
  rollback, stops `edge` only when it was already running, streams both volumes
  through the immutable edge image recorded in `current.env`, encrypts the
  archive directly with `age`, and restarts Caddy with a health wait. Plaintext
  backup data is never written to the host filesystem. Create an age identity
  on a separate trusted machine and place only its public recipient in
  `/etc/round/backup-recipients.txt`. First make one manual snapshot:

  ```bash
  sudo ops/linux/backup-caddy.sh \
    --recipient-file /etc/round/backup-recipients.txt \
    --output-dir /var/backups/round \
    /etc/round/production.env
  ```

  That local file is only a backup building block, not a completed backup
  policy. Do not enable a local-only timer or claim an RPO until an off-host
  backend, upload-success alert, retention policy, and restore rehearsal are
  selected. Prefer an established encrypted backup tool such as restic for the
  scheduled off-host transport instead of adding a custom uploader here. The
  ROUND script deliberately does not upload or prune archives.

  The restore command is destructive, requires the exact confirmation token,
  takes the lifecycle lock before inspection, rejects a live or stopped Compose
  container set, verifies the optional checksum and archive paths, creates
  missing named volumes on a fresh host, and leaves ROUND stopped for
  inspection:

  ```bash
  docker compose --env-file /etc/round/production.env down
  sudo ops/linux/restore-caddy.sh \
    --identity-file /secure/off-host/round-backup-identity.txt \
    --confirm RESTORE_CADDY_VOLUMES \
    /var/backups/round/round-caddy-YYYYMMDDTHHMMSSZ.tar.age \
    /etc/round/production.env
  sudo ops/linux/deploy.sh /etc/round/production.env
  ```

  Do not keep the age identity on the ROUND host. Back up
  `/etc/round/production.env` through the host's encrypted secret-backup system
  separately; it contains the TURN shared secret and cannot be reconstructed
  from Caddy volumes.

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
- Roll back the previous edge, signaling, and TURN digest references only as
  one tested set. The explicit token makes an accidental paste fail closed:

  ```bash
  sudo ops/linux/rollback.sh \
    --confirm ROLLBACK_ROUND \
    /etc/round/production.env
  ```

  The command re-runs preflight, pulls the saved immutable set, waits for all
  health checks, and swaps the complete `current.env`/`previous.env` states so a
  roll-forward remains possible. When `in-progress.env` exists, it instead
  redeploys the verified current state and clears the failed attempt only after
  health checks pass. Never substitute mutable tags or scale signaling above
  one. Record
  start/end time, restored digests, `docker compose ps`, service logs, public
  `/healthz`, TURN TLS verification, and the external relay result as rollback
  evidence. After success, require every active ROUND tab to reload and rejoin
  so no room mixes DataChannel capabilities from different web bundles.
