# ROUND signaling 운영

signaling 프로세스는 항상 다음 경로를 노출합니다.

- 기존 전송 계층 전용 상태 확인을 위한 `GET /healthz`
- `GET /actuator/health/liveness`와 `/actuator/health/readiness`
- `GET /actuator/prometheus`와 `/actuator/metrics`

방 관련 작업은 `ROUND_AUTH_MODE`에 따라 달라집니다.

- `standalone`: WebSocket `/signal`과 `POST /api/turn-credentials`
- `baton`: 인증된 WebSocket `/rooms/{roomId}/signal`과
  `POST /api/rooms/{roomId}/turn-credentials`

BATON이 소유한 `POST /round/rooms/{roomId}/participation-grant/refresh` 경로는 이
프로세스에서 의도적으로 노출하지 않으며 절대로 이 프로세스로 proxy해서는 안 됩니다. BATON은
방 범위 cookie를 회전하기 전에 신원과 스터디 멤버십을 다시 확인합니다.

설정된 모든 `ALLOWED_ORIGINS` 항목이 정확한 HTTPS Origin이 아니면 `production` Spring
profile은 시작 중 실패합니다. 이 profile에서는 wildcard, `null`, HTTP Origin을 허용하지
않습니다. BATON 모드는 해당 profile이 없어도 wildcard, `null`, loopback이 아닌 HTTP
Origin을 별도로 거부합니다.

## 런타임 안전성

`server.shutdown=graceful`은 signaling 생명주기 조기 중지와 함께 사용합니다. 종료가 시작되면
새 handshake에는 HTTP 503을 반환하고 경합에서 먼저 완료된 handshake는 WebSocket 상태 1001로
닫습니다. 기존 session도 1001로 닫고 방 상태는 멱등하게 정리합니다.

입장하지 않은 socket은 `UNJOINED_SOCKET_TIMEOUT_MS`가 지나면 닫습니다(기본 15초). 수신
frame에는 10초 고정 window를 사용하며 세션, 유효 client 주소, 서버 전체 순서로 허용 여부를
판정합니다. 기본값은 세션당 600 frame, 하나의 client 주소 전체에서 1,200 frame, 서버 전체에서
3,600 frame입니다. 세션이 한도를 넘으면 해당 악성 연결만 닫고, client 또는 서버 전체가 한도를
넘으면 임의의 peer를 닫지 않고 frame을 버립니다. 비활성 client window는 고정 window가 만료될
때까지 유지하므로 같은 주소에서 연결을 끊었다가 다시 연결해도 quota를 초기화할 수 없습니다.
만료된 비활성 window는 연결 시점과 주기적인 미입장 session sweep에서 제거합니다. map 크기는
`MAX_SIGNALING_CONNECTIONS`로 제한합니다. 용량이 부족하면 비활성 상태 중 가장 오래 사용되지
않은 항목만 제거하며 활성 client 상태는 제거하지 않습니다. `MAX_SIGNALING_CONNECTIONS`의
기본값은 1,000이고 `MAX_SIGNALING_CONNECTIONS_PER_CLIENT`의 기본값은 12입니다. 같은
scheduler가 유휴 authorization 만료도 처리하므로 설정 가능한 주기는 100밀리초 이상 1초 이하인지
검증합니다.

BATON 모드에서는 검증된 참여권이 연결된 WebSocket의 불변 lease가 됩니다. ROUND는 연결 직후,
수신 quota 차감 전, 송신 enqueue 전, heartbeat와 pong 처리 중, 1초 주기의 session sweep에서
lease를 확인합니다. 만료 판정에는 참여권의 wall-clock `exp`와 연결 시 monotonic ticker를 기준으로
기록한 남은 수명을 모두 사용하므로 wall clock을 과거로 돌려도 lease가 연장되지 않습니다. 만료된
연결은 일반적인 멱등 disconnect 경로로 제거한 뒤 private 상태 `4001`과 정확한 reason
`Participation grant expired`로 닫습니다. 다른 활동이 없는 연결도 한 번의 sweep 주기 안에
닫습니다. HTTP decoder는 expiry skew가 0인 동일한 주입 clock을 사용하며 참여권 전용 미래 `iat`
허용 범위는 계속 60초입니다. Standalone 방 접근에는 lease deadline이 없습니다.

