# ROUND

시간 제한 없이 소규모 스터디원이 영상, 음성, 채팅으로 만나는 개인용 WebRTC
스터디룸입니다.

ROUND의 첫 버전은 최대 6명이 브라우저끼리 직접 연결되는 mesh 구조입니다. signaling
서버는 참가자를 찾아주고 연결 정보를 전달할 뿐, 영상과 음성을 저장하거나 중계하지
않습니다.

## MVP 기능

- 읽기 쉬운 방 코드와 공유 가능한 초대 링크
- 카메라·마이크 기반 다자간 WebRTC 통화
- 입장 전 미리보기와 카메라·마이크 선택
- 마이크 음소거와 카메라 켜기/끄기
- 카메라 송신을 안전하게 교체하는 화면 공유 시작·중지
- 방장의 다른 참가자 마이크·카메라 끄기 요청
- WebRTC DataChannel 기반 휘발성 텍스트 채팅과 참가자별 수신 확인
- 참가자 입장·퇴장과 연결 상태 표시
- IP 주소를 포함하지 않는 요청형 WebRTC 연결 진단과 결과 복사
- 한쪽 미디어 권한만 허용해도 음성 전용 또는 영상 전용으로 입장
- 일시적인 signaling·ICE 연결 장애 자동 복구
- 데스크톱과 모바일 반응형 화면

계정, 녹화, 채팅 저장, 강제 퇴장과 영구적인 미디어 잠금은 아직 포함하지 않습니다.

## 로컬 실행

필요한 도구:

- Node.js 22.13 이상
- npm 11 이상
- Java 21

```bash
npm install
cp .env.example .env
npm run dev
```

Gradle은 저장소의 Wrapper를 사용하므로 별도로 설치하지 않아도 됩니다. `npm run dev`가
루트 `.env`를 Spring Boot와 Vite 양쪽에 전달하고 signaling 서버와 웹 앱을 함께
실행합니다.

