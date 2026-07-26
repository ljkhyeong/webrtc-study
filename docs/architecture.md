# ROUND architecture

ROUND is intentionally split into four workspaces so the real-time engine can move into BATON
without bringing this MVP's visual layer with it.

```text
apps/web          React room UI
apps/signaling    Stateless WebSocket signaling server
packages/protocol Shared, versioned signaling contract
packages/rtc-core Framework-free WebRTC room engine
```

## MVP topology

Each participant opens one `RTCPeerConnection` per remote participant. Audio, video, and chat
data travel directly between browsers. The signaling server only helps peers discover each
other and forwards SDP/ICE messages.

This mesh topology keeps the first version inexpensive and self-hostable. It is deliberately
limited to six participants because upload bandwidth and CPU use grow with every peer.

## Portability boundary

- `@round/rtc-core` never imports React, a router, or a CSS framework.
- `@round/protocol` owns wire-message types and runtime validation.
- `apps/web` adapts room snapshots to React and owns all presentation.
- Room identity is an opaque string. BATON authentication can be added in front of signaling
  without changing the peer engine.

## Production boundary

`localhost` is allowed to use camera and microphone without TLS. Any deployed environment must
use HTTPS/WSS. A production deployment also needs a TURN service for users behind restrictive
NAT or corporate networks; STUN alone cannot guarantee connectivity.
