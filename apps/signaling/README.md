# ROUND signaling operations

The signaling process always exposes:

- `GET /healthz` for the legacy transport-only health check
- `GET /actuator/health/liveness` and `/actuator/health/readiness`
- `GET /actuator/prometheus` and `/actuator/metrics`

Room operations depend on `ROUND_AUTH_MODE`:

- `standalone`: WebSocket `/signal` and `POST /api/turn-credentials`
- `baton`: authenticated WebSocket `/rooms/{roomId}/signal` and
  `POST /api/rooms/{roomId}/turn-credentials`

The `production` Spring profile fails during startup unless every configured
`ALLOWED_ORIGINS` entry is an exact HTTPS origin. Wildcard, `null`, and HTTP
origins are forbidden in that profile. BATON mode independently rejects
wildcard, `null`, and non-loopback HTTP origins even when the profile is absent.

## Runtime safety

`server.shutdown=graceful` is combined with an early signaling lifecycle stop.
Once shutdown starts, new handshakes receive HTTP 503 and any handshake that
won the race is closed with WebSocket status 1001. Existing sessions are also
closed with 1001 and room state is cleared idempotently.

An unjoined socket is closed after `UNJOINED_SOCKET_TIMEOUT_MS` (15 seconds by
default). Incoming frames use a 10-second fixed window and are admitted in
session, effective client address, then global order. Defaults are 600 frames
per session, 1,200 across one client address, and 3,600 globally. A session
overage closes only that abusive connection; client and global overages drop
the frame without closing an arbitrary peer. An inactive client window remains
until its fixed window expires, so disconnecting and reconnecting from the same
address cannot reset quota. Expired inactive windows are removed on connect and
by the periodic unjoined-session sweep. The map is bounded by
`MAX_SIGNALING_CONNECTIONS`; capacity pressure evicts only inactive
least-recently-used entries and never active client state.
`MAX_SIGNALING_CONNECTIONS` defaults to 1,000 and
`MAX_SIGNALING_CONNECTIONS_PER_CLIENT` defaults to 12.

The client frame limit must be at least the session limit. The global limit
must be at least twice the client limit so one client's two misaligned fixed
windows cannot consume the server budget. The defaults retain a six-person ICE
candidate burst while bounding sustained floods.

Micrometer publishes these signaling meters:

- `round.signaling.rooms.active`
- `round.signaling.peers.connected`
- `round.signaling.peers.joined`
- `round.signaling.joins.rejected`
  (`reason=room_full|already_joined|unauthorized_room`)
- `round.signaling.frames.invalid`
- `round.signaling.frames.rate_limited`
- `round.signaling.frames.client_rate_limited`
- `round.signaling.frames.overloaded`
- `round.signaling.connections.rejected`
  (`reason=server_capacity|client_capacity|missing_reservation|missing_room_access`)
- `round.signaling.outbound.queue.overflows`
- `round.signaling.heartbeat.closes`
- `round.turn.credentials.issued`
- `round.turn.credentials.rate_limited`

Meter tags are deliberately bounded. Room IDs, display names, session/peer IDs,
SDP, ICE candidates, Origin/header values, TURN shared secrets, and issued TURN
credentials must never be logged or used as meter tags. Transport logs contain
only a fixed message and the exception class.

## Coturn REST credentials

Set both `TURN_SHARED_SECRET` and comma-separated `TURN_URLS`, or leave both
unset. A partial configuration fails startup without printing the secret. The
optional `TURN_CREDENTIAL_TTL_SECONDS` defaults to 600 seconds (ten minutes).

Credential issuance uses these additional bounded rate-limit settings:

| Environment variable                             | Default | Purpose                                                   |
| ------------------------------------------------ | ------: | --------------------------------------------------------- |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`      |   `600` | Fixed issuance window                                     |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`        |    `12` | Successful issues per effective client address and window |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS` |    `24` | Successful issues across this server and window           |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`         | `10000` | Maximum client windows retained in the in-memory LRU      |

The default ten-minute issuance window matches the ten-minute credential TTL.
Twelve issues per address cover the initial issue and the scheduled refresh for
all six room participants behind one NAT, while 24 global issues provide
server-wide headroom. The global quota must be at least twice the per-client
quota so one client cannot consume it across misaligned fixed-window
boundaries. If operators change the credential TTL or browser refresh timing,
they should review and normally align the issuance window and quotas as well.
In BATON mode the issued credential is additionally capped at the participation
grant's `exp`, so a longer TURN TTL cannot extend the grant's authority.

The credential endpoint returns a no-store response:

```json
{
  "urls": ["turn:turn.example.com:3478?transport=udp"],
  "username": "1780000000:base64url-random.sequence",
  "credential": "base64-hmac-sha1",
  "expiresAt": 1780000000
}
```

`expiresAt` is Unix epoch seconds. Every successful request receives a new
username and credential, including separate browsers behind the same NAT. The
endpoint accepts only POST requests with an exact same-origin `Origin`; when
Fetch Metadata is present, `Sec-Fetch-Site` must also be `same-origin`. Once an
effective client or the server reaches its issuance limit, the endpoint returns
an empty no-store HTTP 429 response with `Retry-After` set to the remaining whole
seconds in the current window.

Origin and Fetch Metadata checks prevent another website from spending a
visitor's quota through a browser. In standalone mode they do not authenticate
non-browser clients, which can construct these headers; the shared edge
credential, issuance limits, and short TTL bound but do not remove that
relay-exhaustion risk. BATON mode additionally requires a signed, room-scoped
participation grant.

When TURN is intentionally disabled, the endpoint returns an empty no-store
HTTP 204 response so local STUN-only development does not create a false
browser console error.

Only issuance counters are stored per client address; credentials are never
cached. The client-window map is bounded and neither addresses nor credentials
are logged or attached to metrics. With `server.forward-headers-strategy=native`,
Tomcat accepts `X-Forwarded-For` only from its configured internal proxy CIDRs.
The production signaling port therefore remains private behind Caddy, while a
direct untrusted peer cannot choose its rate-limit key with a spoofed header.

Room IDs accepted by the Java boundary are exactly three four-character
segments separated by hyphens, using
`abcdefghjkmnpqrstuvwxyz23456789` (for example `abcd-efgh-jkmp`).
