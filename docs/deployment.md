# ROUND standalone 프로덕션 배포

이 stack은 Caddy 뒤에서 메모리 기반 Java signaling replica 하나와 host network를 사용하는
coturn relay를 실행합니다. Caddy는 Vite build를 제공하고 HTTPS/WSS를 종료하며, 공개하지 않은
signaling port로 `/signal`, `/healthz`, `/api/turn-credentials`만 proxy합니다. standalone
pilot은 정적 app, WebSocket upgrade, TURN credential endpoint 앞에 공유 Caddy Basic Auth
gate 하나를 두며 `/healthz`만 공개합니다.

저장소가 추적하는 `compose.yml`, `ops/caddy/Caddyfile`,
`ops/production.env.example`은 하나의 standalone 배포 계약입니다. `compose.yml`은 의도적으로
`ROUND_AUTH_MODE=standalone`을 literal로 주입하므로 운영자가 환경변수를 추가해 이 stack을
BATON 배포로 바꿀 수 없습니다. BATON 연동에는 [BATON 배포 계약](#baton-배포-계약)에 설명한
별도의 edge 설정과 배포 manifest가 필요합니다. 공유 Basic Auth edge를 그대로 복사해 Java
process만 BATON 모드로 전환하지 마세요.

## BATON 배포 계약

BATON이 스터디룸을 내장해도 ROUND는 별도로 배포되는 서비스로 유지됩니다. BATON은 사용자
identity, 스터디 membership, 참여권 발급, 공개 same-origin edge를 소유합니다. ROUND는 메모리
기반 방·피어 상태, WebSocket signaling, TURN credential 발급만 소유합니다. 두 서비스는
database를 공유하지 않으며, ROUND는 signaling frame마다 BATON을 호출하지 않고 각 참여권을
로컬에서 검증합니다.

BATON 연동 branch에는 여기에 설명한 인증 identity, 활성 스터디 membership, refresh, edge,
JWK 경계가 구현되어 있으며 아래의 로컬 프로덕션 유사 리허설을 통과했습니다. 이 리허설은
공개 프로덕션 배포 승인이 아닙니다. `sub`는 계속 검증된 정규 BATON `Account.id`에서만
파생해야 합니다. Google OIDC `sub`, Naver profile ID, email, 공유 access key, client가
제공한 display name, 다른 provider 전용 값이나 자체 주장 값에서 파생해서는 안 됩니다.

BATON이 소유하는 ROUND signaling manifest에는 다음 값을 모두 설정해야 합니다.

```dotenv
SPRING_PROFILES_ACTIVE=production
ROUND_AUTH_MODE=baton
ROUND_AUTH_COOKIE_NAME=__Secure-round_access
ROUND_AUTH_ISSUER=https://baton.example.com
ROUND_AUTH_AUDIENCE=round
ROUND_AUTH_JWK_SET_URI=https://baton.example.com/.well-known/round-participation-jwks.json
ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS=300
ALLOWED_ORIGINS=https://baton.example.com
```

BATON이 소유하는 web bundle은 별도로 다음 값을 사용해 build해야 합니다.

```dotenv
VITE_ROUND_AUTH_MODE=baton
VITE_SIGNALING_URL=
VITE_TURN_CREDENTIALS_URL=
```

Vite는 build 시점에 이 비밀이 아닌 값을 내장합니다. 브라우저는 현재 origin과 정규 room
ID에서 세 공개 방 경로를 모두 파생합니다. BATON 모드는 방 범위 cookie path를 조용히 우회하는
대신 비어 있지 않은 endpoint override를 거부합니다. 저장소가 추적하는 standalone image는
계속 `VITE_ROUND_AUTH_MODE=standalone`으로 build합니다.

브라우저 계약과 분리된 `/round-ui/` asset base를 사용해 BATON 전용 runtime image를
build합니다.

```bash
docker build \
  --target baton-web-runtime \
  --tag round-baton-web:local \
  .
```

이 target은 BATON 모드를 고정하고 port 8080에서 `/room/*`와 `/round-ui/*`를 제공하며,
`io.round.auth-mode=baton` image metadata와 내부 mode marker를 모두 포함합니다. release
workflow는 이를 `round-baton-web`으로 별도 게시합니다. standalone `round-edge` image로
대체하지 마세요. 아래의 공개 경로와 비공개 경로 간 연결은 계속 BATON 외부 edge가 담당합니다.

BATON 환경의 정확한 issuer와 JWK Set URI를 사용합니다. 프로덕션 issuer와 JWK URL은 HTTPS를
사용해야 합니다. `ROUND_AUTH_AUDIENCE`는 참여권의 `aud`와 같아야 하며, 두 서비스가 의도적으로
이 계약의 version을 바꾸지 않는 한 `round`를 유지합니다. ROUND에는 BATON의 공개 JWK Set만
필요하며 BATON의 비공개 signing key를 받아서는 안 됩니다. verifier 설정이 없으면 BATON 모드
instance를 standalone으로 강등하지 말고 시작을 중단해야 합니다.
`ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS`의 기본값은 300이고 30초에서 900초 사이로만 설정할 수
있으며 `exp - iat`에 적용합니다. ROUND는 미래로 60초를 초과하는 `iat`도 거부합니다.

BATON은 기본적으로 참여권을 `__Secure-round_access`라는 `HttpOnly`, `Secure`,
`SameSite=Strict` cookie로 설정합니다. path는 `/round/rooms/{roomId}`로 제한하며, cookie를
host-only로 유지하도록 `Domain` attribute를 생략해야 합니다. 참여권을 query string, browser
storage, proxy log, client가 볼 수 있는 JavaScript에 넣어서는 안 됩니다. 공개 route와 내부
route는 version이 관리되는 연동 계약입니다.

| 작업                | 브라우저용 BATON 경로                               | 처리 경계                              |
| ------------------- | --------------------------------------------------- | -------------------------------------- |
| 참여권 갱신         | `/round/rooms/{roomId}/participation-grant/refresh` | BATON 소유, ROUND로 proxy하지 않음     |
| WebSocket 시그널링  | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`               |
| TURN 자격 증명 POST | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials` |

signaling에서는 BATON edge가 앞쪽의 `/round` segment를 제거합니다. TURN credential에서는 공개
path를 표의 `/api/rooms/...` endpoint로 rewrite합니다. 두 rewrite 모두 같은 `roomId`를
보존해야 합니다. edge는 WebSocket upgrade와 브라우저의 `Origin` header를 보존해야 하며,
신뢰하는 Origin을 임의로 만들면 안 됩니다. `ALLOWED_ORIGINS`는 BATON의 정확한 HTTPS origin으로
설정하고 JWT 검증과 함께 기존 Origin 및 Fetch Metadata 검사를 유지합니다. edge는
`Permissions-Policy`를 통해 BATON page에서 camera, microphone, `display-capture`를 허용하고
방 범위 WSS path를 `connect-src` 정책에 포함해야 합니다.

BATON은 refresh POST를 직접 처리합니다. 인증된 session을 요구하고 현재 스터디 membership을
다시 확인하며, 정확한 same-origin `Origin`과 `Sec-Fetch-Site: same-origin`을 요구해야 합니다.
CORS 정책은 노출하지 않고 전용 abuse limit을 적용합니다. 성공하면 새로운 `jti`와 만료를
사용해 host-only 방 cookie를 회전하고 `Cache-Control: no-store`를 설정하며 정확히 다음을
반환합니다.

```json
{
  "expiresAt": 1780000000,
  "refreshAfterSeconds": 240
}
```

JWT나 다른 token 정보가 응답 body 또는 브라우저에서 볼 수 있는 JavaScript에 들어가서는 안
됩니다.

BATON 모드는 `production` profile이 실수로 빠져도 wildcard, `null`, loopback이 아닌 HTTP
WebSocket origin을 거부합니다. 나머지 ROUND 프로덕션 설정 검증이 계속 활성화되도록 배포에서
`SPRING_PROFILES_ACTIVE=production`을 설정해야 합니다.

BATON edge는 client가 제공한 `Forwarded`, `X-Forwarded-*` 값을 버린 뒤 정규 host, client 주소,
HTTPS scheme을 직접 설정해야 합니다. 신뢰하는 이 edge만 signaling port에 접근할 수 있습니다.
세 방 범위 공개 path 모두에 제한된 사전 인증 rate limit을 적용해 membership 조회, signing,
잘못된 JWT 서명 검사, WebSocket upgrade가 무제한 CPU 부하로 사용되지 않게 합니다. 6명
참가자 모두의 정상 refresh와 reconnect를 수용하도록 burst를 조정합니다.

Java signaling port를 host interface, load balancer, public security group에 노출하지 마세요.
BATON edge와 monitoring plane에서 접근할 수 있는 비공개 container 또는 service network에만
bind합니다. 방 상태가 메모리에 있는 동안 ROUND signaling replica는 정확히 하나만 유지합니다.
일반 round-robin load balancer는 하나의 방을 독립적인 process로 나눕니다.

health와 metric은 방 traffic보다 더 좁은 신뢰 경계를 갖습니다.

- `GET /healthz`는 transport만 검사하며 BATON, 방, 참가자 상태를 포함하지 않습니다. 내부
  readiness probe를 권장합니다. 외부 uptime 검사가 필요하면 전용 edge rule로 이 정확한
  path만 노출합니다.
- `/actuator/prometheus`와 `/actuator/metrics/**`는 비공개 monitoring network 전용입니다.
  BATON의 공개 `/round/**` prefix 아래에 연결하거나 수집을 위해 signaling port를 노출하지
  마세요.
- BATON 모드에서 공개되는 ROUND 작업은 표에 있는 signaling과 TURN뿐입니다. 참여권 refresh는
  BATON에 남습니다. standalone `/signal`이나 `/api/turn-credentials`를 proxy하지 마세요.

BATON web flow는 Account session 조회, 참여권 refresh, 명시적인 prejoin 미디어 동의, TURN
발급, WebSocket 생성 순서입니다. 앞의 두 검사가 성공할 때까지 prejoin을 mount하지 않으므로
인증되지 않았거나 권한이 없는 브라우저가 camera 또는 microphone prompt를 띄울 수 없습니다.
`401`은 정규 `/room/{roomId}` 복귀 경로를 사용해 BATON login으로 이동하고, `403`은 login을
재시도하지 않고 BATON으로 돌아갑니다. preflight 참여권 manager를 활성 방으로 전달하므로
`ActiveRoom`을 mount할 때 즉시 두 번째 signing 또는 rate-limit quota를 사용하지 않습니다.
manager는 monotonic 브라우저 clock에서 BATON의 상대적인 `refreshAfterSeconds`를 사용하고,
`1..300`초 밖의 값을 거부하며, 오래된 prejoin이 미디어를 요청하기 전, 두 입장 동작 전,
TURN 갱신 전, 최초 또는 reconnect WebSocket 생성 전에 refresh합니다. 활성 방의 `401`, `403`,
`404` refresh 실패는 refresh loop를 중지하고 BATON이 소유한 해당 terminal 복구 경로를
표시합니다. 지원하지 않는 auth mode는 landing이나 prejoin 전에 실패하며 BATON alias는
account를 구분하지 않는 local storage에 저장하지 않습니다. ROUND의 TURN 응답에는 서버가
파생한 `1..604800` 범위의 `refreshAfterSeconds`가 별도로 포함됩니다. 브라우저는 monotonic
수신 deadline을 기록하고 TURN `expiresAt` epoch에서 wall clock을 빼지 않습니다. 참여권
refresh는 cookie만 회전하고 이른 socket reconnect를 강제하지 않습니다.

BATON 전용 web runtime은 hash가 붙은 `/round-ui/assets/*`에만 1년 immutable cache 정책을
적용합니다. `/room/*` HTML은 `Cache-Control: no-store`로 제공하고 hash가 없는 favicon은
재검증하며, `/round-ui/`에서는 standalone 생성·입장 제어를 노출하는 대신 no-store 404를
반환합니다.

ROUND는 각 socket을 handshake에 사용한 참여권에 연결합니다. 수신 quota 사용과 송신 enqueue
전, heartbeat 중, 1초 주기의 sweep에서 만료를 검사합니다. 참여권의 `exp`에 도달하거나 wall
clock이 과거로 이동했을 때 연결 시점의 monotonic deadline에 도달하면 ROUND는 일반적인 멱등
disconnect를 수행하고 `4001 / Participation grant expired`로 닫습니다. 따라서 유휴 상태이거나
입장하지 않은 만료 socket도 만료 뒤 최대 sweep 주기 한 번 안에 닫힙니다. 제한된 브라우저
reconnect는 갱신된 cookie를 사용합니다. Standalone socket에는 제한 시간이 없습니다. 설정한
TURN TTL이 더 길어도 BATON 모드 TURN credential은 참여권의 `exp`까지만 유효합니다. key
rotation에는 폐기할 key로 서명된 짧은 참여권이 모두 만료될 때까지 JWK Set에 이전 공개키와
새 공개키를 함께 게시하는 overlap window가 필요합니다.

유효하지 않거나, 만료되었거나, key를 알 수 없거나, claim이 잘못된 참여권에는 no-store
`401`을 반환합니다. 설정한 JWK source 자체를 cold load나 필수 refresh 중 사용할 수 없으면
ROUND는 비어 있고 no-store인 `503`을 반환합니다. alerting에서는 이를 credential 거부가
아니라 인증 infrastructure 장애로 분류해야 합니다.

BATON 모드에서 ROUND는 진행 중인 handshake와 활성 socket을 모두 계산합니다. 같은 `jti`는
하나의 reservation을 소유할 수 있고, 같은 `(room_id, sub)`는 두 개를 소유할 수 있어 새로
발급한 참여권을 사용하는 reconnect 하나가 기존 socket과 겹칠 수 있습니다. 같은 참여권을
동시에 재사용하거나 세 번째 participant-room socket을 열면 연결된 socket을 내보내지 않고
HTTP 429를 반환합니다. 소유 socket을 닫으면 slot이 해제되지만 단순히 `room.leave`를 보내는
것으로는 해제되지 않습니다. 이 counter는 process-local이므로 현재의 단일 replica 배포를
전제로 합니다. scale-out에는 공유 admission registry, 방 상태, routing이 필요합니다.

BATON TURN 발급은 기존 유효 client 제한과 서버 전체 제한에 더해 각 `(room_id, sub)`에
process-local fixed-window quota를 적용합니다. 새 `jti` 발급, role 또는 study claim 변경,
client 주소 변경으로 참가자 window가 초기화되지 않습니다. 기본값은 10분마다 6회이며 최대
10,000개의 participant-room identity를 추적합니다. BATON signaling manifest에
`TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS`와
`TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`를 설정합니다. 함께 제공하는 standalone
manifest는 endpoint에 검증된 참가자가 없으므로 의도적으로 이 값을 생략합니다.

`round.turn.credentials.rate_limited`에는 다음과 같이 제한된 `scope` label이 있습니다.
`client`, `participant`, `global`, `client_state_capacity` 또는
`participant_state_capacity`입니다. 전체 값을 alert 대상으로 삼고 scope 비율을 조사하되,
`sub`, room ID, `jti`, client 주소를 monitoring label로 추가해서는 안 됩니다. 참가자 quota는
coturn의 user 및 전체 allocation 제한을 대체하지 않고 보완합니다.

`round.signaling.authorization.closes`는 identity가 없는 counter로 수집합니다. 참가자, 방,
`jti`, role, 주소 tag를 추가해서는 안 됩니다.

이 저장소의 `ops/turn/probe.sh`는 standalone 공유 Basic credential로 인증하므로 BATON 인증
probe가 아닙니다. BATON 배포에는 BATON을 통해 실제 수명이 짧은 참여권을 얻고, JWT를 노출하지
않고 갱신하며, 새로운 `jti` cookie와 no-store metadata 응답을 검증하고, cookie를 명령 인자와
log에 넣지 않은 채 방 범위 TURN endpoint를 호출하는 연동 probe가 필요합니다. credential
발급 뒤 TURN allocation과 TLS 검사는 동일하게 유지됩니다.

### 호환 가능한 BATON 배포 순서

다음 순서로 배포합니다.

1. BATON 인증 identity, 스터디 membership 검사, refresh endpoint, 세 edge route와 제한
2. 선제 refresh와 연결 전 guard를 포함한 BATON web bundle
3. 활성 참여권 lease 종료를 포함한 ROUND signaling

refresh endpoint보다 web bundle을 먼저 배포하면 명시적 입장이 안전하게 실패합니다. 새 web
bundle보다 ROUND lease 종료를 먼저 배포하면 이전 client는 갱신된 cookie 없이 짧은 참여권이
만료될 때마다 signaling을 잃습니다. rollback은 ROUND lease 종료, web bundle, BATON refresh
route와 identity 경계의 역순으로 진행합니다.

전체 claim과 소유권 결정은 [ADR 0001](adr/0001-round-independent-service.md)에 기록되어
있습니다.

### 로컬 프로덕션 유사 BATON 리허설

2026-07-31에 연동 branch는 production image, Caddy local-CA HTTPS, mock Google OIDC, 실제
MySQL session과 membership, RS256/JWK 검증, BATON 모드 ROUND web과 Java signaling,
loopback에 게시한 coturn instance로 분리된 BATON 소유 edge 리허설을 완료했습니다. BATON
저장소에서 다음과 같이 관리되는 lifecycle을 실행합니다.

```bash
ROUND_REPOSITORY_ROOT=/absolute/path/to/round \
  ./ops/tests/round-local-tls-stack.sh up
./ops/tests/round-local-tls-stack.sh status
./ops/tests/round-local-tls-stack.sh down
```

분리된 Chromium profile 두 개는 활성 OWNER 및 MEMBER membership을 가진 서로 다른 OIDC
account를 사용했습니다. 둘 다 refresh, TURN credential 발급, WSS 입장을 완료했습니다.
`iceTransportPolicy=relay`에서 양쪽은 local·remote candidate type이 `relay`인 nominated,
succeeded UDP pair를 선택했습니다. candidate byte, inbound audio packet/byte, inbound video
frame/byte가 양방향으로 모두 증가했습니다. 양방향 DataChannel chat은 `sent`에 도달했고, 원격
microphone/camera-off 상태가 전파되었으며, 일반 member와 owner가 순서대로 나가자 방 상태가
갱신되었습니다.

그 뒤 Spring `configtree`용 mode `0600` TURN shared-secret 파일 하나를 read-only로 mount해
강화된 lifecycle을 반복했습니다. coturn wrapper는 동일한 mount를 읽고 runtime 설정을
tmpfs에 기록했습니다. 장기 실행 서비스 7개가 모두 healthy였고, BATON JWK Set은 200을
반환했습니다. 익명 정규 refresh는 `no-store` 및 request ID를 포함한 JSON 401을, query가 있는
refresh는 404를 반환했습니다. Caddy는 live config를 검증했으며, 무작위 TURN secret은
signaling/coturn argv, environment, log에 없었습니다. 관리되는 cleanup은 Compose project가
비었음을 검증한 뒤에만 container, network, volume, key, fixture data를 제거했습니다.

이 리허설은 실제 Google OIDC, Naver OAuth 2.0, local verified-email login, 하나의 BATON
`Account.id`를 보존하는 identity linking, 공개 DNS 또는 ACME, 물리 camera/microphone 장치,
NAT/firewall을 통과하는 공개 TURN 주소, UDP 차단 시 TCP/TLS fallback, 외부 network, dual-key
rotation, 참여권 전체 수명 두 번, 장시간 session 안정성, 6명 부하를 입증하지 **않습니다**.
배포 환경에서 이 검사를 통과할 때까지 프로덕션 gate를 열어 두세요.

## 프로덕션 사전 조건

- Docker Engine과 Docker Compose를 사용하는 Linux host. Coturn은 `network_mode: host`를
  사용합니다. Docker Desktop은 image 검증에는 유용하지만 프로덕션 TURN 토폴로지가 아닙니다.
- 최소 2개의 logical CPU와 signaling 및 TURN용으로 확보한 용량. edge CPU quota는 상한일 뿐
  전용 또는 예약 core가 아닙니다.
- 고정 public IPv4 주소 1개
- web hostname(예: `round.example.com`)과 TURN hostname(예: `turn.example.com`)의 `A`
  record. TURN은 host를 직접 가리켜야 하며 HTTP CDN이나 proxy 뒤에 두지 않습니다.
- SAN이 TURN hostname을 포함하는 PEM full chain과 private key. Caddy는 ACME를 통해 web
  certificate를 별도로 발급하고 갱신합니다.
- Docker host가 public 주소를 직접 소유하지 않는 경우 NAT port forwarding

### Linux 호스트 초기 구성과 사전 점검

systemd와 NTP synchronization을 사용하고 배포 filesystem에 최소 5 GiB가 남아 있는 전용
최신 보안 patch Linux host에서 Docker Engine과 Docker Compose 2.24.4 이상을 사용합니다.
검토하지 않은 installer를 shell에 pipe하지 말고 운영체제별 공식 저장소에서 Docker를
설치합니다. SSH는 운영자 network로 제한합니다. 배포판 저장소에서 `jq`, OpenSSL, `age`,
Certbot, util-linux(`flock`), GNU coreutils(`timeout`)를 설치합니다. lifecycle script는
의도적으로 `unix:///var/run/docker.sock`의 rootful local Docker socket만 대상으로 합니다.
remote context와 rootless endpoint는 허용하는 프로덕션 토폴로지가 아닙니다. 다음 ROUND data
plane만 노출합니다.

| 포트           | 프로토콜 | 소유자 |
| -------------- | -------- | ------ |
| `80`, `443`    | TCP      | Caddy  |
| `443`          | UDP      | Caddy  |
| `3478`, `5349` | TCP/UDP  | coturn |
| `49160-49259`  | UDP      | coturn |

signaling port `8787`은 Compose backend network 내부에만 둡니다. host firewall, upstream
security group, NAT/router에 동일한 relay range를 적용합니다. 어느 한 계층이라도 일치하지
않으면 TURN allocation이 간헐적으로 실패합니다.

저장소에 포함된 systemd template은 다음 layout을 전제로 합니다.

```text
/opt/round/                         reviewed ROUND checkout
/etc/round/production.env          mode-0600 runtime configuration
/etc/round/backup-recipients.txt   public age recipient(s), when backup is configured
/var/lib/round/                     non-secret release/certificate state
/var/backups/round/                 local encrypted backup staging only
```

host env에는 절대 경로 `TURN_TLS_CERT_FILE`과 `TURN_TLS_KEY_FILE`을 사용합니다. preflight는
이 파일을 shell code로 source하지 않고 Compose 설정을 terminal에 출력하지 않습니다. mutable
image tag, Linux가 아닌 host, 동기화되지 않은 clock, checkout·Docker data root·release state
filesystem의 부족한 disk, `0600`이 아닌 env 권한, 64개 hexadecimal 문자보다 짧은 TURN
secret, 잘못된 단일 replica 토폴로지를 거부합니다. 또한 TURN certificate와 mode
`0400`/`0600` private key, hostname, 최소 잔여 수명이 일치하지 않으면 거부합니다.

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

`preflight.sh`는 public IPv4, router/NAT mapping, security-group rule, DNS propagation, host 외부
relay 경로를 입증할 수 없습니다. external probe와 browser network matrix로 별도 기록합니다.

### 임시 macOS 스터디 파일럿

Linux Compose 토폴로지가 프로덕션 계약입니다. Docker Desktop에서 단기간 스터디를 테스트하려면
`compose.yml` 위에 `compose.macos-pilot.yml`을 겹쳐 적용하고 `ops/macos-pilot.env`를
사용합니다. override는 Docker Desktop에 coturn과 relay range를 명시적으로 게시하고 coturn에
고정 bridge 주소를 부여하며, 다른 로컬 서비스가 port 80을 계속 사용할 수 있도록 Caddy를
Mac host의 대체 port에 bind합니다.

override는 Compose 전용 `!override` 및 `!reset` merge tag를 사용하므로 Docker Compose
**2.24.4 이상**이 필요합니다. 배포 validator는 override를 render하기 전에 오래되었거나
해석할 수 없는 version을 거부합니다. Docker 문서의
[Compose merge 참고 자료](https://docs.docker.com/reference/compose-file/merge/#replace-value)에
version 요구사항이 설명되어 있습니다.

```bash
docker compose version --short
cp ops/macos-pilot.env.example ops/macos-pilot.env
chmod 0600 ops/macos-pilot.env
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

Caddy 명령은 plaintext를 echo하지 않고 입력을 요청합니다. 전체 `$2a$12$...` 또는
`$2b$12$...` 출력을 `ROUND_ACCESS_PASSWORD_HASH=''`의 작은따옴표 사이에 붙여 넣은 뒤 나머지
빈 값을 채웁니다. Compose를 render하기 전에 다음 prefix 검사를 실행합니다. 정확히 하나의
assignment가 작은따옴표로 감싼 cost-12 bcrypt prefix를 가질 때만 성공하며 hash나 plaintext를
출력하지 않습니다.

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

stack을 시작하기 전에 DHCP에서 Mac의 LAN 주소를 예약하고 router에 다음 mapping을 설정합니다.
왼쪽은 public port이고 오른쪽은 Mac 목적지입니다.

| 공개 포트     | 프로토콜 | Mac 목적지                              |
| ------------- | -------- | --------------------------------------- |
| `80`          | TCP      | `ROUND_HTTP_BIND_PORT` (기본값 `8080`)  |
| `443`         | TCP      | `ROUND_HTTPS_BIND_PORT` (기본값 `8443`) |
| `443`         | UDP      | `ROUND_HTTPS_BIND_PORT` (기본값 `8443`) |
| `3478`        | TCP/UDP  | `3478`                                  |
| `5349`        | TCP/UDP  | `5349`                                  |
| `49160-49259` | UDP      | 동일한 range                            |

HTTP 및 HTTPS translation은 public ACME port를 Caddy container의 port 80과 443으로 계속
전달합니다. `turn.b4ton.com`은 Cloudflare에서 DNS-only로 유지해야 하고, coturn은 설정한
`TURN_TLS_CERT_FILE` 및 `TURN_TLS_KEY_FILE` 경로에 공개적으로 신뢰받는 certificate가 계속
필요합니다. 테스트 시간에는 Mac이 깨어 있도록 자동 sleep을 비활성화하고 이후 stack을
중지합니다. 이 Docker Desktop 토폴로지는 pilot 편의를 위한 것일 뿐 Linux 프로덕션 gate의
증거나 external TURN probe의 대체물이 아닙니다.

macOS override는 `ops/caddy/Caddyfile.macos-pilot`도 mount합니다. Mobile Safari와 일부
Android 브라우저는 page의 HTTP Basic Auth credential을 `/signal` WebSocket upgrade에
일관되게 재사용하지 않습니다. 따라서 이 pilot 전용 정책은 UI와 static asset을 Basic Auth
뒤에 두되 `/signal`, `/api/turn-credentials`를 그 거친 edge gate에서 제외합니다. 이 두
route는 계속 signaling 서비스의 exact-origin 검증, connection 및 frame 제한, TURN 발급 quota를
통과합니다. 이는 단기간의 호환성 tradeoff입니다. 브라우저가 아닌 client는 Origin header를
위조할 수 있으므로 이 예외를 Linux 프로덕션 Caddyfile에 복사하거나 사용자 인증으로 취급하지
마세요.

같은 이유로 이 macOS edge를 통해 공유 Basic Auth credential을 보내는 TURN probe도
`/api/turn-credentials`에서 credential을 검사했다는 사실을 입증하지 **않습니다**. 이 route는
의도적으로 edge gate를 우회합니다. 이 probe는 exact-origin 형태의 요청이 수명이 짧은
credential을 얻었고 coturn이 traffic을 relay하는 동안 이를 인증했다는 사실만 입증합니다.
static UI의 `401`, transport Origin 거부, TURN relay 결과를 서로 다른 세 증거로 기록합니다.

기본 host port 중 하나라도 이미 사용 중이면 `ops/macos-pilot.env`에 사용 가능한 값을 설정하고
router 목적지를 같은 값으로 변경합니다. 예시 port를 유지하려고 관련 없는 로컬 서비스를
중지하지 마세요.

포함된 coturn 설정은 IPv4 전용입니다. IPv6 relay 설정을 추가하고 테스트하기 전에는 TURN
hostname의 `AAAA` record를 게시하지 마세요.

#### macOS 파일럿 빌드, 시작, 검사, 중지

모든 Compose 작업에 같은 base file, macOS override, env file을 사용합니다. 하나라도 생략하면
토폴로지 또는 project identity가 바뀝니다.

현재 checkout에서 로컬 image 세 개를 build한 뒤 stack을 시작하고 모든 Compose health check를
기다립니다.

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

container 상태, 내부 signaling health endpoint, 공개 HTTPS edge를 모두 검사합니다. env가 다른
domain을 사용하면 예시 origin을 교체합니다.

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

제한된 진단 snapshot을 표시하거나 스터디 중 log를 따라갑니다. Ctrl-C를 누르면
`logs --follow` 명령만 종료하며 container는 중지하지 않습니다.

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

스터디가 끝나면 pilot container와 network를 중지하고 제거합니다.

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  down --remove-orphans
```

이 동작은 Caddy의 ACME 상태를 포함한 `caddy_data`, `caddy_config` named volume을 의도적으로
보존합니다. 영구 certificate 상태를 명시적으로 제거하려는 경우가 아니면 `--volumes`를 추가하지
마세요.

### 방화벽

host firewall과 upstream security group 또는 router에서 다음 inbound port를 엽니다.

| 포트          | 프로토콜  | 소유자 | 목적                                 |
| ------------- | --------- | ------ | ------------------------------------ |
| `80`          | TCP       | Caddy  | ACME HTTP challenge와 HTTPS redirect |
| `443`         | TCP       | Caddy  | HTTPS와 WSS                          |
| `443`         | UDP       | Caddy  | HTTP/3                               |
| `3478`        | UDP와 TCP | coturn | STUN/TURN                            |
| `5349`        | TCP와 UDP | coturn | TURN TLS와 DTLS                      |
| `49160-49259` | UDP       | coturn | 미디어 relay allocation              |

기본 relay range는 100개의 port를 제공합니다. TURN allocation 하나가 relay port 하나를
사용하므로 동시 방을 더 많이 운영할 때는 `TURN_MIN_PORT`/`TURN_MAX_PORT`와 firewall rule을
함께 확장합니다. 임의의 peer 주소와 port로 나가는 coturn outbound UDP를 허용하고 stateful
return traffic도 허용해야 합니다.

sample은 abuse와 overload도 제한합니다.

- `TURN_USER_QUOTA=20`은 발급된 user 하나에 최대 20개의 동시 allocation을 허용합니다.
  6명 mesh는 5개의 peer connection에 대해 게시된 TURN transport 3개를 모두 수집할 수 있어
  최대 15개의 allocation을 사용하며, ICE 복구 중 겹침에 5개를 남깁니다.
- `TURN_TOTAL_QUOTA=100`은 기본 100-port relay range와 일치하며 서버 전체 allocation을
  제한합니다. 완전히 relay되는 참가자 6명이 transport 3개를 모두 수집하면 최대 90개를
  사용하고 짧은 복구 겹침에 10개를 남깁니다.
- `TURN_MAX_BPS=2000000`은 TURN session마다 input 및 output stream 각각을 초당
  2,000,000 byte로 제한합니다.
- `TURN_BPS_CAPACITY=30000000`은 전체 session에 할당하는 용량을 방향마다 초당
  30,000,000 byte로 제한합니다.

관측한 bitrate와 concurrency에 맞춰 이 네 값을 조정합니다. port range를 확장하지 않는 한
전체 quota는 user quota 이상이고 사용 가능한 relay-port 용량 이하여야 합니다. 전체 bandwidth
용량은 session별 제한 이상이어야 합니다.

## 비밀과 인증서 설정

저장소가 추적하는 sample에서 runtime 환경을 만듭니다.

```bash
cp ops/production.env.example ops/production.env
chmod 0600 ops/production.env
openssl rand -hex 32
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

생성된 64자 값을 `TURN_SHARED_SECRET`에 붙여 넣습니다. 이 파일은 Git과 Docker build context
모두에서 무시됩니다. secret은 container runtime에 signaling과 coturn으로만 전달하며 web
bundle이나 image layer에 compile하지 않습니다.

Caddy 명령은 plaintext password를 echo하지 않고 입력을 요청합니다. 전체 `$2a$12$...` 또는
`$2b$12$...` 출력을 `ROUND_ACCESS_PASSWORD_HASH=''`의 작은따옴표 사이에 붙여 넣습니다.
작은따옴표는 Compose가 hash의 dollar sign을 환경변수 보간으로 해석하지 않게 합니다. 선택한
plaintext password를 env file, shell history, Git, image, log에 넣지 마세요.
`ROUND_ACCESS_USER`에는 colon이 없는 단순한 공유 pilot username을 설정하고, 무작위 24~32자
ASCII password를 선택합니다. bcrypt는 최대 72 input byte만 고려합니다. username과 plaintext
password는 별도의 신뢰하는 channel로 대상 스터디원에게 전달합니다.

standalone host에서는 관련 없는 두 번째 secret을 최소 32 random byte로 만듭니다.
`openssl rand -hex 32`가 만드는 64자 hexadecimal 값을 권장합니다. 비활성화 전용 미디어
제어를 받아야 하는 사람에게만 plaintext를 전달하고 lowercase SHA-256 digest만
`ROUND_STANDALONE_HOST_TOKEN_SHA256`에 넣습니다. sample env에는 plaintext를 파일에 쓰지 않고
digest를 계산하는 hidden-input 명령이 있습니다. digest 하나는 해당 signaling instance의 모든
standalone 방에서 host 권한을 부여합니다. 따라서 회전할 때는 digest를 바꾸고 signaling을
재시작한 뒤 기존 host가 reconnect해야 합니다. 이미 입장한 host는 disconnect할 때까지 판정된
role을 유지합니다. host 제어가 필요하지 않으면 값을 비워 둡니다. BATON 배포는 서명된 참여권의
`role`이 권위 있는 값이므로 이 key를 허용하지 않습니다.

다음 값을 주의해서 설정합니다.

- `ROUND_DOMAIN`은 HTTPS로 제공해야 합니다. HTTP Basic Auth는 credential을 encode할 뿐이며
  TLS 없이는 안전하지 않습니다. 배포된 브라우저 미디어와 signaling도 HTTPS/WSS가 필요합니다.
- `ROUND_ACCESS_USER`와 `ROUND_ACCESS_PASSWORD_HASH`는 `/healthz`를 제외한 모든 외부 route를
  보호합니다. Caddy는 명시적인 bcrypt cost-12 hash를 검증하고 signaling으로 proxy하기 전에
  `Authorization`을 제거합니다. `Authorization` header가 있는 요청은 인증 전에 client
  network별 5분 sliding window에서 96회로 제한합니다. header가 없는 브라우저 challenge는
  password hash를 실행하지 않으므로 계산하지 않습니다. 익명 global quota는 의도적으로
  두지 않습니다. 공유 사전 인증 bucket을 사용하면 한 호출자가 budget을 모두 소진해 모든
  참가자를 차단할 수 있기 때문입니다. Caddy는 알 수 없는 username에 cost-14 fake bcrypt
  비교를 사용하므로 client budget은 설정한 cost-12 hash뿐 아니라 더 비싼 이 실패 경로를
  기준으로 조정합니다. IPv6 client는 `/64`로 묶으며 공개 health check는 budget을 사용하지
  않습니다. 현재 네 파일 bundle에서는 새 브라우저 6개가 NAT 하나를 공유할 때 credential을
  포함한 요청 약 36개를 사용합니다. signaling 동시 재시도 6회가 다시 36개를 사용해 제한된
  복구 traffic에 24개를 남깁니다. 이 sliding-window budget은 동시 bcrypt 작업이 아니라 요청
  수를 제한합니다. 따라서 하나의 client network가 문법적으로 유효하지만 서로 다른 존재하지
  않는 username의 credential을 동시에 많이 제출해 cost-14 fake-hash 경로를 강제하고,
  96회 budget을 소진하기 전에 edge CPU를 일시적으로 포화시킬 수 있습니다. edge container는
  CPU 하나 분량의 scheduler time, 256 MiB memory, 128 process로 제한합니다. 이 상한은 여유
  용량이 있는 host에서 edge resource 사용을 제한하지만 CPU를 예약하거나 가용성을 보장하지
  않습니다. CPU 하나인 host는 여전히 포화될 수 있고 모든 공개 signaling 연결이 같은 edge를
  통과하므로 기존 WebSocket traffic도 지연될 수 있습니다. 이 위험을 수용하기 전에 실제
  multi-CPU pilot host에서 대표적인 6명 peak를 대상으로 checklist의 측정 burst gate를
  실행합니다. 이 보호만으로 제한 없는 공개 서비스를 운영하기에는 부족합니다. 여러 client
  network에서 오는 분산 공격도 잔여 위험입니다. 더 넓게 공개하기 전에는 upstream network
  filtering 또는 BATON identity, session login 경계, 제한된 사전 인증 작업 queue가 필요합니다.
  공유 credential은 임시 standalone pilot 경계입니다. 참가자를 식별하거나 스터디 membership을
  강제하거나 멤버 한 명만 취소할 수 없습니다. 더 넓게 접근시키기 전에 BATON authentication과
  meeting membership authorization으로 대체해야 합니다.
- `ROUND_STANDALONE_HOST_TOKEN_SHA256`는 성공적으로 입장한 뒤 같은 방에서 microphone과
  camera를 끄는 제어만 부여합니다. site 접근, 참가자 identity, membership authorization을
  대체하지 않습니다. runtime env에는 digest만 저장하고 plaintext는 Basic Auth password와
  별도로 배포합니다.
- `ROUND_DOMAIN`과 `ALLOWED_ORIGINS`는 정확히 동일한 HTTPS origin을 나타내야 합니다.
  wildcard origin을 사용하지 마세요.
- `TURN_URLS`는 TURN hostname의 UDP, TCP, TLS route를 게시해야 합니다. signaling endpoint는
  coturn과 동일한 shared secret으로 만료되는 HMAC credential을 발급합니다.
- `TURN_CREDENTIAL_TTL_SECONDS`의 기본값은 600초이며 image를 다시 build하지 않고 조정할 수
  있습니다. endpoint와 external probe는 요청할 때마다 새 credential을 발급하거나 가져옵니다.
  TTL을 변경하면 credential이 의도한 rate-limit 범위보다 오래 유지되지 않도록 발급 window를
  검토하고 일반적으로 같은 값으로 맞춥니다.
- `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`,
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`,
  `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`,
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`는 credential endpoint abuse를 제한합니다. 10분
  credential TTL에 맞춘 기본 10분 window는 최대 10,000개의 client를 추적하면서 client마다
  12회, standalone 서버 전체에 24회의 요청을 허용합니다. 12회는 NAT 하나 뒤의 방 참가자
  6명이 최초 발급과 예정된 8분 시점 refresh를 모두 수행할 수 있는 수입니다. global quota는
  client별 quota의 두 배 이상이어야 합니다. 브라우저 refresh 시점이 바뀌면 이 값을 함께
  검토합니다.
  브라우저 요청은 정확한 same-origin POST여야 합니다. Origin 및 Fetch Metadata 검증은
  브라우저 abuse 완화 수단이지 인증이 아닙니다. 공유 Caddy credential을 알거나 훔친 비브라우저
  client는 이 header를 구성하고 global 발급 quota를 소진하거나 coturn relay allocation과
  bandwidth를 소비하는 유효 credential을 축적할 수 있습니다. edge gate는 익명 인터넷 호출자를
  차단합니다. standalone quota는 BATON identity와 스터디 membership이 연결될 때까지 credential
  보유자의 abuse를 제한하지만 제거하지는 못합니다.
- BATON 배포에는 다음 값도 설정합니다.
  `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS`와
  `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`. 기본값은 동일한 window에서
  `(room_id, sub)`마다 6회의 credential 발급을 허용하고 최대 10,000개의 활성 참가자 window를
  유지합니다. 의도한 정상 참가자 수가 각자의 참가자 budget을 사용할 수 있도록 client quota와
  서버 전체 quota를 함께 조정합니다. 이 map은 process-local이며 용량에 도달하면 활성 quota
  window를 내보내지 않고 안전하게 실패합니다. scale-out에는 공유 quota registry가 필요합니다.
- `MAX_SIGNALING_CONNECTIONS=1000`과
  `MAX_SIGNALING_CONNECTIONS_PER_CLIENT=12`는 동시 WebSocket handshake를 제한합니다.
  `SIGNALING_ABUSE_WINDOW_MS=10000`은
  `SIGNALING_MAX_FRAMES_PER_SESSION`, `SIGNALING_MAX_FRAMES_PER_CLIENT`,
  `SIGNALING_MAX_FRAMES_GLOBAL`을 통해 session마다 600개, 유효 client 주소마다 1,200개,
  global로 3,600개의 frame 제한을 적용합니다. session 초과는 해당 연결만 닫고 client 및 global
  초과는 frame을 버립니다. global frame 제한은 client 제한의 두 배 이상이어야 합니다. 같은
  주소에서 disconnect 후 reconnect해도 현재 client window가 초기화되지 않습니다. 만료된 비활성
  window는 연결 시점과 주기적 sweep에서 정리합니다. 제한된 map은 비활성 entry만 내보내고 활성
  client 상태는 내보내지 않습니다.
- `VITE_ICE_TRANSPORT_POLICY=all`은 일반 release 설정입니다. tag 기반 release workflow는
  미디어가 direct candidate가 아니라 TURN을 통과함을 입증하도록 별도의 `-relay` edge image도
  게시합니다. relay-only image를 일반 스터디룸 release로 사용하지 마세요.
- `TURN_EXTERNAL_IP`는 public IPv4 주소입니다.
- `TURN_RELAY_IP`는 relay socket에 사용하는 host interface 주소입니다. public 주소를 host가
  직접 소유하면 `TURN_EXTERNAL_IP`와 같게 설정하고, NAT 뒤에서는 private interface 주소를
  사용합니다.
- `TURN_REALM`에는 TURN DNS hostname을 사용합니다.

TURN certificate 파일을 `TURN_TLS_CERT_FILE`, `TURN_TLS_KEY_FILE`에 설정한 경로에 둡니다.
예시는 다음과 같습니다.

```text
ops/certs/fullchain.pem
ops/certs/privkey.pem
```

certificate 디렉터리는 Git과 Docker build context에서 무시됩니다. Compose는 파일을 read-only
runtime secret으로 mount합니다. Coturn은 이 파일을 읽을 만큼만 시작 권한을 유지한 뒤 유효
capability 없이 image의 `nobody` account로 권한을 낮춥니다. host ACME client가 발급을
소유합니다. ROUND deploy hook은 private key, TURN hostname, 최소 7일의 잔여 수명을 검사한
뒤에만 결과 파일을 허용합니다. `/var/lib/round/releases/current.env`를 사용해 coturn만 다시
생성하고, `127.0.0.1:5349`에서 실제 제공되는 신뢰 hostname과 leaf fingerprint를 즉시
입증합니다.

```bash
sudo /opt/round/ops/linux/reload-turn-certificate.sh /etc/round/production.env
```

사람이 개입하지 않는 Linux 갱신에는 저장소 밖에 mode `0600`으로 저장한 권한 범위가 좁은
Cloudflare API token 기반 ACME DNS plugin을 사용합니다. 현재 사용하는 대화형 수동 DNS-01
challenge는 무인 갱신 방법이 아닙니다. 배포판이 제공하는 Certbot timer를 유일한 갱신
scheduler로 유지합니다. ROUND의 영구 deploy hook을 설치한 뒤 선택한 authenticator와 hook을
함께 입증합니다. 일반 dry run은 deploy hook을 건너뛰므로 `--run-deploy-hooks`가 필요합니다.

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

hook은 listener가 검증한 fingerprint만 `/var/lib/round/certificates` 아래에 저장하며 certificate나
key를 복사하지 않습니다. fingerprint가 같으면 재생성을 건너뛰지만 live listener는 계속
검증합니다. Certbot의 전체 갱신 exit status만으로는 모든 deploy hook이 성공적으로 적용되었다고
신뢰성 있게 단정할 수 없습니다. 따라서 독립 reconciliation timer는 누락된 hook 뒤 멱등으로
재시도한 다음 동일한 live listener 검사를 수행합니다. 서비스는 전체 Compose health budget을
허용하고, 실패하면 5분 뒤 unit 시작 제한까지 재시도합니다. 그 뒤에는 지속적인 실패로 표시하고
`OnFailure` unit을 통해 `daemon.crit` `round-ops` record를 보냅니다. systemd unit 실패나 이
record를 host의 외부 alerting agent에 연결합니다. 로컬 journal만으로는 host 외부 알림이 되지
않습니다. 활성화한 external TURN monitor는 공개 경로를 확인하는 추가 alert입니다.

`certbot renew --dry-run --run-deploy-hooks`는 현재 활성 certificate로 hook을 호출하므로 hook
권한, locking, 현재 listener 검사는 입증하지만 새로 발급된 certificate 때문에 coturn을 다시
생성해야 했다는 사실은 입증하지 않습니다. 최초의 실제 무인 갱신 log와 성공한 reconciliation
결과를 그 증거로 보존합니다. 두 timer와 public certificate 만료를 모두 monitoring합니다.

## 불변 릴리스 이미지 게시

release candidate를 merge하고 일반 branch CI가 성공하면 annotated SemVer tag를 만듭니다.
브라우저 bundle에 compile할 comma-separated 프로덕션 STUN URL을 tag message의 정확히 하나의
`ROUND_STUN_URLS=` 줄에 넣습니다. 예를 들어 프로덕션 TURN hostname을 다음과 같이 사용합니다.

```bash
git tag -a v0.1.0-rc.1 \
  -m "ROUND v0.1.0-rc.1" \
  -m "ROUND_STUN_URLS=stun:turn.example.com:3478"
git push origin v0.1.0-rc.1
```

release workflow는 lightweight tag, trigger한 commit을 더는 가리키지 않는 tag, 강제 tag 변경,
형식이 잘못된 STUN URI 목록, 이미 존재하는 release 또는 full SHA image tag를 거부합니다.
annotated tag object의 Git ID를 기록하고 promotion 직전에 object가 변경되지 않았는지
검증합니다. 브라우저 build input을 이 object에 보관하면 변경 가능한 repository 변수가 run의
결과를 조용히 바꾸는 것을 방지할 수 있습니다. queue에 있거나 수동으로 다시 실행한 workflow가
교체된 tag object를 보지 못하도록 repository tag ruleset으로 `v*` tag의 변경과 삭제를
보호합니다.

`.github/workflows/release-images.yml`은 저장소 및 배포 검사를 다시 실행한 뒤 digest-only
reference로 Linux AMD64 및 ARM64 manifest를 build합니다. 모든 build가 완료되고 모든 최종
tag가 여전히 사용되지 않았는지 확인한 뒤 digest 5개를 승격하고, 승격한 tag 10개가 예상 build
digest를 가리키는지 검증합니다. release workflow run은 저장소 단위로 직렬화되어 release
queue에 유지됩니다. 이전 승격 실패가 entrypoint tag를 노출하지 않도록 사용자가 접하는
프로덕션 edge를 마지막에 승격합니다.

```text
ghcr.io/<owner>/round-edge:<tag>
ghcr.io/<owner>/round-edge:<tag>-relay
ghcr.io/<owner>/round-baton-web:<tag>
ghcr.io/<owner>/round-signaling:<tag>
ghcr.io/<owner>/round-turn:<tag>
```

각 image에는 full `sha-<commit>` tag도 붙습니다. workflow summary는 모든 image의 manifest
digest를 기록합니다. 일반 edge, signaling, TURN digest reference를 `ops/production.env`에
복사하고 relay-only edge digest는 relay gate에만 사용합니다. BATON web digest는 BATON의 별도
orchestrator가 사용합니다. 기존 release나 SHA tag를 이동하거나 덮어쓰지 마세요. GHCR은 여러
image 저장소에 걸쳐 tag를 원자적으로 승격할 수 없으므로 최종 승격 중 infrastructure 장애가
나면 tag 일부만 보일 수 있습니다. 보이는 모든 tag는 사용된 것으로 취급하고 그 위에서 다시
실행하지 않습니다. 실패한 release를 조사한 뒤에만 새 SemVer tag를 게시합니다.

release workflow는 build한 digest 5개 각각에 GitHub OIDC 기반의 서명된 출처 증명을 GHCR OCI
referrer로 게시합니다. 증명은 해당 digest가 `ljkhyeong/webrtc-study`의
`.github/workflows/release-images.yml`에서 self-hosted runner 없이 지정된 source commit으로
생성됐는지를 소유합니다. `org.opencontainers.image.version`,
`io.round.release.tag-object`, `io.round.image.role`, `io.round.image.flavor` 레이블은 서비스
역할과 세 image의 release 묶음 일치를 소유합니다. 같은 사실을 양쪽에서 중복 검증하지 않습니다.
annotated tag ref 자체는 서명 검증 입력이 아니므로 tag-object 일치는 계속 레이블 정책으로
검사합니다.

배포 전에 프로덕션 host에 현재 `gh` CLI를 설치하고 GitHub 인증과 GHCR 인증을 모두 준비합니다.
`--bundle-from-oci`는 증명 bundle을 GitHub API 대신 GHCR에서 읽지만 `gh` 자체 인증 요구를
제거하지 않습니다. 공개 package도 `gh auth status --hostname github.com`이 성공해야 하며,
비공개 package에는 `read:packages`만 가진 권한 범위가 좁은 credential이 필요합니다. registry
credential은 `ops/production.env`가 아니라 host의 Docker credential store에 저장합니다.

```bash
gh auth status --hostname github.com
docker login ghcr.io

gh attestation verify \
  "oci://ghcr.io/ljkhyeong/round-edge@sha256:<64-lowercase-hex>" \
  --bundle-from-oci \
  --repo ljkhyeong/webrtc-study \
  --signer-workflow ljkhyeong/webrtc-study/.github/workflows/release-images.yml \
  --source-digest '<검토한-checkout-commit>' \
  --deny-self-hosted-runners
```

보호 wrapper는 release state의 edge, signaling, TURN digest에 이 검증을 적용한 뒤에만
`in-progress` 저널로 전환하고 Docker pull을 시작합니다. 기존 `current.env`가 있으면 그 rollback
기준의 세 image도 candidate를 만들기 전에 먼저 검증합니다. 따라서 unsigned current 위에는 새
release를 배포할 수 없고, 기존 릴리스 이미지에 서명된 증명이 없다면 새 코드로 배포하거나
rollback할 수 없습니다. 진짜 오프라인 rollback에는 bundle과 신뢰 루트를 release state와 함께
보존하는 별도 설계가 필요하며, 현재 절차는 GHCR과 GitHub 신뢰 루트에 연결되는 온라인 안전 실패
절차입니다.

### 서명 검증 도입 순서

서명 증명 생산자와 배포 검증 소비자는 커밋을 나눠 배포합니다. 이 순서를 바꾸면 unsigned
`current.env` 때문에 새 소비자가 의도적으로 배포를 거부합니다.

1. `actions/attest`와 release workflow 계약 검사만 포함한 생산자 커밋에 annotated SemVer tag를
   만들고 image를 게시합니다.
2. 프로덕션 host를 그 생산자 커밋에 두고 기존 배포 wrapper로 첫 서명 baseline을 배포합니다.
   `current.env`의 `ROUND_CHECKOUT_COMMIT`과 세 digest가 이 tag의 source commit·증명과 일치하는지
   위 `gh attestation verify` 명령으로 각각 확인합니다.
3. 그 확인 뒤에만 host checkout을 현재 rollback 기준까지 검증하는 소비자 커밋으로 이동합니다.
4. 소비자 커밋 또는 그 이후 커밋에 두 번째 annotated SemVer tag를 만들고 새 서명 release를
   배포합니다. 성공 뒤 `current.env`와 `previous.env`가 모두 서명된 상태인지 확인합니다.

1~2단계를 생략한 채 소비자 커밋으로 먼저 이동하지 않습니다. 두 번째 release가 성공하기 전에는
첫 서명 baseline을 현재 상태로 유지하며, 유지보수 창과 복구용 checkout을 보존합니다.

## 검증, 빌드, 시작

render된 secret을 출력하지 않고 interpolation을 검증합니다.

```bash
docker compose --env-file ops/production.env config --quiet
```

CI는 임시 dummy credential과 certificate를 대상으로 동일한 interpolation을 실행하고, 고정된
custom Caddy runtime을 build하며, rate-limit module 존재 여부를 검증합니다. 정확히 그 binary로
Caddyfile을 검증하고, 모든 Dockerfile runtime target을 검사하며, BATON 모드 web runtime을
build·검사한 뒤 standalone image 3개를 build합니다.

```bash
bash ops/ci/validate-deployment.sh
```

최종 Compose image 3개를 build하지 않고 로컬에서 문법과 target을 검사하려면 `--check-only`를
추가합니다. stock Caddy binary는 rate-limit directive를 해석할 수 없고 Dockerfile 문법
검사만으로는 내장 auth flavor나 `/round-ui/` asset base를 검증할 수 없으므로, 이 모드도 더
작은 custom Caddy validation target과 BATON web runtime은 build합니다.

로컬 image 검증 host에서는 target 3개를 build하고 stack을 시작합니다.

```bash
docker compose --env-file ops/production.env build --pull
docker compose --env-file ops/production.env up -d --wait --wait-timeout 120
docker compose --env-file ops/production.env ps
```

공유 log에서 일반 `docker compose config`를 실행하지 마세요. render된 출력에
`TURN_SHARED_SECRET`이 포함됩니다.

저장소가 추적하는 sample은 같은 파일을 로컬 source build에도 사용할 수 있도록 GHCR release
tag를 사용합니다. `ops/linux/preflight.sh`는 의도적으로 이 sample을 거부합니다. 프로덕션에서는
`ROUND_EDGE_IMAGE`, `ROUND_SIGNALING_IMAGE`, `ROUND_TURN_IMAGE`를 release workflow의
manifest digest로 설정합니다. 선택적인 base-image 변수도 digest로 고정합니다. digest 기반
Linux 배포에는 보호 wrapper를 사용합니다.

```bash
sudo ops/linux/deploy.sh /etc/round/production.env
```

상태를 변경하는 모든 Linux lifecycle 명령은 검토를 마친 clean checkout을 요구한다.
tracked, staged, untracked 파일이 하나라도 있으면 Docker를 건드리기 전에 실패한다.
Git에서 무시한 비밀·인증서 파일은 이 clean 검사 대상이 아니다.

배포와 rollback 명령은 lifecycle lock을 잡은 뒤 state root 아래에 mode `0700`인 임시
`.deploy-snapshot.*` 디렉터리를 만들고, runtime env와 `compose.yml`을 각각 mode
`0600`으로 복사한다. release state 작성, preflight, 상태 호환성 재검사, pull, 이미지
검사, `up`과 첫 배포 복구의 `down`은 모두 이 동일한 env·Compose 스냅샷만 사용하며
Compose의 project directory는 검토된 저장소 루트로 유지한다. 따라서 원본 env나
checkout이 검증 뒤 바뀌어도 다른 입력으로 실행되지 않는다. 성공과 일반적인 실패에서는
임시 스냅샷만 제거하고 기존
`pending.env`/`in-progress.env` 저널 의미는 보존한다.

TURN 인증서와 개인 키는 Compose secret이 참조하는 영속 host 경로이므로 이 스냅샷에
복사하지 않는다. 인증서 lifecycle은 별도 lifecycle lock과 Certbot reload hook이
소유한다. ACME lineage·reload 절차 밖에서는 deploy나 rollback 실행 중 해당 파일을
교체하지 않는다.

release state 작성·검증과 standalone preflight는 Docker pull 전에 저장소가 정확히
`ghcr.io/ljkhyeong/round-edge`, `round-signaling`, `round-turn`인지 확인하고 각 digest의 서명된
저장소·workflow·source commit 출처를 검증합니다. 세 digest를 pull한 뒤 `up` 전에는
role/flavor가 서비스와 일치하는지, SemVer version과 annotated tag object가 세 이미지에서 같은
release를 가리키는지 검사합니다. `VITE_ICE_TRANSPORT_POLICY=all`은 `edge/standalone`만,
`relay`는 `edge/relay`와 version의 `-relay` 접미사만 허용합니다. rollback도 대상 digest를 pull하기
전에 같은 서명 검증을 통과하고, pull 뒤 같은 레이블 검사를 통과해야 컨테이너를 시작합니다. 서명된
출처 증명, 역할 레이블, SBOM은 서로 다른 경계를 담당하므로 release 기록과 함께 보관합니다.

모든 검사를 통과한 뒤에만 `/var/lib/round/releases/current.env`를 기록한다. 여기에는
세 digest, checkout commit, Compose·runtime-config digest, Compose project, ROUND
domain, 고정 local Docker endpoint가 들어간다. 이미지 줄은 별도 immutable identity로
기록하므로 runtime-config digest에서 제외한다. 다음 배포가 성공하면 이전 complete
state는 `previous.env`로 이동한다.

pull/up이 시작된 candidate는 성공할 때까지 `in-progress.env`로 남는다. 실패하면 새
배포를 막고 명시적인 rollback이 `current.env`를 다시 배포한다. 첫 배포 실패로
`current.env`가 없으면 rollback은 Compose project를 완전히 내리고 marker를 지운다.
rollback 자체도 target/origin journal을 사용하며, 중단되면 다음 rollback이 stable
state를 복구할 때까지 다른 lifecycle 작업을 막는다. Compose나 이미지 외 runtime
설정이 바뀐 release를 복구하려면 저장한 checkout과 secret-manager 버전을 먼저
복원해야 한다.

SIGKILL처럼 EXIT trap이 실행되지 않아 `.deploy-snapshot.*`이 남으면 다음 lifecycle
명령은 lock 획득 직후 안전하게 거부한다. 이 디렉터리에는 runtime 비밀이 있으므로 먼저
소유자와 mode가 `0700`/`0600`인지 확인하고, `pending.env`, `in-progress.env`,
`rollback-pending.env`, `rollback-in-progress.env`, `rollback-origin.env` 중 어떤
저널이 함께 남았는지 점검한다. 재실행에 앞서 확인한 정확한 스냅샷 디렉터리의
`runtime.env`와 `compose.yml`만 `rm -f --`로 제거하고 빈 디렉터리를 `rmdir --`로
제거한다. wildcard나 재귀 삭제는 사용하지 않는다.

`pending.env`만 남은 deploy 사전 단계는 Docker 변경 전이므로 pending을 제거한 뒤
deploy를 새로 실행한다. rollback marker 없이 `rollback-pending.env` 또는
`rollback-origin.env`만 남은 경우도 Docker 변경 전이다. 존재하는 pending은
`previous.env`와, origin은 `current.env`와 각각 대조한 뒤 존재하는 pending/origin을
제거하고 rollback을 새로 실행한다. `in-progress.env`나
`rollback-in-progress.env`가 있으면 해당 저널은 보존하고 rollback을 다시 실행해
기록된 상태로 수렴한다.

ROUND는 추가된 `chat.ack` DataChannel 기능을 협상하지 않습니다. 새 stack이 아래 검사를
통과하면 활성 ROUND tab이 있는 모든 참가자가 채팅을 재개하기 전에 새로고침하고 다시
입장하게 합니다. 이전/새 web client가 섞인 방을 유효한 rollout으로 취급하지 마세요. 이전
수신자는 확인 응답 없이 메시지를 표시할 수 있어 새 발신자가 45초 전달 deadline 뒤 안전하게
실패할 수 있습니다.

Docker port publishing은 Caddy만 사용하고 coturn은 문서화된 port를 Linux host network를
통해 직접 bind합니다. Signaling은 내부 Compose network의 `8787`에서만 listen합니다. 방
membership은 메모리에 있으므로 `deploy.replicas`는 의도적으로 1로 고정합니다. 안전하게
horizontal scaling하려면 먼저 공유 room registry와 cross-node signaling이 필요합니다.

이 설명은 함께 제공하는 standalone stack에 적용됩니다. BATON 배포는 auth-mode override를
사용해 이 Compose file을 재사용하지 말고 자체 orchestrator에서 동일한 private-port 및 단일
replica 보장을 제공해야 합니다.

edge binary에는 commit `5625512f24f6f59d6f64fb3aafe5eecff0b286db`로 고정한 community
`github.com/mholt/caddy-ratelimit` module이 포함됩니다. 공식 Caddy module이 아닙니다. 이
고정값의 변경도 보안에 민감한 다른 dependency처럼 취급합니다. upstream code와 호환성을
검토하고 validation target을 다시 build하며, 움직이는 branch를 추적하지 말고 release
workflow에서 새 SBOM을 만들게 합니다.

## 실행 중인 서비스 검증

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

Compose TURN healthcheck는 로컬의 인증되지 않은 STUN listener 검사입니다. container liveness를
확인하는 데 유용하고 coturn이 listen하지 않을 때 `docker compose up --wait`를 실패하게 하지만,
public TURN allocation, authentication, NAT forwarding, relay media 동작을 입증하지는 않습니다.
마찬가지로 edge `/healthz` 성공은 Caddy에서 signaling까지의 접근 가능성만 입증합니다. 수동
TLS 검사에서는 `-verify_hostname`과 `-verify_return_error`를 모두 유지합니다. 일반
`s_client` 연결은 certificate 검증이 오류를 보고해도 완료될 수 있습니다.

TURN 서버와 그 NAT 외부의 Linux monitoring host에서 인증된 relay probe를 실행합니다.

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

monitor에는 `curl`, `jq`, `openssl`, GNU `timeout`, Docker가 필요합니다. `TURN_PROBE_IMAGE`는
배포와 동일하게 검토된 coturn digest로 고정합니다. probe는 password를 출력하지 않고 공유
access credential을 사용하며, 출력하지 않은 채 새 수명이 짧은 TURN credential을 가져와
게시된 URL과 만료를 검증합니다. monitor host의 OpenSSL trust store로 TLS certificate chain과
DNS hostname을 검증한 뒤에만 UDP, TCP, TLS를 통한 인증 client-to-client relay traffic을
생성합니다. 의도적으로 private TURN CA를 사용한다면 읽을 수 있는 일반 PEM CA bundle을
`TURN_PROBE_CA_FILE`에 설정합니다. probe는 이를 mode `0600` 임시 파일로 snapshot하고 host
TLS 검사와 read-only coturn utility container mount에 같은 byte를 사용합니다. 검증을
비활성화하지 마세요. monitor의 plaintext password는 배포 env file이나 명령 인자가 아닌 secret
manager에 저장합니다. 0이 아닌 exit는 배포 실패로 처리합니다.

### 보호된 외부 TURN 워크플로

수동 `External TURN pilot probe` GitHub Actions workflow는 TURN host와 그 NAT 외부의
GitHub-hosted Linux runner에서 동일한 probe를 실행합니다. 최초 실행 전에는 다음을 준비합니다.

1. 필수 pull request review로 default branch를 보호합니다. 다음 파일에는 code owner review를
   요구합니다. `.github/workflows/external-turn-probe.yml`,
   `ops/turn/probe.sh`, `ops/turn/verify-tls.sh`, 두
   `ops/turn/resolve-external-*.sh` 스크립트,
   `ops/turn/external-pilot-target.properties`,
   `ops/ci/*external-turn-workflow*.mjs`입니다. repository plan에서 지원한다면 self-review와
   administrator bypass를 막습니다.
2. 보호된 pull request를 통해 `ops/turn/external-pilot-target.properties`를 검토합니다. 현재
   `round.b4ton.com`, `turn.b4ton.com`을 대상으로 하며 예약된 example host는 runtime에
   거부됩니다. 파일에는 정확한 public ROUND origin, public TURN hostname, 검토된
   `coturn/coturn@sha256` image가 있어야 합니다. 따라서 목적지나 digest를 변경하면 검토할 수
   있는 Git history entry가 남습니다.
3. default branch로 제한된 `round-pilot` environment를 만듭니다. repository plan에서 이
   제어를 지원한다면 필수 reviewer를 추가하고 self-review를 막습니다. 다음 environment
   secret만 저장합니다.

| Secret                  | 값                                             |
| ----------------------- | ---------------------------------------------- |
| `ROUND_ACCESS_USER`     | Standalone 공유 접근 username                  |
| `ROUND_ACCESS_PASSWORD` | Standalone 공유 접근 plaintext password        |
| `TURN_PROBE_CA_PEM`     | 선택적 private TURN CA PEM, public CA이면 생략 |

default branch에서 workflow를 dispatch하고 운영자가 pilot에 배포되었다고 판단한 annotated
release tag를 제공합니다. secret이 없는 첫 job은 다른 branch, 형식이 잘못되었거나 lightweight인
tag, 현재 default branch에서 도달할 수 없는 release, example 목적지, 검토된
`coturn/coturn` 저장소 밖의 image를 거부합니다. 그 뒤에만 `round-pilot` job이 credential을
읽고 UDP, TCP, TLS를 검사합니다.

run summary에는 운영자가 선언한 tag, tag object SHA, release commit, workflow commit,
public target, probe image digest를 기록합니다. 실행 중인 service revision을 조회하지
**않으므로** 선언한 release가 배포되었음을 입증하지는 않습니다. run을 pilot 증거로 인정하기
전에 이 식별자를 배포 platform 또는 immutable image 게시 기록과 비교하고 `v*` tag ruleset으로
release tag의 변경과 삭제를 보호합니다. workflow run URL과 이 독립적인 배포 identity 증거를
기록합니다. promotion이 자동화될 때까지 운영자는 GitHub가 promotion을 차단했다고 주장하지 말고
0이 아닌 probe 결과를 수동 중단 조건으로 취급해야 합니다.

첫 public-host run이 성공하고 담당 maintainer가 GitHub Actions 실패 알림 수신을 확인할 때까지
이 release 증거 workflow를 수동으로 유지합니다. 이 gate를 통과한 뒤 default branch로 제한된
별도 `round-monitor` environment를 만들고 동일한 probe secret 3개만 복사합니다. scheduled
job은 사람 environment reviewer를 기다릴 수 없으므로 이 environment는 보호된 default branch,
code owner가 관리하는 workflow 및 target file, 빈 top-level permission, 고정된 checkout action,
environment branch 제한에 의존합니다. repository 변수
`ROUND_EXTERNAL_TURN_MONITOR_ENABLED=true`를 설정한 경우에만 schedule을 활성화합니다.

`.github/workflows/external-turn-monitor.yml`은 검토된
`round.b4ton.com`/`turn.b4ton.com` target을 6시간마다 probe합니다. 한 번의 일시적인 결과로는
alert하지 않습니다. 20초와 40초 backoff를 두고 전체 UDP/TCP/TLS probe를 연속 3회 시도해
실패해야 run이 실패합니다. repository owner가 이 workflow 실패 알림을 받는지 확인합니다.
변수를 다른 값으로 설정하면 scheduled run에는 secret이 없고 실행을 건너뜁니다. 단지 monitor
상태를 저장하기 위해 write permission을 부여하지 않도록 threshold는 여러 run 사이에 보존하지
않고 하나의 run 안에서 계산합니다. monitor는 가용성 증거일 뿐이며 수동 annotated-tag
workflow가 release 증거입니다. standalone Basic Auth workflow 어느 것도 BATON 참여권 경계를
입증하지 않으며 coturn utility probe는 브라우저의 UDP 차단 fallback 테스트를 대체하지 않습니다.

credential 응답에는 `urls`, `username`, `credential`, `expiresAt`(epoch seconds), 서버가
파생한 상대적인 `refreshAfterSeconds`가 포함되지만 shared secret은 포함되지 않습니다.
브라우저는 monotonic clock을 사용해 이 상대 field에서 갱신을 예약해야 하며 `expiresAt`을
브라우저 wall clock과 비교하지 않습니다. 브라우저와 network 조합 2개에서 WebSocket
signaling이 연결되고 `chrome://webrtc-internals` 또는 동등한 브라우저 진단에 `relay` ICE
candidate가 표시되는지 별도로 확인합니다.

Caddy는 모든 route에 access record를 남겨 공유 인증 실패와 rate-limit 응답을 관찰할 수 있게
합니다. encoding 전 request header와 전체 URI를 제거하고 client 및 remote 주소는 짧고 안정적인
hash로 교체합니다. 따라서 초대 room code, referrer, cookie, query credential, raw IP 주소를
저장하지 않고 `401`, `429`를 status 수준에서 연관 지을 수 있습니다. Application과 TURN log도
동일하게 room code와 credential을 남기지 않는 규칙을 따라야 합니다. Caddy error log는 request
header와 URI를 완전히 생략합니다.

## 운영

- Caddy ACME 상태는 `caddy_data`, `caddy_config` named volume에 있습니다.
  `ops/linux/backup-caddy.sh`는 deploy 및 rollback과 같은 lifecycle 경계를 lock하고, `edge`가
  이미 실행 중이었을 때만 중지하며, `current.env`에 기록된 immutable edge image를 통해 두
  volume을 stream하고 archive를 `age`로 직접 암호화한 뒤 health를 기다리며 Caddy를 재시작합니다.
  plaintext backup data는 host filesystem에 기록하지 않습니다. 별도의 신뢰하는 machine에서
  age identity를 만들고 public recipient만 `/etc/round/backup-recipients.txt`에 넣습니다.
  먼저 수동 snapshot 하나를 만듭니다.

  ```bash
  sudo ops/linux/backup-caddy.sh \
    --recipient-file /etc/round/backup-recipients.txt \
    --output-dir /var/backups/round \
    /etc/round/production.env
  ```

  이 local file은 backup 구성 요소일 뿐 완성된 backup 정책이 아닙니다. host 외부 backend,
  upload 성공 alert, retention 정책, restore 리허설을 선택하기 전에는 local-only timer를
  활성화하거나 RPO를 충족했다고 주장하지 마세요. 여기에 custom uploader를 추가하는 대신
  restic처럼 검증된 암호화 backup 도구를 scheduled off-host 전송에 사용하는 것을 권장합니다.
  ROUND script는 의도적으로 archive를 upload하거나 prune하지 않습니다.

  restore 명령은 파괴적이며 정확한 확인 token을 요구합니다. 검사 전에 lifecycle lock을 잡고,
  실행 중이거나 중지된 Compose container 집합이 있으면 거부하며, 선택적인 checksum과 archive
  path를 검증하고, 새 host에 없는 named volume을 만듭니다. 검사할 수 있도록 ROUND는 중지된
  상태로 둡니다.

  ```bash
  docker compose --env-file /etc/round/production.env down
  sudo ops/linux/restore-caddy.sh \
    --identity-file /secure/off-host/round-backup-identity.txt \
    --confirm RESTORE_CADDY_VOLUMES \
    /var/backups/round/round-caddy-YYYYMMDDTHHMMSSZ.tar.age \
    /etc/round/production.env
  sudo ops/linux/deploy.sh /etc/round/production.env
  ```

  age identity를 ROUND host에 두지 마세요. `/etc/round/production.env`는 host의 암호화
  secret-backup system을 통해 별도로 backup합니다. TURN shared secret이 포함되어 있어 Caddy
  volume에서 복원할 수 없습니다.

- Signaling과 coturn runtime file은 휘발성입니다. signaling을 재시작하면 활성 방과 WebSocket
  session이 사라집니다.
- env file을 갱신하고 signaling과 turn을 함께 다시 생성해 `TURN_SHARED_SECRET`을 회전합니다.
  coturn이 secret을 전환하면 이전에 발급한 credential은 동작하지 않으므로 짧은 maintenance
  window를 계획합니다.
- 공유 pilot password의 노출은 모든 방의 노출로 취급합니다. 새 password와 bcrypt cost-12
  hash를 만들고 `ROUND_ACCESS_PASSWORD_HASH`를 갱신한 뒤 `edge`만 다시 생성합니다. 새
  plaintext는 별도 channel로 다시 배포하고 이전 credential은 즉시 취소합니다.
- env file, coturn firewall, router forwarding, cloud security group에서 relay range를 일관되게
  유지합니다.
- 이전 edge, signaling, TURN digest reference는 테스트한 하나의 집합으로만 rollback합니다.
  명시적인 token은 실수로 붙여 넣은 명령이 안전하게 실패하게 합니다.

  ```bash
  sudo ops/linux/rollback.sh \
    --confirm ROLLBACK_ROUND \
    /etc/round/production.env
  ```

  명령은 preflight를 다시 실행하고 저장된 immutable 집합을 pull하며 모든 health check를 기다린
  뒤, roll-forward가 계속 가능하도록 전체 `current.env`/`previous.env` 상태를 맞바꿉니다.
  `in-progress.env`가 있으면 검증된 현재 상태를 다시 배포하고 health check 통과 뒤에만 실패한
  시도를 지웁니다. mutable tag로 대체하거나 signaling을 하나보다 많이 scale하지 마세요.
  시작/종료 시각, 복원한 digest, `docker compose ps`, service log, public `/healthz`, TURN TLS
  검증, external relay 결과를 rollback 증거로 기록합니다. 성공 후에는 서로 다른 web bundle의
  DataChannel 기능이 한 방에 섞이지 않도록 모든 활성 ROUND tab에서 새로고침하고 다시 입장하게
  합니다.
