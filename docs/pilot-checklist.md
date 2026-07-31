# ROUND pilot release checklist

ROUND is ready for a study-group pilot only after every P0 item below has an
owner, a date, and a passing result. Automated browser media stubs are useful
for regression testing, but they do not replace the real-device checks in this
document.

This checklist validates the tracked standalone Compose and its shared Basic
Auth boundary. `compose.yml` is intentionally fixed to
`ROUND_AUTH_MODE=standalone`; do not mark these checks as evidence for a BATON
deployment. A BATON-backed study must also pass the separate integration gate
at the end of this document.

## Release candidate

- [ ] The release commit is immutable and tagged.
- [ ] The tag-triggered release workflow passes and records normal edge,
      relay-only edge, signaling, and TURN manifest digests.
- [ ] `npm run check` passes from a clean checkout.
- [ ] The production Compose configuration renders without missing variables.
- [ ] `ops/ci/validate-deployment.sh` passes with temporary dummy fixtures.
- [ ] The previous immutable image set is available for rollback. For the first
      pilot, service shutdown and DNS removal are recorded as the explicit
      rollback until a known-good deployed image set exists.
- [ ] The signaling service is configured as exactly one replica.

## Public network path

- [ ] HTTP redirects to HTTPS.
- [ ] HTTP Basic Auth is never accepted over plaintext HTTP; the web app loads
      over HTTPS without mixed-content warnings.
- [ ] Missing or incorrect shared credentials receive `401` for the static app,
      `/signal`, and `/api/turn-credentials`, while `/healthz` remains public.
- [ ] More than 96 credential-bearing requests from one client network within
      five minutes receive `429`, while headerless challenges and `/healthz` do
      not consume that expensive-authentication budget.
- [ ] On the actual pilot host with at least two logical CPUs, send 96
      simultaneous, syntactically valid Basic requests whose usernames are all
      distinct and confirmed absent from the Caddy user map, and whose passwords
      are also distinct. This guarantees the cost-14 unknown-user fake-hash path
      instead of the cheaper configured-user cost-12 path. Run the burst while
      six physical participants maintain the representative peak session,
      preferably with the relay-only image so TURN and signaling carry their
      pilot peak together. Record edge and host CPU, memory, container restarts,
      direct signaling `/healthz`, public `/healthz`, and a correctly
      authenticated request from a second network. All six participants must
      keep audio, video, and chat connected; both health requests and the
      second-network request must complete within five seconds; no container may
      restart or be OOM-killed; and all measurements must return to their
      pre-test range within three minutes after the invalid requests finish.
      Record that the attacking network remains intentionally limited for the
      remainder of its five-minute window. Accept this standalone-pilot residual
      risk explicitly before exposure.
- [ ] Authenticated `wss://<domain>/signal` accepts the exact production Origin,
      and the authenticated TURN credential POST succeeds.
- [ ] A foreign, missing, wildcard, or non-HTTPS Origin is rejected.
- [ ] The signaling container port is not reachable directly from the public
      internet.
- [ ] Only the bcrypt cost-12 password hash is stored in the deployment env; the
      plaintext shared password is absent from Git, images, shell history, and
      logs, and `Authorization` is removed before proxying to signaling.
- [ ] The shared credential was delivered out of band, its leak-and-rotation
      procedure was rehearsed, and the team accepts that it is temporary until
      BATON identity and study-membership authorization replace it.
- [ ] TURN shared secrets are absent from Git, image history, browser bundles,
      access logs, and application logs.
- [ ] Visiting an invite path leaves no room code in Caddy access logs, while
      every route—including shared-auth `401` and rate-limit `429`—remains
      visible by status with headers and URI removed and client addresses
      hashed.

## Relay-only test

Run this test from two physical devices on different networks. One device
should use home Wi-Fi and the other cellular tethering or another ISP.

- [ ] Deploy the release workflow's `-relay` edge image without changing the
      signaling or TURN image digests.
- [ ] Both participants can see and hear each other.
- [ ] Ordered DataChannel chat works in both directions.
- [ ] Each sender leaves **전송 확인 중** only after the remote browser displays the message;
      closing or timing out one recipient produces a partial or failed receive-confirmation state
      without resending to recipients that already acknowledged it.