BATON 모드는 같은 참여권 `jti`마다 진행 중이거나 활성 상태인 WebSocket을 최대 하나, 같은
`(room_id, sub)`마다 최대 두 개 예약합니다. 두 번째 참가자-방 슬롯은 BATON이 새 `jti`를 발급한
경우에만 재연결 한 번이 겹치도록 허용합니다. 같은 참여권을 재사용하거나 세 번째 참가자-방
socket을 열면 HTTP 429를 반환하며 handshake admission은 기존 socket을 내보내지 않습니다.
여러 연결의 `room.join` 요청이 겹치면 연결 순번이 더 큰 WebSocket을 유지합니다. ROUND는
이전 참가자를 방에서 제거하고 이전 연결을 종료 코드 `4002`와 종료 사유
`Participation session superseded`로 닫습니다. 연결 종료 시도가 끝나면 연결 슬롯의 예약을 해제합니다.
종료 중 I/O 오류가 발생해도 해제는 한 번만 수행합니다.
지연된 join이 나중에 도착한 이전 socket은 대신 닫습니다. 브라우저는 `4002`를 terminal 상태로
처리하므로 두 socket이 재연결 takeover loop에 빠지지 않습니다. 그 밖의 경우에는 socket이 닫힐
때까지 reservation을 계속 소유하며, 입장하지 않은 연결 상태나 `room.leave` 이후도 포함합니다.
Standalone 모드에는 서버와 client IP 제한만 유지합니다.

client frame 제한은 세션 제한 이상이어야 합니다. 서버 전체 제한은 client 제한의 두 배
이상이어야 하므로 한 client의 어긋난 고정 window 두 개가 서버 예산을 소진할 수 없습니다.
기본값은 6명분의 ICE candidate burst를 허용하면서 지속적인 flood를 제한합니다.

Micrometer는 다음 signaling meter를 게시합니다.

- `round.signaling.rooms.active`
- `round.signaling.peers.connected`
- `round.signaling.peers.joined`
- `round.signaling.outbound.queue.bytes`
- `round.signaling.joins.rejected`
  (`reason=room_full|already_joined|unauthorized_room|invalid_host_capability`)
- `round.signaling.frames.invalid`
- `round.signaling.frames.rate_limited`
- `round.signaling.frames.client_rate_limited`
- `round.signaling.frames.overloaded`
- `round.signaling.frames.byte_limited` (`scope=session|client|global`)
- `round.signaling.connections.rejected`
  (`reason=server_capacity|client_capacity|participation_token_capacity|participant_room_capacity|missing_reservation|missing_room_access`)
- `round.signaling.outbound.queue.overflows` (peer별 또는 전체 송신 큐 제한으로 닫힌 peer 수)
- `round.signaling.outbound.queue.global_overflows` (전체 송신 바이트 한도에 걸린 frame 수)
- `round.signaling.heartbeat.closes`
- `round.signaling.authorization.closes`
- `round.auth.jwk.source.healthy` (BATON JWK 원격 소스가 정상이면 `1`, 장애면 `0`)
- `round.turn.credentials.issued`
- `round.turn.credentials.provider.errors`
- `round.turn.credentials.rate_limited`
  (`scope=client|participant|global|client_state_capacity|participant_state_capacity`)

meter tag는 의도적으로 제한된 값만 사용합니다. 방 ID, 표시 이름, session/peer ID, SDP, ICE
candidate, Origin/header 값, Cloudflare API token, 발급한 TURN credential은 절대로 기록하거나 meter
tag로 사용해서는 안 됩니다. 전송 log에는 고정된 메시지와 예외 class만 포함합니다.
authorization-close meter는 참가자, 방, 참여권 tag가 없는 identity-free counter입니다.

## Cloudflare TURN 자격 증명

운영에서는 `TURN_PROVIDER=cloudflare`, `TURN_CLOUDFLARE_KEY_ID`,
`TURN_CLOUDFLARE_API_TOKEN`을 함께 설정합니다. 로컬 STUN 전용 개발은
`TURN_PROVIDER=disabled`를 사용하고 두 Cloudflare 값을 비워 둡니다. 구성이 맞지 않으면
자격 증명을 출력하지 않고 시작에 실패합니다. `TURN_CREDENTIAL_TTL_SECONDS`의 기본값은
600초(10분)입니다.

credential 발급에는 다음과 같은 추가 제한형 rate-limit 설정을 사용합니다.

