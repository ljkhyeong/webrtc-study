# ROUND pilot release checklist

ROUND is ready for a study-group pilot only after every P0 item below has an
owner, a date, and a passing result. Automated browser media stubs are useful
for regression testing, but they do not replace the real-device checks in this
document.

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
      `/signal`, `/healthz`, and `/api/turn-credentials` remain observable with
      headers removed and query strings redacted.

## Relay-only test

Run this test from two physical devices on different networks. One device
should use home Wi-Fi and the other cellular tethering or another ISP.

- [ ] Deploy the release workflow's `-relay` edge image without changing the
      signaling or TURN image digests.
- [ ] Both participants can see and hear each other.
- [ ] Ordered DataChannel chat works in both directions.
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

Screen sharing, recording, persistent chat, accounts, BATON integration, and
rooms larger than six are explicitly outside this pilot gate.