- [ ] Every participant reloads the web client after a release; a deliberately stale pre-ACK
      client fails closed at the 45-second receive-confirmation deadline rather than showing false
      success.
- [ ] `RTCPeerConnection.getStats()` shows a selected candidate pair whose
      local candidate type is `relay`.
- [ ] UDP relay succeeds.
- [ ] TCP or TLS relay fallback succeeds when UDP is blocked.

## Permission and device behavior

- [ ] Opening an invite link does not request media permission or open a
      WebSocket before an explicit user action.
- [ ] The prejoin screen previews the selected camera.
- [ ] The selected camera and microphone are used after joining.
- [ ] Camera denial or absence still permits an audio-only join.
- [ ] Microphone denial or absence still permits a video-only join.
- [ ] The user can retry device setup or intentionally join without media.
- [ ] Permission, missing-device, and busy-device errors give a Korean next
      action instead of a raw browser exception.

## Recovery behavior

- [ ] Signaling connect, room join, and peer connection each have a bounded
      timeout; no spinner waits forever.
- [ ] Switching between Wi-Fi and a hotspot recovers without a page refresh.
- [ ] A ten-second network interruption recovers within fifteen seconds after
      connectivity returns.
- [ ] Restarting the signaling process triggers bounded automatic re-entry.
- [ ] Recovery does not leave duplicate participant tiles or ghost room slots.
- [ ] Choosing **Leave** cancels all reconnect and ICE-recovery timers.
- [ ] Exhausted retries show **Reconnect** and **Leave** actions.

## Browser and device matrix

Record the exact browser and OS versions used.

| Device               | Browser     | 2-person | 4-person | 6-person | Background/foreground |
| -------------------- | ----------- | -------- | -------- | -------- | --------------------- |
| Desktop or laptop    | Chrome/Edge | [ ]      | [ ]      | [ ]      | N/A                   |
| macOS                | Safari      | [ ]      | [ ]      | [ ]      | N/A                   |
| iPhone/iPad          | Safari      | [ ]      | [ ]      | [ ]      | [ ]                   |
| Android phone/tablet | Chrome      | [ ]      | [ ]      | [ ]      | [ ]                   |

For every checked cell, verify join, remote audio/video, chat, mute, camera
toggle, leave, rejoin, invite-copy behavior, and zero unexpected console errors.

## Capacity and soak

- [ ] Two and four participants remain connected for at least thirty minutes.
- [ ] Six physical participants remain connected for at least ninety minutes.
- [ ] A two-participant relay-only session remains connected for four hours.
- [ ] Six relay-only participants can join concurrently without coturn
      `user-quota`, `total-quota`, or relay-port exhaustion; observed allocation
      counts are recorded before changing the defaults.
- [ ] Six-person video uses the documented low-bandwidth capture policy and
      keeps audio intelligible.
- [ ] RTT, packet loss, outbound bitrate, process memory, open file
      descriptors, and TURN egress are recorded.
- [ ] No browser crash, unbounded queue growth, ghost peer, or unexplained
      disconnect occurs.

## Operations

- [ ] `docker compose up -d --wait --wait-timeout 120` passes the local
      signaling, edge, and TURN-listener startup gates.
- [ ] The external authenticated TURN probe passes UDP, TCP, and TLS from a
      network outside the TURN host and its NAT using monitor credentials from
      a secret store.
- [ ] The TLS probe verifies both the certificate chain and
      `TURN_PROBE_HOST`; an untrusted certificate or hostname mismatch makes the
      deployment gate fail before relay traffic is attempted.
- [ ] A nonzero external TURN probe result triggers the pilot deployment gate
      or the configured production alert.
- [ ] Edge `/healthz` and the local STUN listener are not accepted as proof of
      public TURN authentication or relay-media health.
- [ ] Active rooms, peers, rejected connections and joins, invalid or
      session/client/global-limited frames, queue overflow, and heartbeat
      closures are observable without logging room IDs, names, SDP, ICE
      candidates, or chat text.
- [ ] A graceful SIGTERM rejects new joins, closes existing sockets with a
      restart-appropriate code, and exits within the configured timeout.
