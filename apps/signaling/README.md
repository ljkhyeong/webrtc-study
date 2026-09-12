# ROUND 시그널링 서버 운영

시그널링 서버는 항상 다음 경로를 제공합니다.

- WebSocket 전송 계층 상태 확인을 위한 `GET /healthz`
- `GET /actuator/health/liveness`와 `/actuator/health/readiness`
- `GET /actuator/prometheus`와 `/actuator/metrics`

방 관련 작업은 `ROUND_AUTH_MODE`에 따라 달라집니다.

- `standalone`: WebSocket `/signal`과 `POST /api/turn-credentials`
- `baton`: 인증된 WebSocket `/rooms/{roomId}/signal`과
  `POST /api/rooms/{roomId}/turn-credentials`

`POST /round/rooms/{roomId}/participation-grant/refresh`는 BATON이 직접 처리합니다.
이 요청을 ROUND로 프록시하면 안 됩니다. BATON은 방별 참여권 쿠키를 갱신하기 전에
사용자 신원과 현재 스터디 참여 권한을 다시 확인합니다.

설정된 모든 `ALLOWED_ORIGINS` 항목이 정확한 HTTPS Origin이 아니면 `production` Spring
프로필은 시작 중 실패합니다. 이 프로필에서는 와일드카드, `null`, HTTP Origin을 허용하지
않습니다. BATON 모드는 해당 프로필이 없어도 와일드카드, `null`, 로컬 주소가 아닌 HTTP
Origin을 별도로 거부합니다.

## 연결·요청 제한과 만료 처리

`server.shutdown=graceful`과 시그널링 종료 처리를 함께 사용합니다. 서버 종료가 시작되면
새 연결 요청에는 HTTP 503을 반환합니다. 종료 처리와 겹쳐 연결된 WebSocket과 기존 연결은
종료 코드 1001로 닫고, 중복 종료 요청에도 방 상태를 한 번만 정리합니다.

입장하지 않은 연결은 `UNJOINED_SOCKET_TIMEOUT_MS`가 지나면 닫습니다(기본 15초). 수신량은
10초 고정 구간으로 집계하며 세션, 유효 클라이언트 IP, 서버 전체 순서로 한도를 검사합니다.
기본값은 세션당 600프레임, IP당 1,200프레임, 서버 전체 3,600프레임입니다. 세션 한도를
넘으면 해당 연결만 닫고, IP 또는 서버 전체 한도를 넘으면 프레임만 버립니다.
연결이 끊겨도 집계 구간이 끝날 때까지 IP별 수신량을 보관하므로 같은 주소에서 재연결해도
한도가 초기화되지 않습니다. 만료된 비활성 상태는 새 연결을 받거나 미입장 연결을 주기적으로
검사할 때 제거합니다. 상태 맵 크기는
`MAX_SIGNALING_CONNECTIONS`로 제한합니다. 용량이 부족하면 비활성 상태 중 가장 오래 사용되지
않은 항목만 제거하며 활성 클라이언트 상태는 제거하지 않습니다. `MAX_SIGNALING_CONNECTIONS`의
기본값은 1,000이고 `MAX_SIGNALING_CONNECTIONS_PER_CLIENT`의 기본값은 12입니다. 같은
주기 검사에서 활동이 없는 연결의 참여권 만료도 처리하므로 검사 주기는 100밀리초 이상 1초 이하로 제한합니다.

BATON 모드의 WebSocket 만료 시점은 연결 당시의 참여권으로 고정됩니다. ROUND는 연결 직후,
수신 한도 차감 전, 송신 큐에 넣기 전, 연결 확인 Ping·Pong 처리 중, 1초 주기 검사에서 만료 여부를
확인합니다. 참여권의 절대 만료 시각(`exp`)과 연결 시 기록한 남은 수명 중 하나라도 지나면
연결을 종료합니다. 남은 수명은 단조 증가 시계로 계산하므로 시스템 시계를 뒤로 돌려도 연결이 연장되지 않습니다.
만료된 연결은 기존 종료 절차로 상태를 한 번만 정리한 뒤 종료 코드 `4001`, 종료 사유
`Participation grant expired`로 닫습니다. 활동이 없는 연결도 검사 한 주기 안에 닫습니다.
HTTP 참여권 검증과 WebSocket 만료 검사는 같은 주입 시계를 사용하며 `exp`에 시간 오차를
허용하지 않습니다. 미래 `iat`에만 60초의 오차를 허용합니다. 독립 실행 연결에는 참여권 만료를 적용하지 않습니다.

