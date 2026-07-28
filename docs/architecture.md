# ROUND architecture

ROUND is intentionally split into four components so the real-time engine can move into BATON
without bringing this MVP's visual layer with it.

```text
apps/web          React room UI
apps/signaling    Java 21 + Spring Boot raw WebSocket signaling server
packages/protocol Shared, versioned signaling contract
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
- Room identity is an opaque string. BATON authentication can be added in front of signaling
  without changing the peer engine.

## Identity and authorization boundary

Inside the standalone MVP, possession of a valid room ID is enough to join and display names are not
verified identities. The production Caddy adds one coarse shared access credential in front of the
static app, WebSocket upgrade, and TURN credential endpoint. This blocks anonymous internet access,
but everyone who knows the shared credential still has the same capability. Spring Security is
therefore not installed just to create the appearance of per-user authentication without a user or
membership source. The edge credential, WebSocket Origin policy, connection admission, frame
limits, and TURN issuance quotas are layered pilot controls; they do not establish study membership.

BATON integration should reuse BATON's existing security model at two explicit seams:

1. Authenticate the `/signal` HTTP upgrade and the TURN credential POST through BATON's
   `SecurityFilterChain`, preferably with the existing secure same-origin session cookie or a
   short-lived one-time ticket rather than a long-lived token in the WebSocket URL.
2. Carry the authenticated principal into the `WebSocketSession` and check BATON study membership
   before accepting `room.join`. Protect TURN issuance with the same meeting membership and CSRF
   policy.

The signaling service must continue to own peer IDs, overwrite the wire-level sender identity, and
relay SDP/ICE only between peers that are currently in the same room. A generic MVC interceptor,
argument resolver, or STOMP message rule cannot replace these checks because ROUND uses raw
WebSocket frames after the HTTP upgrade.

## Production boundary

`localhost` is allowed to use camera and microphone without TLS. Any deployed environment must
use HTTPS/WSS. A production deployment also needs a TURN service for users behind restrictive
NAT or corporate networks; STUN alone cannot guarantee connectivity.

Caddy is the only public HTTP entrypoint. It requires the standalone shared access credential for
the static browser build, `/signal`, and `/api/turn-credentials`, strips the Authorization header
before proxying, and leaves only `/healthz` public for availability checks. Room state is in memory,
so running multiple signaling replicas would split one logical room until a shared room registry
and cross-node relay are introduced.

The coturn shared secret exists only in the signaling and TURN runtimes. The browser requests a
time-limited HMAC credential from `/api/turn-credentials`; no long-lived TURN password is compiled
into the Vite bundle.

## Resilience boundary

Prejoin owns camera and microphone tracks until the user explicitly enters. Ownership then moves
to `RoomSession`, which keeps local tracks alive across a bounded signaling reconnect while
discarding stale remote peer connections and the old server-owned peer ID. A local leave or
exhausted recovery stops every owned track and timer.

ICE recovery uses one deterministic offer initiator per peer pair to avoid glare. A disconnected
peer gets a short grace period, then an ICE restart, followed by peer-connection recreation if the
restart does not recover. Every ROUND offer starts a bounded `negotiationId` generation that its
answer and ICE candidates echo. Recreated peers reject messages from retired generations so delayed
SDP or ICE cannot corrupt the single replacement attempt. Protocol v2 marks this wire-contract change;
the web client and signaling server must be deployed together, and current ROUND clients always send
the optional field. Raising the room limit or adding multiple video sources should move the media
topology to an SFU instead of extending this mesh recovery model indefinitely.
