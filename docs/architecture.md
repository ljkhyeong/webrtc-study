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
- `apps/signaling` mirrors protocol v1 validation at its WebSocket boundary and keeps room state
  in memory under `com.personal.round.signaling`.
- `apps/web` adapts room snapshots to React and owns all presentation.
- Room identity is an opaque string. BATON authentication can be added in front of signaling
  without changing the peer engine.

## Production boundary

`localhost` is allowed to use camera and microphone without TLS. Any deployed environment must
use HTTPS/WSS. A production deployment also needs a TURN service for users behind restrictive
NAT or corporate networks; STUN alone cannot guarantee connectivity.

Caddy is the only public HTTP entrypoint. It serves the static browser build and proxies
`/signal`, `/healthz`, and `/api/turn-credentials` to one private signaling instance. Room state
is in memory, so running multiple signaling replicas would split one logical room until a shared
room registry and cross-node relay are introduced.

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
restart does not recover. Raising the room limit or adding multiple video sources should move the
media topology to an SFU instead of extending this mesh recovery model indefinitely.