- [ ] The previous image can be restored and smoke-tested in five minutes.

## Pilot stages

1. Run a two-to-three-person pilot with the maintainer present.
2. Fix every P0 issue and repeat the failed scenario.
3. Run a full study session with the intended group, up to six people.
4. Promote only if the full session completes without a manual page refresh or
   an unexplained media loss.

Screen sharing, recording, persistent chat, accounts, and rooms larger than six
are explicitly outside this pilot gate. BATON integration is outside the
standalone gate above and has its own required checks below.

## BATON integration gate

Run these checks against the BATON-owned edge and a separately deployed ROUND
instance. Do not change the bundled standalone Compose to perform them.

### 2026-07-31 local rehearsal evidence (not production approval)

- [x] Production images, Caddy local-CA HTTPS, mock OIDC, real MySQL session and
      active OWNER/MEMBER memberships, BATON RS256/JWK, BATON-mode web/signaling,
      and local coturn were composed behind the BATON-owned edge.
- [x] Two isolated Chromium identities completed refresh 200, TURN credential
      200, WSS entry, relay-only nominated UDP candidate pairs, bidirectional
      audio/video traffic, acknowledged chat, remote media-state propagation,
      and normal leave.
- [x] The hardened lifecycle re-ran with a file-mounted TURN secret shared by
      Spring `configtree` and coturn's tmpfs config; the secret was absent from
      container argv, environment, and logs, and cleanup proved zero remaining
      project containers, volumes, and networks.
- [x] The local safety suite rejects unsafe/symlinked/forged state, Compose
      2.24.3, stale volumes/networks, ambient Compose overrides, and failed
      cleanup; SIGINT/SIGTERM return 130/143.
- [ ] This local evidence does not cover real Google OIDC, public DNS/ACME,
      physical media devices, public TURN/NAT/firewall behavior, TCP/TLS relay
      fallback, external networks, key rotation, two full grant lifetimes,
      long-session stability, or six-person load.

The unchecked production gate below remains authoritative.

- [ ] BATON has a real authenticated user identity and current study-membership
      authorization. A shared access key, display name, or other client claim is
      not used as `sub`; without this boundary the BATON gate cannot pass.
- [ ] The ROUND deployment uses `ROUND_AUTH_MODE=baton`, the exact BATON
      issuer, `aud=round`, the production HTTPS JWK Set URI, a maximum grant
      lifetime of at most five minutes, and BATON's exact HTTPS origin. Removing
      any required verifier setting makes startup fail.
- [ ] BATON signs grants with `RS256`, includes the signing key's `kid` in the
      JOSE header, and keeps the private key absent from ROUND. ROUND receives
      only the public JWK Set. A rehearsed rotation publishes the new key before
      issuance switches and keeps both public keys available until the previous
      grant lifetime and clock skew have elapsed.
- [ ] BATON issues the grant only as an `HttpOnly`, `Secure`,
      `SameSite=Strict` cookie scoped to
      `/round/rooms/{roomId}` with no `Domain` attribute. Tokens are absent from
      URLs, browser storage, proxy logs, application logs, and monitoring labels.
- [ ] The edge maps `/round/rooms/{roomId}/signal` to
      `/rooms/{roomId}/signal` and
      `/round/rooms/{roomId}/turn-credentials` to
      `/api/rooms/{roomId}/turn-credentials`, preserving the room ID,
      WebSocket upgrade, original `Origin`, and cookie. It leaves
      `/round/rooms/{roomId}/participation-grant/refresh` in BATON and never
      proxies that path to ROUND.
- [ ] The BATON-owned web bundle is built with `VITE_ROUND_AUTH_MODE=baton`
      and no signaling or TURN endpoint override. A direct invite remains at
      prejoin without a protected request; explicit entry uses only the three
      room-scoped public paths and never the standalone endpoints.
- [ ] The edge discards client-supplied forwarding headers, sets the canonical
      HTTPS host and client address itself, and applies a bounded pre-auth rate
      limit to all three room-scoped public paths.
