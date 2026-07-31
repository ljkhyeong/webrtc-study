# ROUND architecture

ROUND is intentionally split into four components and remains independently deployable from
BATON. BATON integrates through an authenticated service boundary rather than absorbing the
signaling runtime.

```text
apps/web          React room UI
apps/signaling    Java 21 + Spring Boot raw WebSocket signaling server
packages/protocol Shared, versioned signaling and peer DataChannel wire contracts
packages/rtc-core Framework-free WebRTC room engine
```

## MVP topology

Each participant opens one `RTCPeerConnection` per remote participant. Audio, video, and chat
data travel directly between browsers. The signaling server only helps peers discover each
other and forwards SDP/ICE messages. When a direct route is unavailable, coturn relays the
encrypted WebRTC packets without exposing their media contents to the Java application.

This mesh topology keeps the first version inexpensive and self-hostable. It is deliberately
limited to six participants because upload bandwidth and CPU use grow with every peer.

## Portability boundary

- `@round/rtc-core` never imports React, a router, or a CSS framework.
- `@round/protocol` owns browser-side wire-message types and runtime validation.
- `apps/signaling` mirrors protocol v2 validation at its WebSocket boundary and keeps room state
  in memory under `com.personal.round.signaling`.
- `apps/web` adapts room snapshots to React and owns all presentation.
- Room identity is an opaque string. BATON authorizes that room before issuing a participation
  grant without changing the peer engine.

## DataChannel delivery boundary

`@round/protocol` also owns the browser-to-browser `chat.message`, `chat.ack`, and
`participant.media` frames. Chat remains ephemeral and peer-to-peer: the Java signaling service
does not inspect, relay, acknowledge, or store these frames.

A local message remains `pending` until every intended peer's current `RoomSession` validates and
records the message and returns `chat.ack`. The acknowledgement means application acceptance, not
that a person read the message. All acknowledgements produce `sent`; confirmed acknowledgements
mixed with terminal peer failures produce `partial`; no confirmed recipient produces `failed`.
Duplicate retransmissions are deduplicated by `(peerId, messageId)` but acknowledged again so an
ACK lost during channel recovery can converge without displaying the chat twice.

Each peer may own at most 50 unacknowledged chat frames, with a corresponding byte cap and a
45-second absolute delivery deadline. The browser pauses normal chat before the DataChannel send
buffer would exceed 256 KiB and resumes after `bufferedamountlow` at 64 KiB. Bounded ACK control
frames are flushed before the latest coalesced media state and queued chat.

`chat.ack` is an additive peer protocol frame and does not change the Java signaling protocol
version. ROUND currently deploys the web client atomically rather than negotiating this capability:
all pilot participants must reload after a web release. A stale client that does not implement ACK
may display the chat, but the new sender fails closed with a receive-confirmation failure after the
45-second deadline instead of reporting false success.

## Identity and authorization boundary

BATON owns users, studies, schedules, and the decision that a user may join a study room. ROUND owns
only ephemeral room and peer state, raw WebSocket signaling, and TURN credential issuance. ROUND
does not share BATON's database or entities and does not synchronously call BATON on every
signaling frame.

After checking membership, BATON issues a short-lived JWT participation grant signed with
`RS256`; its JOSE header carries the public-key `kid`. BATON adds a new public key to its JWK Set
before switching issuance and retains the previous key until the old grant lifetime and clock skew
have elapsed. The grant is delivered in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The
cookie path is scoped to `/round/rooms/{roomId}` so grants for multiple rooms do not collide. The
required claims are `iss`, `aud=round`, `sub`, `exp`, `iat`, `jti`, `room_id`, `study_id`,
and `role=host|participant`.

The browser and internal routing contracts are:

| Purpose                     | Public same-origin path                             | Processing boundary                    |
| --------------------------- | --------------------------------------------------- | -------------------------------------- |
| Participation-grant refresh | `/round/rooms/{roomId}/participation-grant/refresh` | BATON-owned; never proxied to ROUND    |
| WebSocket signaling         | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`               |
| TURN credential             | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials` |

ROUND accepts only `RS256` and verifies the signature from BATON's JWK Set, issuer, audience,
expiry, and every required claim locally. The default maximum grant lifetime is five minutes, with
only 60 seconds of clock skew allowed for a future `iat`; longer grants are rejected even when
their signature and `exp` are otherwise valid. The path `roomId` must match `room_id` for the
WebSocket upgrade and TURN request. The verified grant is carried into the WebSocket session, and
`room.join` must match both the path and claim before room admission. BATON mode fails closed when
the ticket or verifier configuration is missing or invalid. Standalone mode retains the existing
coarse shared edge credential for the small pilot.