BATON 모드는 연결을 맺는 중이거나 연결된 WebSocket을 같은 참여권 `jti`당 최대 1개, 같은
`(room_id, sub)`당 최대 2개 허용합니다. 두 번째 연결은 BATON이 새 `jti`를 발급한 뒤
재연결이 기존 연결과 잠시 겹치는 경우를 위한 것입니다. 같은 참여권으로 두 번째 연결을 열거나
같은 참가자가 같은 방에 세 번째 연결을 열면 HTTP 429를 반환합니다. 연결 승인 단계에서는 기존 연결을 종료하지 않습니다.
여러 연결의 `room.join` 요청이 겹치면 연결 순번이 더 큰 WebSocket을 유지합니다. ROUND는
이전 참가자를 방에서 제거하고 이전 연결을 종료 코드 `4002`와 종료 사유
`Participation session superseded`로 닫습니다. 연결 종료 시도가 끝나면 연결 슬롯의 예약을 해제합니다.
종료 중 I/O 오류가 발생해도 해제는 한 번만 수행합니다.
이전 연결의 `room.join`이 뒤늦게 도착해도 해당 연결을 닫습니다. 브라우저는 `4002`로 종료되면
자동 재연결하지 않으므로 두 연결이 번갈아 서로를 종료하는 일을 막습니다. 연결 슬롯은
WebSocket이 닫힐 때까지 유지하며, 미입장 상태와 `room.leave` 이후도 포함합니다.
독립 실행 모드에는 서버와 클라이언트 IP 제한만 적용합니다.

IP별 프레임 한도는 세션 한도 이상이어야 합니다. IP와 서버의 집계 구간 시작 시점 차이를
고려해 서버 전체 한도는 IP별 한도의 두 배 이상으로 설정해야 합니다. 기본값은 6명이 연결할 때
집중되는 ICE 후보 메시지를 허용하면서 지속적인 대량 수신을 제한합니다.

Micrometer는 다음 시그널링 지표를 제공합니다.

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
- `round.signaling.outbound.queue.overflows` (참가자별 또는 전체 송신 큐 제한으로 닫힌 참가자 수)
- `round.signaling.outbound.queue.global_overflows` (전체 송신 바이트 한도에 걸린 프레임 수)
- `round.signaling.heartbeat.closes`
- `round.signaling.authorization.closes`
- `round.auth.jwk.source.healthy` (BATON JWK 원격 소스가 정상이면 `1`, 장애면 `0`)
- `round.turn.credentials.issued`
- `round.turn.credentials.provider.errors`
- `round.turn.credentials.rate_limited`
  (`scope=client|participant|global|client_state_capacity|participant_state_capacity`)

지표 태그에는 정해진 값만 사용합니다. 방 ID, 표시 이름, 세션·피어 ID, SDP, ICE 후보,
Origin·헤더 값, Cloudflare API 토큰, 발급한 TURN 자격 증명은 로그나 지표 태그로 남기면 안 됩니다.
전송 로그에는 고정된 메시지와 예외 클래스만 포함합니다. 참여권 만료에 따른 종료 지표에도
참가자·방·참여권 식별자를 태그로 남기지 않습니다.

## TURN 자격 증명

`TURN_PROVIDER`로 `coturn`, `cloudflare`, `disabled`를 선택합니다.