브라우저에서 [http://localhost:5173](http://localhost:5173)을 엽니다. 서로 다른 브라우저
프로필이나 시크릿 창을 함께 열면 2명 입장을 로컬에서 확인할 수 있습니다.

전체 검증:

```bash
npm run check
```

Chromium 전체 미디어 흐름과 WebKit 호환성 smoke를 함께 검증:

```bash
npx playwright install chromium webkit
npm run test:e2e
```

`chromium-full-media` 프로젝트는 fake 카메라·마이크·화면 스트림을 사용해 직접 초대 입장,
원격 미디어 연결, 화면 공유 전환, 방장의 원격 미디어 끄기, DataChannel 채팅과 수신 ACK,
퇴장을 확인합니다. `webkit-smoke` 프로젝트는 실제 Playwright WebKit 엔진에서 직접 초대와
명시적 장치 동의 경계, 미디어 없이 입장한 두 참가자의 DataChannel 채팅과 퇴장을 확인하며
카메라·마이크를 자동 허용하지 않습니다. Chromium과 WebKit의 mobile layout 프로젝트는
대표 모바일 viewport에서 채팅 작성 영역과 통화 제어가 겹치거나 가로로 넘치지 않는지
검사합니다. BATON 참여권, 실제 TURN relay와 실장치의 화면 선택 UI는 이 테스트 범위에 포함되지
않으며 파일럿 체크리스트를 별도로 통과해야 합니다. 실패 진단 자료는 `output/playwright/`에
저장됩니다.

실제 iOS Safari의 기본 화면과 미디어 없이 입장하는 흐름은 BrowserStack Automate에서 선택적으로
검사합니다. 저장소 Actions secret에 `BROWSERSTACK_USERNAME`과 `BROWSERSTACK_ACCESS_KEY`를
등록한 뒤 **실제 iOS Safari 검사** workflow를 수동 실행합니다. 일반 push나 PR에서는 실행하지
않으므로 실장치 사용 시간을 소모하지 않습니다. 로컬에서도 같은 secret과 실행 식별자를 환경
변수로 전달해 실행할 수 있습니다.

```bash
GITHUB_RUN_ID=local GITHUB_RUN_ATTEMPT=1 npm run test:e2e:ios-safari
```

이 자동 검사는 iPhone 14와 iOS 18 조합의 화면 넘침, 입장, 진단 패널과 채팅 제어만 확인합니다.
실제 카메라·마이크, TURN relay, 2~6명 통화, 백그라운드 복귀는 BrowserStack 결과로 대체하지 않고
파일럿 체크리스트에서 별도로 확인합니다. 장치 조합이 BrowserStack에서 폐기되면 공식 지원 목록을
확인한 뒤 `browserstack.yml`을 변경합니다.

## 환경 변수

| 변수                                                  | 기본값                  | 설명                            |
| ----------------------------------------------------- | ----------------------- | ------------------------------- |
| `PORT`                                                | `8787`                  | signaling HTTP/WebSocket 포트   |
| `HOST`                                                | `0.0.0.0`               | signaling bind 주소             |
| `ALLOWED_ORIGINS`                                     | `http://localhost:5173` | 쉼표로 구분한 허용 Origin       |
| `ROUND_AUTH_MODE`                                     | `standalone`            | `standalone` 또는 `baton`       |
| `ROUND_STANDALONE_HOST_TOKEN_SHA256`                  | 없음                    | standalone 방장 키 SHA-256      |
| `ROUND_AUTH_COOKIE_NAME`                              | `__Secure-round_access` | BATON 참여권 cookie 이름        |
| `ROUND_AUTH_ISSUER`                                   | 없음                    | 신뢰할 BATON JWT issuer         |
| `ROUND_AUTH_AUDIENCE`                                 | `round`                 | 참여권의 유일한 audience        |
| `ROUND_AUTH_JWK_SET_URI`                              | 없음                    | BATON 공개 JWK Set HTTPS URI    |
| `ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS`               | `300`                   | 참여권 최대 허용 수명(초)       |
| `MAX_ROOM_SIZE`                                       | `6`                     | 방 최대 참가자 수               |
| `MAX_SIGNALING_CONNECTIONS`                           | `1000`                  | 서버 전체 signaling 연결 제한   |
| `MAX_SIGNALING_CONNECTIONS_PER_CLIENT`                | `12`                    | IP별 동시 signaling 연결 제한   |
| `HEARTBEAT_INTERVAL_MS`                               | `30000`                 | 연결 상태 확인 주기(ms)         |
| `UNJOINED_SOCKET_TIMEOUT_MS`                          | `15000`                 | 미입장 socket 종료 기한(ms)     |
| `UNJOINED_SOCKET_SWEEP_MS`                            | `1000`                  | 미입장 socket 검사 주기(ms)     |
| `SIGNALING_SHUTDOWN_CLOSE_TIMEOUT_MS`                 | `5000`                  | 종료 시 전체 close 제한(ms)     |
| `SIGNALING_ABUSE_WINDOW_MS`                           | `10000`                 | 수신 프레임 고정 윈도우(ms)     |
| `SIGNALING_MAX_FRAMES_PER_SESSION`                    | `600`                   | 윈도우당 세션 프레임 제한       |
| `SIGNALING_MAX_FRAMES_PER_CLIENT`                     | `1200`                  | 윈도우당 IP 합산 프레임 제한    |
| `SIGNALING_MAX_FRAMES_GLOBAL`                         | `3600`                  | 윈도우당 서버 프레임 제한       |
| `SIGNALING_MAX_BYTES_PER_SESSION`                     | `4194304`               | 윈도우당 세션 수신 바이트 제한  |
| `SIGNALING_MAX_BYTES_PER_CLIENT`                      | `8388608`               | 윈도우당 IP 합산 바이트 제한    |
| `SIGNALING_MAX_BYTES_GLOBAL`                          | `25165824`              | 윈도우당 서버 수신 바이트 제한  |
| `SIGNALING_MAX_OUTBOUND_QUEUE_BYTES`                  | `2097152`               | peer별 송신 대기 바이트 제한    |
| `SIGNALING_MAX_OUTBOUND_QUEUE_BYTES_GLOBAL`           | `67108864`              | 서버 전체 송신 대기 바이트 제한 |
| `VITE_ROUND_AUTH_MODE`                                | `standalone`            | 브라우저 endpoint 인증 모드     |
| `VITE_SIGNALING_URL`                                  | 현재 호스트의 `/signal` | standalone WSS/WS 주소 override |
| `VITE_STUN_URLS`                                      | Cloudflare 공개 STUN    | 쉼표로 구분한 STUN 주소         |
| `VITE_TURN_CREDENTIALS_URL`                           | `/api/turn-credentials` | standalone TURN API override    |
| `VITE_ICE_TRANSPORT_POLICY`                           | `all`                   | `relay`이면 TURN만 강제         |
| `TURN_PROVIDER`                                       | `disabled`              | `disabled` 또는 `cloudflare`    |
| `TURN_CLOUDFLARE_KEY_ID`                              | 없음                    | Cloudflare TURN key ID          |
| `TURN_CLOUDFLARE_API_TOKEN`                           | 없음                    | Cloudflare TURN API token       |
| `TURN_CREDENTIAL_TTL_SECONDS`                         | `600`                   | TURN credential 수명(초)        |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`           | `600`                   | IP별 발급 제한 구간(초)         |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`             | `12`                    | 구간당 IP별 최대 발급 수        |
| `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` | `6`                     | BATON 참가자·방별 최대 발급 수  |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`      | `24`                    | 구간당 서버 전체 최대 발급 수   |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`              | `10000`                 | rate-limit 상태 최대 IP 수      |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`         | `10000`                 | BATON 참가자 상태 최대 수       |
| `COMPOSE_PROFILES`                                    | `none`                  | `observability`이면 Alloy 실행  |
| `GRAFANA_ALLOY_IMAGE`                                 | Alloy 1.18.1 digest     | 검토한 Alloy 불변 이미지        |
| `GRAFANA_CLOUD_PROMETHEUS_URL`                        | 없음                    | Metrics remote write URL        |
| `GRAFANA_CLOUD_PROMETHEUS_USER`                       | 없음                    | Metrics instance 사용자 ID      |
| `GRAFANA_CLOUD_API_TOKEN`                             | 없음                    | `metrics:write` 전용 token      |

프레임 수와 수신 바이트 제한은 세션, IP 합산, 서버 전체 순서로 함께 적용됩니다. 세션
초과 연결은 닫고 IP 또는 서버 전체 제한을 넘은 프레임은 다른 클라이언트에 영향을 주지
않도록 버립니다. IP 합산 제한은 세션 제한 이상이어야 하고, 서버 전체 제한은 고정
윈도우 경계 차이를 고려해 IP 합산 제한의 두 배 이상이어야 합니다. 미입장 socket 검사
주기는 100~1,000ms 범위이며 미입장 종료 기한을 넘을 수 없습니다. 송신 큐는 peer별
프레임·바이트 제한과 서버 전체 64MiB 바이트 제한을 함께 적용합니다. TURN 발급 제한도
같은 전역 여유 규칙을 사용합니다.
마지막 연결이 끊겨도 IP별 프레임 상태는 현재 abuse window가 끝날 때까지 유지되므로 같은
IP의 재연결로 quota를 초기화할 수 없습니다. 만료된 비활성 상태는 연결 시점과 주기적
sweep에서 정리되며, 상태 맵이 가득 차면 활성 상태를 보존하고 비활성 상태만 제거합니다.

standalone 방장 기능을 켤 때는 Basic Auth 비밀번호와 다른 최소 32자의 무작위 키를 만들고
서버에는 그 SHA-256만 저장합니다. 하나의 digest는 해당 standalone 서버의 모든 방에
적용되므로 원문 키는 방장에게만 전달하고 유출 시 즉시 회전해야 합니다. 참가자 화면에는
원문이 저장되거나 다시 표시되지 않으며, 빈 값은 일반 참가자 입장입니다.

BATON 모드에서는 진행 중인 handshake와 활성 WebSocket을 합쳐 동일 참여권 `jti`당 1개,
동일 `(room_id, sub)`당 2개까지만 허용합니다. 두 번째 사용자 슬롯은 BATON이 새 `jti`로
발급한 정상 재연결 중첩을 위한 것이며, 세 번째 연결은 기존 연결을 끊지 않고 HTTP 429로
거절합니다. 이 제한은 standalone 모드에는 적용되지 않습니다.

TURN 기본 발급 구간은 credential TTL과 같은 600초입니다. IP당 12회는 같은 NAT 뒤의
6명 참가자가 최초 발급 후 8분경 한 번씩 자동 갱신할 수 있게 하고 서버 전체는 24회로
제한합니다. TTL이나 브라우저 갱신 시점을 변경하면 발급 구간과 한도도 함께 검토해야
합니다. BATON 모드는 같은 구간에 `(room_id, sub)`당 6회의 참가자 quota도 함께 적용하며,
새 `jti` 발급이나 접속 IP 변경으로 초기화되지 않습니다. 참가자·IP·전역 제한은 모두
통과할 때만 한 번에 차감됩니다. standalone 모드는 참가자 quota를 적용하지 않습니다.
운영 Compose의 Caddy는 공유 접근 자격을 요구해 익명 요청을 차단하지만, 이를 알고 있는
사용자를 서로 구분하거나 스터디 멤버십까지 확인하지는 않습니다. BATON에서도 IP·전역
발급 quota와 Cloudflare 사용량 경보는 계정 탈취와 relay 자원 남용을 제한하기 위해 계속
유지합니다.

## 저장소 구조

```text
apps/
  web/          React + Vite 화면
  signaling/    Java 21 + Spring Boot WebSocket signaling 서버
packages/
  protocol/     클라이언트/서버 공유 메시지 계약
  rtc-core/     React에 의존하지 않는 WebRTC 엔진
```

자세한 설계 의도는 [docs/architecture.md](docs/architecture.md)에 정리되어 있습니다.

## 실제 배포 전 알아둘 점

카메라와 마이크는 `localhost`를 제외하면 HTTPS에서만 사용할 수 있습니다. 외부 스터디원과
사용하려면 웹은 HTTPS, signaling은 WSS로 배포해야 합니다.

기본 STUN 설정만으로는 회사·학교망이나 제한적인 NAT 환경에서 연결을 보장할 수 없습니다.
실사용 배포에는 TURN 서비스가 필요합니다. ROUND의 Java 서버는 Cloudflare API에서 짧은
수명의 credential을 받아 브라우저에 전달하며 API token을 브라우저 번들에 넣지 않습니다.
mesh 방식은 참가자마다
업로드 스트림 수가 늘어나므로 영상은 기본 640×360, 최대 15fps이며 첫 버전은 6명으로
제한합니다.

운영 배포에는 Caddy와 단일 Java signaling 인스턴스를 포함한 Compose 구성이 준비되어
있습니다. TURN relay는 Cloudflare가 운영합니다. 외부 앱·WebSocket·TURN credential API는
HTTPS Caddy의 공유 접근
인증 뒤에 놓이고, `/healthz`만 공개됩니다. 서버 준비, 접근 비밀번호 hash, DNS,
방화벽, Cloudflare key, relay-only 검증과 롤백 절차는 [배포 가이드](docs/deployment.md)를
따르세요. 스터디 그룹에 공개하기 전에는 [파일럿 체크리스트](docs/pilot-checklist.md)를
모두 통과해야 합니다.

## BATON 연동 경계

ROUND는 BATON 내부로 signaling 코드를 옮기지 않고 별도 저장소, 배포, 런타임을 유지합니다.
BATON은 사용자·스터디·참여 권한을 소유하고, ROUND는 휘발성 room·peer 상태와 signaling,
TURN credential 발급을 소유합니다. 두 서비스는 데이터베이스나 엔티티를 공유하지 않으며,
ROUND는 signaling 프레임마다 BATON API를 호출하지 않습니다.

BATON은 권한 확인 후 `kid`를 포함한 `RS256`으로 짧은 수명의 JWT 참여권을 서명합니다.
참여권은 `HttpOnly`, `Secure`, `SameSite=Strict`,
`Path=/round/rooms/{roomId}` 쿠키로 전달하고, ROUND는 BATON JWK Set의 공개키로
서명·issuer·audience와 필수 claim을 검증합니다. `room_id`는 URL 경로 및
`room.join`의 방 식별자와 일치해야 합니다.
`aud`는 정확히 하나여야 하며 설정한 값(기본 `round`) 외 audience가 함께 있으면
거부합니다. ROUND JVM의 JWK Set cache는 60초 뒤 만료하고, 아직 cache에 없는 정상 형식의
새 `kid`를 만나면 JWK Set을 다시 조회해 key 선게시 회전을 수용합니다. Nimbus source는
cold load와 cache-miss retry를 수용하면서 원격 source 접근을 JVM별 30초 window에서 최대
두 번으로 제한하며, 제한 중인 unknown `kid`는 추가 원격 조회 없이 `401`로 거부합니다.
따라서 새 공개키는 발급 전 60초보다 길게 선게시해야 합니다.

BATON 연동 시 브라우저가 사용하는 공개 경로는 다음과 같습니다.

- 참여권 갱신: `POST /round/rooms/{roomId}/participation-grant/refresh`
- WebSocket: `/round/rooms/{roomId}/signal`
- TURN 자격 증명: `/round/rooms/{roomId}/turn-credentials`

BATON이 제공하는 웹 번들은 빌드 시 `VITE_ROUND_AUTH_MODE=baton`을 주입하고
`VITE_SIGNALING_URL`, `VITE_TURN_CREDENTIALS_URL`은 비워 둡니다. 브라우저는 세 경로를
같은 canonical `roomId`의 동일 출처 경로로 계산하며, BATON 모드에서 외부 endpoint
override가 있거나 모드 값이 올바르지 않으면 standalone으로 강등하지 않고 연결을
거부합니다. 릴리스는 이 번들을 `/round-ui/` asset base의
`round-baton-web` 이미지로 별도 발행하며 `round-edge`와 교체해서 사용할 수 없습니다.
이 Vite 값과 이미지 flavor 표식은 공개 설정일 뿐 참여권이나 다른 비밀을 포함하지
않습니다. BATON 전용 edge는 해시가 붙은 `/round-ui/assets/*`만 장기 immutable cache하고,
`/room/*` HTML은 `no-store`로 전달합니다. `/round-ui/` 자체는 독립 방 생성 화면을 열지
않고 404를 반환하므로 사용자는 BATON의 권한 있는 스터디 화면에서 방을 열어야 합니다.

BATON은 참여권 갱신 경로에서 인증된 사용자와 현재 스터디 멤버십을 다시 확인하고, 새
`jti`의 방별 쿠키를 회전합니다. 응답은 JWT 없이 `expiresAt`과
`refreshAfterSeconds`만 반환합니다. 이 경로는 ROUND로 proxy하지 않습니다. edge proxy는
나머지 두 경로만 ROUND 내부의 `/rooms/{roomId}/signal`과
`/api/rooms/{roomId}/turn-credentials`로 전달합니다. standalone 모드의 기존 `/signal`,
`/api/turn-credentials`와 Caddy 공유 접근 credential은 소규모 파일럿을 위해 유지하지만,
BATON 모드는 유효한 참여권이 없으면 fail-closed로 요청을 거부합니다.

브라우저는 BATON 방 URL을 열면 먼저 Account session과 방 참여권을 확인하며, 성공하기
전에는 입장 전 화면을 렌더링하거나 카메라·마이크 권한을 요청하지 않습니다. `401`은
canonical `/room/{roomId}` 복귀 경로를 가진 BATON 로그인으로 안내하고, `403`은 로그인
반복 없이 BATON 홈으로 돌아가 권한을 확인하게 합니다. 이 선행 확인에 사용한 single-flight
manager를 실제 입장까지 재사용하므로 즉시 두 번째 참여권 발급을 만들지 않습니다.
입장 전 화면에서 `refreshAfterSeconds`가 지나면 장치 권한 요청과 미디어 없는 입장 직전에
같은 manager로 다시 확인합니다. 이후 TURN 갱신과 모든 WebSocket 최초 연결·재연결
전에도 참여권을 확인합니다. 활성 방의 갱신 `401`·`403`·`404`는 재시도하지 않고 각각
로그인, 권한 확인, 종료된 방 안내로 전환합니다. BATON 모드의 사용자가 입력한 별칭은
계정 범위 없는 브라우저 저장소에 남기지 않고 현재 문서에서만 유지합니다. 지원하지 않는
인증 모드는 입장 화면이나 미디어 동의 UI를 렌더링하기 전에 설정 오류로 차단합니다.
기존 socket은 연결 당시 참여권의 `exp`에서 `4001 / Participation grant expired`로
종료되고, 제한된 자동 재연결이 미리 회전된 쿠키를 사용합니다. standalone 연결에는 이
시간 제한과 갱신 흐름을 적용하지 않습니다.

같은 `(room_id, sub)`의 새 참여권 연결이 방에 입장하면 ROUND는 더 최근 연결만 남기고
기존 연결을 원자적으로 정리한 뒤 `4002 / Participation session superseded`로 닫습니다.
기존 연결의 입장 예약은 이 터미널 close 시도가 끝날 때까지 유지되므로, close가 지연되는
동안 세 번째 연결이 제한을 우회할 수 없습니다.
이 종료는 네트워크 장애가 아니므로 기존 브라우저는 자동 재연결하지 않습니다. 따라서
6명이 찬 방에서도 정상 재연결이 `ROOM_FULL`에 막히거나 두 브라우저가 서로를 반복해서
밀어내지 않습니다.

BATON의 Caddy 설정에서는 카메라·마이크·화면 캡처 `Permissions-Policy`, WebSocket `connect-src`,
두 ROUND proxy 경로, BATON 갱신 경로와 cookie path를 함께 구성해야 합니다. BATON에는
Account session·AccountMembership·room mapping·참여권 signer와 JWK가 구현되어 있고, 선택
실행 교차서비스 테스트는 실제 BATON signer와 ROUND bootJar 사이의 TURN·WebSocket·key
회전을 검증합니다. 다만 실제 브라우저 session과 public HTTPS edge를 함께 통과하는 E2E는
완료된 것으로 보지 않습니다. `sub`는 Google OIDC `sub`, Naver 프로필
ID, 이메일과 로그인 공급자 변경에 영향받지 않는 canonical BATON `Account.id`여야 합니다.
공유 접근 키나 브라우저 display name으로 `sub`를 만들어서는 안 됩니다. 전체 결정과 JWT
claim 계약은
[ADR 0001](docs/adr/0001-round-independent-service.md)을 참고하세요.