The established socket retains an immutable lease from the grant used at its handshake. ROUND
checks that lease on connection, before inbound quota and outbound enqueue, during heartbeat, and
in a one-second sweep. It closes an expired socket with
`4001 / Participation grant expired`. Wall-clock `exp` and a connection-time monotonic deadline
both apply, so moving the system clock backwards cannot lengthen a lease. The normal idempotent
disconnect path releases the room, admission reservation, outbound queue, and gauges exactly once.
Standalone access has no lease deadline.

BATON connection admission counts both in-progress handshakes and established sockets. The same
participation-grant `jti` can own only one reservation, while the same
`(room_id, sub)` can own two reservations so a reconnect with a freshly issued grant may briefly
overlap the old socket. A replay of the same grant or a third participant-room connection receives
HTTP 429 without evicting either established socket. The reservation lasts for the whole socket
lifetime rather than only room membership, so `room.leave` cannot be used to bypass the limit.
Standalone mode is unaffected.

The signaling service must continue to own peer IDs, overwrite the wire-level sender identity, and
relay SDP/ICE only between peers that are currently in the same room. A generic MVC interceptor,
argument resolver, or STOMP message rule cannot replace these checks because ROUND uses raw
WebSocket frames after the HTTP upgrade.

## Production boundary

`localhost` is allowed to use camera and microphone without TLS. Any deployed environment must
use HTTPS/WSS. A production deployment also needs a TURN service for users behind restrictive
NAT or corporate networks; STUN alone cannot guarantee connectivity.

Caddy is the only public HTTP entrypoint. In standalone mode it requires the shared access
credential for the static browser build, `/signal`, and `/api/turn-credentials`, strips the
Authorization header before proxying, and leaves only `/healthz` public for availability checks.
In BATON mode the same-origin edge maps the room-scoped public paths above to ROUND and Spring
Security validates the participation cookie before the signaling and TURN operations. The
participation-grant refresh path remains in BATON, where current identity and membership are
rechecked.
The BATON-owned Vite build uses `VITE_ROUND_AUTH_MODE=baton`; the browser derives all three paths from
the same canonical room ID and rejects endpoint overrides so it cannot accidentally fall back to
the standalone transport boundary.

Room state, participation connection reservations, and TURN issuance windows are in memory, so
running multiple signaling replicas would split one logical room and enforce each participant
limit independently until shared room, admission, and quota registries, room routing, and
cross-node relay are introduced. A participation grant is checked at the WebSocket upgrade and room
join, then bounds that socket until its own `exp`. BATON membership revocation is therefore visible
at the next refresh, while an already established socket may remain authorized until the current
short-lived grant expires.

The coturn shared secret exists only in the signaling and TURN runtimes. The browser requests a
time-limited HMAC credential from `/api/turn-credentials` in standalone mode or the room-scoped
endpoint in BATON mode; no long-lived TURN password is compiled into the Vite bundle.
BATON issuance atomically applies fixed-window quotas for the effective client address,
`(room_id, sub)`, and the whole server. A newly issued `jti` or changed client address does not
reset the participant window. Standalone issuance retains only the client and global dimensions.
Quota metrics expose bounded scope labels rather than participant, room, token, or address values.

The accepted service-boundary decision and complete claim contract are recorded in
[ADR 0001](adr/0001-round-independent-service.md).

## Resilience boundary

Prejoin owns camera and microphone tracks until the user explicitly enters. Ownership then moves
to `RoomSession`, which keeps local tracks alive across a bounded signaling reconnect while
discarding stale remote peer connections and the old server-owned peer ID. A local leave or
exhausted recovery stops every owned track and timer.

BATON mode starts with participation-grant refresh, then TURN issuance, then WebSocket creation.
The browser refresh manager is single-flight and schedules the next refresh from the server's
relative `refreshAfterSeconds` using a monotonic browser clock. TURN refresh and every initial or
reconnect WebSocket creation call the same `ensureFresh()` guard first. A successful refresh rotates
only the `HttpOnly` cookie; it does not proactively disconnect the current socket. At the old
socket's original grant expiry, ROUND closes it and the existing bounded reconnect path creates a
fresh socket with the new cookie while preserving local media and chat history.

ICE recovery uses one deterministic offer initiator per peer pair to avoid glare. A disconnected
peer gets a short grace period, then an ICE restart, followed by peer-connection recreation if the
restart does not recover. Every ROUND offer starts a bounded `negotiationId` generation that its
answer and ICE candidates echo. Recreated peers reject messages from retired generations so delayed
SDP or ICE cannot corrupt the single replacement attempt. Protocol v2 marks this wire-contract change;
the web client and signaling server must be deployed together, and current ROUND clients always send
the optional field. Raising the room limit or adding multiple video sources should move the media
topology to an SFU instead of extending this mesh recovery model indefinitely.