`production` 프로필은 BATON 인증과 coturn을 기본으로 선택합니다. 기존 BATON의
`TURN_URLS`와 `round.turn.shared-secret` Secret 파일도 읽으며, 명시한
`TURN_COTURN_URLS`·`TURN_COTURN_SECRET`이 우선합니다. 파일은 Spring의
`SPRING_CONFIG_IMPORT=configtree:/run/secrets/`로 읽습니다. 실행 예시는
[BATON 환경변수](../../ops/baton.env.example)를 참고합니다.

- `coturn`: `TURN_COTURN_URLS`(쉼표 구분)와 `TURN_COTURN_SECRET`(32자 이상)을 설정합니다.
  공유키는 coturn의 `static-auth-secret`과 같아야 합니다. Cloudflare 설정은 비웁니다.
- `cloudflare`: `TURN_CLOUDFLARE_KEY_ID`와 `TURN_CLOUDFLARE_API_TOKEN`을 설정하고 coturn 설정은 비웁니다.
- `disabled`: 두 공급자의 설정을 모두 비웁니다. 로컬 STUN 전용 개발의 기본값입니다.

구성이 맞지 않으면 자격 증명을 출력하지 않고 시작에 실패합니다. `TURN_CREDENTIAL_TTL_SECONDS`의
기본값은 600초(10분)입니다. coturn은 TURN REST 규격의 HMAC-SHA1 임시 자격 증명을 발급하며
외부 API를 호출하지 않습니다. 공유키는 브라우저 응답에 포함하지 않습니다.
추가 과금 없는 홈서버의 도메인·포트·인증서 연결은 [연동 설정](../../docs/home-server-integrations.md)을 따릅니다.

자격 증명 발급 횟수는 다음 설정으로 제한합니다.