| 환경 변수                                             |  기본값 | 목적                                               |
| ----------------------------------------------------- | ------: | -------------------------------------------------- |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`           |   `600` | 고정 발급 구간                                     |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`             |    `12` | 구간당 유효 client 주소의 발급 시도 수             |
| `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` |     `6` | 구간당 BATON `(room_id, sub)`의 발급 시도 수       |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`      |    `24` | 구간당 이 서버 전체의 발급 시도 수                 |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`              | `10000` | 메모리에 유지하는 유효 client window의 최대 개수   |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`         | `10000` | 메모리에 유지하는 BATON 참가자-방 window 최대 개수 |

기본 10분 발급 구간은 10분의 credential TTL과 일치합니다. 주소당 12회는 하나의 NAT 뒤에 있는 방
참가자 6명 모두의 최초 발급과 예정된 갱신을 수용하며, 서버 전체 24회는 여유를 제공합니다. 서버
전체 quota는 client별 quota의 두 배 이상이어야 하므로 한 client가 어긋난 고정 window 경계에서
이를 소진할 수 없습니다. 운영자가 credential TTL이나 브라우저 갱신 시점을 변경하면 발급
window와 quota도 검토하고 일반적으로 함께 맞춰야 합니다. 제공자 요청이 실패한 시도도 같은
quota를 사용하므로 장애 중인 제공자를 반복 호출하지 않습니다. BATON 모드에서 발급한 credential은
참여권의 `exp`를 상한으로 추가 적용하므로 더 긴 TURN TTL로 참여권의 권한을 연장할 수 없습니다.
BATON은 client 및 서버 전체 제한과 같은 원자적 판정에서 검증된 `(room_id, sub)`에도 기본 6회
window를 적용합니다. 새 `jti` 값이나 client 주소로는 이를 초기화할 수 없습니다. Standalone은
참가자 상태를 만들지 않습니다.

credential endpoint는 다음과 같은 no-store 응답을 반환합니다.

```json
{
  "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
  "username": "cloudflare-issued-username",
  "credential": "cloudflare-issued-credential",
  "expiresAt": 1780000000,
  "refreshAfterSeconds": 480
}
```

`expiresAt`은 브라우저 갱신과 운영 관측에 사용하는 Unix epoch 초입니다. `refreshAfterSeconds`는 더 짧은
BATON 참여권 경계를 포함한 유효 server-side 수명에서 계산합니다. 브라우저는 이 상대값과 자체
monotonic clock으로 갱신을 예약하며 로컬 wall clock의 값을 `expiresAt`에서 빼지 않습니다. 같은
NAT 뒤의 서로 다른 브라우저를 포함해 성공한 요청마다 새 username과 credential을 받습니다.
endpoint는 정확히 same-origin인 `Origin`을 포함한 POST 요청만 허용합니다. Fetch Metadata가
있으면 `Sec-Fetch-Site`도 `same-origin`이어야 합니다. BATON 참가자, 유효 client, 서버 중 하나가
발급 한도에 도달하면 endpoint는 빈 no-store HTTP 429 응답을 반환하고 `Retry-After`에는 차단 중인
window 가운데 남은 시간이 가장 긴 값의 정수 초를 설정합니다. metric의 `scope`는 만료 시점이 가장
늦은 정확한 window를 나타냅니다. 완전히 같은 경우에는 participant-state capacity, client-state
capacity, global, participant, client 압력 순서를 적용해 운영상 가장 중요한 원인이 계속 보이게
합니다.
Cloudflare credential API 호출 실패나 사용할 수 없는 응답은 빈 no-store HTTP 503으로 반환하고
`round.turn.credentials.provider.errors`를 증가시킵니다. 공급자 응답의 STUN 항목과 브라우저에서
불안정한 53번 포트 route는 브라우저 TURN 목록에 포함하지 않습니다.

Origin과 Fetch Metadata 검사는 다른 웹사이트가 브라우저를 통해 방문자의 quota를 소진하지 못하게
합니다. standalone 모드에서 이 검사는 해당 header를 만들 수 있는 비브라우저 client를 인증하지
않습니다. 공유 edge credential, 발급 제한, 짧은 TTL은 relay 고갈 위험을 제한하지만 제거하지는
않습니다. BATON 모드는 서명된 방 범위 참여권을 추가로 요구합니다.

TURN을 의도적으로 비활성화한 경우 endpoint는 빈 no-store HTTP 204 응답을 반환하므로 로컬 STUN
전용 개발에서 잘못된 브라우저 console 오류가 생기지 않습니다.

유효 client와 BATON 참가자-방 identity마다 발급 counter만 저장하며 credential은 절대로 cache하지
않습니다. 두 고정 window map은 모두 크기가 제한되어 있으며 용량에 도달하면 활성 quota를 내보내지
않고 새로운 identity를 거부합니다. client 주소, 참가자 subject, 방 ID, credential은 log나 metric에
포함하지 않습니다. `server.forward-headers-strategy=native`를 사용하면 Tomcat은 설정된 내부 proxy
CIDR에서 온 `X-Forwarded-For`만 허용합니다. 따라서 프로덕션 signaling 포트는 Caddy 뒤에서 private
상태로 유지되며 신뢰하지 않는 peer가 직접 연결해 위조 header로 rate-limit key를 선택할 수 없습니다.

Java 경계가 허용하는 방 ID는 `abcdefghjkmnpqrstuvwxyz23456789`를 사용하고 하이픈으로 구분한
4문자 segment 세 개로만 구성됩니다(예: `abcd-efgh-jkmp`).