- [ ] Refresh requires an authenticated BATON session, rechecks current study
      membership, exact same-origin `Origin`, and
      `Sec-Fetch-Site: same-origin`, and exposes no CORS access. Success rotates
      a host-only Strict cookie with a fresh `jti` and expiry, returns only
      numeric `expiresAt` and `refreshAfterSeconds`, and sets
      `Cache-Control: no-store`. No JWT reaches JavaScript, URLs, or logs.
- [ ] Concurrent grant checks share one refresh request. The browser schedules
      `refreshAfterSeconds` from a monotonic relative clock rather than
      subtracting its wall clock from `expiresAt`.
- [ ] Missing, malformed, expired, wrong-signature, wrong-issuer,
      wrong-audience, and wrong-room grants are rejected for both WebSocket
      upgrade and TURN credential issuance.
- [ ] A grant with `iat` more than 60 seconds in the future or with
      `exp - iat` above `ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS` is rejected.
- [ ] A valid grant cannot join a different room by changing the public path,
      internal path, or `room.join` payload, and the rejected attempt creates
      no room or participant state.
- [ ] A foreign, missing, wildcard, or non-HTTPS Origin is rejected even when
      the request carries an otherwise valid grant.
- [ ] The Java signaling port is reachable only from the BATON edge and
      monitoring plane. `/actuator/prometheus` and
      `/actuator/metrics/**` are private, and any public health rule exposes
      only transport-only `GET /healthz`.
- [ ] The BATON page's `Permissions-Policy` permits its own camera and
      microphone use, and `connect-src` permits the room-scoped WSS endpoint
      without widening either policy to unrelated origins.
- [ ] A valid participant can complete signaling, obtain and refresh TURN
      credentials, refresh the grant before expiry, and remain in one room for
      at least two full grant lifetimes. At the old socket's own `exp`, ROUND
      closes it with `4001 / Participation grant expired`; the browser uses the
      refreshed cookie to reconnect without a page refresh while preserving
      local media and chat history.
- [ ] BATON or its database can be unavailable without interrupting signaling
      frames on an already-established socket only until its current grant
      expires. Refresh and reconnect remain fail-closed, and the socket closes
      at expiry, until BATON recovers.
- [ ] An idle or unjoined socket is closed by `exp + 1s` at the latest, and
      moving the ROUND wall clock backwards does not extend the monotonic lease
      deadline. Expiry releases admission reservations, room membership,
      outbound queue state, and gauges exactly once and emits one `peer.left`.
- [ ] A second concurrent WebSocket using the same `jti` receives HTTP 429
      without evicting the established socket. After that socket closes, the
      same still-valid grant can connect again because the policy is not a
      permanent one-time-token store.
- [ ] Two sockets for the same `(room_id, sub)` can overlap only with distinct
      freshly issued `jti` values, even if their `study_id` values differ. A
      third receives HTTP 429, and closing either accepted socket immediately
      makes one slot available.
- [ ] TURN issuance for the same `(room_id, sub)` reaches the configured quota
      even when BATON issues fresh `jti` values or the client address changes.
      The rejected response is an empty HTTP 429 with `Cache-Control: no-store`
      and a positive `Retry-After`; another room or participant remains
      independent.
- [ ] `round.turn.credentials.rate_limited` is collected with only the bounded
      `scope` label. No participant, room, token, or address value appears in
      metrics or logs, and the monitoring runbook distinguishes participant,
      client, global, and state-capacity pressure.
- [ ] `round.signaling.authorization.closes` is collected as an identity-free
      counter without participant, room, `jti`, role, or address tags.
- [ ] The BATON socket and TURN checks above do not change standalone behavior.
      Standalone TURN issuance remains limited by client IP and server-wide
      quota without creating participant quota state. Standalone creates no
      grant-refresh request, lease timer, or authorization-close event.
- [ ] The BATON integration probe obtains a real short-lived participation
      grant, refreshes the room cookie without printing either token, confirms
      a fresh `jti` and the exact no-store metadata response, and validates UDP,
      TCP, and TLS relay paths. The standalone Basic Auth probe is not used as
      proof of this boundary.
- [ ] Rollout was rehearsed in the order BATON identity/membership/refresh and
      edge, new web bundle, then ROUND active lease. Rollback was rehearsed in
      the exact reverse order.