| 환경 변수                                             |  기본값 | 목적                                                      |
| ----------------------------------------------------- | ------: | --------------------------------------------------------- |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`           |   `600` | 고정 발급 구간                                            |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`             |    `12` | 구간당 유효 클라이언트 IP의 발급 시도 수                  |
| `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` |     `6` | 구간당 BATON `(room_id, sub)`의 발급 시도 수              |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`      |    `24` | 구간당 이 서버 전체의 발급 시도 수                        |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`              | `10000` | 메모리에 보관하는 IP별 집계 상태의 최대 개수              |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`         | `10000` | 메모리에 보관하는 BATON 참가자·방별 집계 상태의 최대 개수 |

위 표는 기본 프로필의 값입니다. 독립 실행의 10분 자격 증명은 8분 후 갱신하므로 IP당 12회로
같은 NAT의 참가자 6명에게 최초 발급과 한 번의 갱신을 제공할 수 있습니다.
`production` 프로필은 BATON의 5분 참여권에 따른 잦은 갱신을 고려해 **IP당 36회, 서버 전체 72회**를
기본으로 사용합니다. 참가자·방별 6회 제한은 같습니다. 명시한 환경변수가 우선하며,
독립 실행 Compose는 기존 IP당 12회·서버 전체 24회를 지정합니다.

서버 전체 한도는 IP별 한도의 두 배 이상이어야 합니다. 이는 IP와 서버의 집계 구간 시작 시점 차이를
고려한 조건입니다. 자격 증명 TTL이나 브라우저 갱신 시점을 변경하면 집계 구간과 발급 한도도
함께 검토해야 합니다. Cloudflare 요청에 실패한 시도도 발급 횟수에 포함해 장애 중 반복 호출을
제한합니다. BATON 모드에서 발급한 자격 증명은
참여권의 `exp`를 상한으로 추가 적용하므로 더 긴 TURN TTL로 참여권의 권한을 연장할 수 없습니다.
BATON 모드는 같은 구간에 `(room_id, sub)`당 기본 6회의 발급 한도도 적용합니다. 참가자·IP·서버
전체 한도를 모두 통과할 때만 함께 차감합니다. 새 `jti` 발급이나 IP 변경으로 참가자 한도를
초기화할 수 없습니다. 독립 실행 모드는 참가자별 발급 횟수를 관리하지 않습니다.

자격 증명 API는 다음과 같은 `Cache-Control: no-store` 응답을 반환합니다.

```json
{
  "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
  "username": "cloudflare-issued-username",
  "credential": "cloudflare-issued-credential",
  "expiresAt": 1780000000,
  "refreshAfterSeconds": 480
}
```

`expiresAt`은 만료 시각을 나타내는 Unix 초입니다. `refreshAfterSeconds`는 서버가 실제 남은
수명에서 계산한 갱신 대기 시간입니다. BATON 참여권이 먼저 만료되면 그 시각을 기준으로 계산합니다.
브라우저는 이 대기 시간과 단조 증가 시계로 갱신을 예약하며, 기기의 현재 시각을 `expiresAt`에서
빼서 계산하지 않습니다. 같은 NAT 뒤의 서로 다른 브라우저를 포함해 성공한 요청마다 새
`username`과 `credential`을 받습니다.

이 API는 동일 출처의 `Origin`을 포함한 POST 요청만 허용합니다. Fetch Metadata가
있으면 `Sec-Fetch-Site`도 `same-origin`이어야 합니다. BATON 참가자, 유효 클라이언트 IP,
서버 중 하나가 발급 한도에 도달하면 본문 없는 `Cache-Control: no-store` HTTP 429 응답을 반환합니다.
`Retry-After`는 요청을 차단한 집계 구간 중 가장 긴 남은 시간을 정수 초로 표시합니다.
지표의 `scope`는 제한이 가장 늦게 풀리는 항목을 나타냅니다. 해제 시점이 같으면
`participant_state_capacity`, `client_state_capacity`, `global`, `participant`, `client` 순으로 선택합니다.
Cloudflare 자격 증명 API 호출 실패나 사용할 수 없는 응답은 본문 없는 `Cache-Control: no-store` HTTP 503으로 반환하고
`round.turn.credentials.provider.errors`를 증가시킵니다. 공급자 응답의 STUN 항목과 브라우저에서
불안정한 53번 포트 주소는 브라우저 TURN 목록에 포함하지 않습니다.

Origin과 Fetch Metadata 검사는 다른 웹사이트가 브라우저를 통해 방문자의 발급 한도를 소진하지 못하게
합니다. 독립 실행 모드에서 이 검사는 해당 헤더를 직접 만들 수 있는 비브라우저 클라이언트를 인증하지
않습니다. 프록시의 공유 접근 인증, 발급 제한, 짧은 TTL은 TURN 중계 자원 고갈 위험을 줄이지만 제거하지는
않습니다. BATON 모드는 서명된 방 범위 참여권을 추가로 요구합니다.

TURN을 비활성화한 경우 이 API는 본문 없는 `Cache-Control: no-store` HTTP 204 응답을 반환하므로 로컬 STUN
전용 개발에서 불필요한 브라우저 콘솔 오류가 생기지 않습니다.

유효 클라이언트 IP와 BATON `(room_id, sub)`별 발급 횟수만 저장하며 자격 증명은 캐시하지
않습니다. 두 집계 맵은 크기가 제한되어 있습니다. 용량이 차면 기존 활성 상태를 보존하고
새 IP나 참가자·방 조합의 요청을 거부합니다. IP, 참가자 `sub`, 방 ID, 자격 증명은 로그나 지표에
포함하지 않습니다. `server.forward-headers-strategy=native`를 사용하면 Tomcat은 설정된 내부 프록시
CIDR에서 온 `X-Forwarded-For`만 허용합니다. 운영 시그널링 포트는 Caddy 뒤에서 비공개로 유지해,
신뢰하지 않는 클라이언트가 직접 접속하여 위조 헤더로 요청 제한에 쓰이는 IP를 바꿀 수 없게 합니다.

시그널링 서버가 허용하는 방 ID는 `abcdefghjkmnpqrstuvwxyz23456789`를 사용하고 하이픈으로 구분한
4문자 묶음 세 개로만 구성됩니다(예: `abcd-efgh-jkmp`).
