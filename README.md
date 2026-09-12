# ROUND

시간 제한 없이 소규모 스터디원이 영상, 음성, 채팅으로 만나는 개인용 WebRTC
스터디룸입니다.

BATON의 통화 참여 버튼이나 공유받은 방 링크에서 **입장 준비 → 통화**로 들어갑니다.
BATON에서는 로그인·방 참여 권한을 먼저 확인하고, ROUND의 입장 준비 화면에서 이름과
카메라·마이크를 설정합니다. 방 생성과 스터디 관리는 BATON이 담당합니다.

ROUND는 최대 6명이 서로 연결하는 메시(mesh) 구조입니다. 시그널링 서버는 참가자와 연결
정보를 관리하고 현재 방의 타이머·주제를 임시 보관합니다. 시그널링 서버는 영상·음성을
저장하거나 중계하지 않습니다. 브라우저 간 직접 연결이 어려우면 설정한 TURN 서버가 중계합니다.

## 주요 기능

- 방 코드, 초대 링크 복사, 기기 공유 메뉴(지원 브라우저)와 QR 초대
- 카메라·마이크 기반 다자간 WebRTC 통화
- 입장 전 미리보기, 카메라·마이크 선택과 마이크 입력 음량 표시
- 마이크 음소거, 카메라 켜기/끄기와 통화 중 입력 장치 교체·마이크 입력 확인
- 카메라 전송 품질 선택(일반·데이터 절약)
- 지원 브라우저의 스피커 선택과 짧은 확인음 재생
- 참가자별 내가 듣는 음량 조절(지원 브라우저)과 소리 끄기·켜기
- 송신을 유지하면서 내 영상만 숨기기·다시 보기
- 카메라·마이크 없이도 사용할 수 있는 손들기·손 내리기, 공통 대기 순서와 참가자 배지
- 화면 공유 시작·중지와 품질 선택(일반·문서/코드)
- 공유 화면 크게 고정·해제, 1~4배 확대·이동·초기화, 전체 화면과 작은 창 보기
- 지원 브라우저의 작은 창에서 내 마이크·카메라 켜기·끄기
- 방장의 다른 참가자 마이크·영상 끄기 요청(화면 공유 포함)
- WebRTC DataChannel 기반 채팅과 참가자별 수신 확인, 대화는 메모리에만 보관
- 이전 채팅을 읽는 동안 스크롤 위치 유지와 새 메시지 알림
- 채팅의 HTTP·HTTPS 링크 열기와 메시지 원문 복사
- 여러 줄 채팅 입력창 자동 높이 조절, 입력 한도 안내와 초과 붙여넣기 방지
- 참가자 입장·퇴장과 연결 상태 표시
- 실패한 참가자만 다시 연결하고 정상 통화·로컬 장치·채팅 기록 유지
- 채팅 수신 미확인 대상 표시와 대상별 재전송(최초 전송 후 2분 이내)
- 실제 음성 레벨에 따른 발언 중 표시와 선택 가능한 참가자별 수신 품질 안내
- 방장이 조작하는 공용 집중·휴식 타이머와 현재 주제, 방장 부재 안내
- 진행 중·일시정지한 공용 타이머의 교체·초기화 확인
- 타이머 종료 화면·탭 제목 안내, 직접 켜는 알림음·데스크톱 알림
- 마이크·카메라·손들기 단축키와 현재 방의 채팅 검색·검색어 강조·결과 이동
- 입장 전 서버 호환성 확인과 새 웹 버전 안내
- IP 주소를 포함하지 않는 요청형 WebRTC 연결 진단과 결과 복사
- 한쪽 미디어 권한만 허용해도 음성 전용 또는 영상 전용으로 입장
- 일시적인 시그널링·ICE 연결 장애 자동 복구
- 데스크톱과 모바일 반응형 화면
- 작성 중인 채팅·화면 공유가 있을 때 나가기 확인과 지원 브라우저의 새로고침·탭 닫기 경고
- 브라우저 뒤로가기·앞으로가기의 퇴장 확인과 취소 시 초안·통화 유지
- 작성 중인 채팅·화면 공유가 있을 때 방 전체 재입장 확인
- 통화 설정에서 직접 켜는 화면 켜짐 유지와 실제 적용 상태 표시(지원 브라우저)

ROUND 자체 계정, 녹화, 채팅 저장, 강제 퇴장과 영구적인 미디어 잠금은 아직 포함하지 않습니다.

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
루트 `.env`를 Spring Boot와 Vite 양쪽에 전달하고 시그널링 서버와 웹 앱을 함께
실행합니다.

브라우저에서 [http://localhost:5173](http://localhost:5173)을 엽니다. 서로 다른 브라우저
프로필이나 시크릿 창을 함께 열면 2명 입장을 로컬에서 확인할 수 있습니다.
독립 실행(`standalone`)의 방 생성·코드 입력 화면은 개발·검증용으로 유지합니다. 방 링크는
독립 실행에서도 소개 화면 없이 입장 준비로 연결됩니다. BATON 운영 화면은 이 방 생성
화면을 사용하지 않습니다.

작은 웹 수정은 타입 검사와 지정한 테스트로 확인합니다. 테스트 경로는 `apps/web` 기준입니다.

```bash
npm run check:web -- src/components/VideoTile.test.tsx
```

검사 선택·실패 재시도·작업 인계는 [검증 절차](docs/agent-validation.md)를 따릅니다.
전체 검증은 기존 타입·테스트·빌드 범위를 유지하며 중복 실행을 합쳤습니다.

```bash
npm run check
```

Chromium 전체 미디어 흐름과 WebKit 기본 호환성을 함께 검증:

```bash
npx playwright install chromium webkit
npm run test:e2e
```

Ubuntu에서 WebKit 검사를 실행할 때는 브라우저 의존성과 mDNS 서비스도 준비합니다.
미디어 권한 없이 직접 연결하는 WebKit은 로컬 IP 대신 `.local` ICE 후보를 사용하므로
Avahi와 이름 조회 모듈이 필요합니다. CI도 같은 설정으로 외부 STUN·TURN 없이 검사합니다.

```bash
npx playwright install --with-deps chromium webkit
sudo apt-get install --yes --no-install-recommends avahi-daemon libnss-mdns
sudo systemctl start avahi-daemon
```

`chromium-full-media` 프로젝트는 가상 카메라·마이크·화면 스트림을 사용해 직접 초대 입장,
원격 미디어 연결, 화면 공유 전환, 방장의 원격 미디어 끄기, DataChannel 채팅과 수신 ACK,
퇴장을 확인합니다. `webkit-smoke` 프로젝트는 Playwright WebKit 엔진에서 직접 초대 입장을
확인합니다. ‘장치 확인’을 누르기 전에는 카메라·마이크 권한을 요청하지 않는지, 두 참가자가
카메라·마이크 없이 입장해 DataChannel로 채팅하고 퇴장할 수 있는지 검사합니다.
카메라·마이크 권한은 자동 허용하지 않습니다. Chromium과 WebKit의 모바일 배치 프로젝트는
대표 모바일 화면 크기에서 채팅 작성 영역과 통화 제어가 겹치거나 가로로 넘치지 않는지
검사합니다. BATON 참여권, 실제 TURN 중계와 실장치의 화면 선택 UI는 이 테스트 범위에 포함되지
않으며 파일럿 체크리스트를 별도로 통과해야 합니다. 실패 진단 자료는 `output/playwright/`에
저장됩니다.

실제 iOS Safari의 기본 화면과 카메라·마이크 없이 입장하는 흐름은 BrowserStack Automate에서 선택적으로
검사합니다. 저장소 Actions secret에 `BROWSERSTACK_USERNAME`과 `BROWSERSTACK_ACCESS_KEY`를
등록한 뒤 **실제 iOS Safari 검사** workflow를 수동 실행합니다. 일반 push나 PR에서는 실행하지
않으므로 실장치 사용 시간을 소모하지 않습니다. 로컬에서도 같은 secret과 실행 식별자를 환경
변수로 전달해 실행할 수 있습니다.

```bash
GITHUB_RUN_ID=local GITHUB_RUN_ATTEMPT=1 npm run test:e2e:ios-safari
```

이 자동 검사는 iPhone 14와 iOS 18 조합의 화면 넘침, 입장, 진단 패널과 채팅 제어만 확인합니다.
실제 카메라·마이크, TURN 중계, 2~6명 통화, 백그라운드 복귀는 BrowserStack 결과로 대체하지 않고
파일럿 체크리스트에서 별도로 확인합니다. 장치 조합이 BrowserStack에서 폐기되면 공식 지원 목록을
확인한 뒤 `browserstack.yml`을 변경합니다.

## 환경 변수

| 변수                                                  | 기본값                  | 설명                            |
| ----------------------------------------------------- | ----------------------- | ------------------------------- |
| `PORT`                                                | `8787`                  | 시그널링 HTTP/WebSocket 포트    |
| `HOST`                                                | `0.0.0.0`               | 시그널링 수신 주소              |
| `ALLOWED_ORIGINS`                                     | `http://localhost:5173` | 쉼표로 구분한 허용 Origin       |
| `ROUND_AUTH_MODE`                                     | `standalone`            | `standalone` 또는 `baton`       |
| `ROUND_STANDALONE_HOST_TOKEN_SHA256`                  | 없음                    | 독립 실행 방장 키 SHA-256       |
| `ROUND_AUTH_COOKIE_NAME`                              | `__Secure-round_access` | BATON 참여권 쿠키 이름          |
| `ROUND_AUTH_ISSUER`                                   | 없음                    | 신뢰할 BATON JWT 발급자         |
| `ROUND_AUTH_AUDIENCE`                                 | `round`                 | 참여권의 유일한 수신 대상       |
| `ROUND_AUTH_JWK_SET_URI`                              | 없음                    | BATON 공개 JWK Set HTTPS URI    |
| `ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS`               | `300`                   | 참여권 최대 허용 수명(초)       |
| `MAX_ROOM_SIZE`                                       | `6`                     | 방 최대 참가자 수               |
| `MAX_SIGNALING_CONNECTIONS`                           | `1000`                  | 서버 전체 시그널링 연결 제한    |
| `MAX_SIGNALING_CONNECTIONS_PER_CLIENT`                | `12`                    | IP별 동시 시그널링 연결 제한    |
| `HEARTBEAT_INTERVAL_MS`                               | `30000`                 | 연결 상태 확인 주기(ms)         |
| `UNJOINED_SOCKET_TIMEOUT_MS`                          | `15000`                 | 미입장 연결 종료 기한(ms)       |
| `UNJOINED_SOCKET_SWEEP_MS`                            | `1000`                  | 미입장 연결 검사 주기(ms)       |
| `SIGNALING_SHUTDOWN_CLOSE_TIMEOUT_MS`                 | `5000`                  | 서버 종료 시 연결 정리 제한(ms) |
| `SIGNALING_ABUSE_WINDOW_MS`                           | `10000`                 | 수신량 고정 집계 구간(ms)       |
| `SIGNALING_MAX_FRAMES_PER_SESSION`                    | `600`                   | 구간당 세션 프레임 제한         |
| `SIGNALING_MAX_FRAMES_PER_CLIENT`                     | `1200`                  | 구간당 IP 합산 프레임 제한      |
| `SIGNALING_MAX_FRAMES_GLOBAL`                         | `3600`                  | 구간당 서버 프레임 제한         |
| `SIGNALING_MAX_BYTES_PER_SESSION`                     | `4194304`               | 구간당 세션 수신 바이트 제한    |
| `SIGNALING_MAX_BYTES_PER_CLIENT`                      | `8388608`               | 구간당 IP 합산 바이트 제한      |
| `SIGNALING_MAX_BYTES_GLOBAL`                          | `25165824`              | 구간당 서버 수신 바이트 제한    |
| `SIGNALING_MAX_OUTBOUND_QUEUE_BYTES`                  | `2097152`               | 참가자별 송신 대기 바이트 제한  |
| `SIGNALING_MAX_OUTBOUND_QUEUE_BYTES_GLOBAL`           | `67108864`              | 서버 전체 송신 대기 바이트 제한 |
| `VITE_ROUND_AUTH_MODE`                                | `standalone`            | 브라우저 인증 모드              |
| `VITE_SIGNALING_URL`                                  | 현재 호스트의 `/signal` | 독립 실행 시 WSS/WS 주소        |
| `VITE_STUN_URLS`                                      | Cloudflare 공개 STUN    | 쉼표로 구분한 STUN 주소         |
| `VITE_TURN_CREDENTIALS_URL`                           | `/api/turn-credentials` | 독립 실행 시 TURN API 주소      |
| `VITE_ICE_TRANSPORT_POLICY`                           | `all`                   | `relay`이면 TURN만 강제         |
| `TURN_PROVIDER`                                       | `disabled`              | TURN 제공자                     |
| `TURN_CLOUDFLARE_KEY_ID`                              | 없음                    | Cloudflare TURN 키 ID           |
| `TURN_CLOUDFLARE_API_TOKEN`                           | 없음                    | Cloudflare TURN API 토큰        |
| `TURN_COTURN_URLS`                                    | 없음                    | 쉼표로 구분한 coturn 주소       |
| `TURN_COTURN_SECRET`                                  | 없음                    | coturn 공유키(서버 전용)        |
| `TURN_CREDENTIAL_TTL_SECONDS`                         | `600`                   | TURN 자격 증명 수명(초)         |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`           | `600`                   | IP별 발급 제한 구간(초)         |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`             | `12`                    | 구간당 IP별 최대 발급 시도 수   |
| `TURN_CREDENTIAL_RATE_LIMIT_PARTICIPANT_MAX_REQUESTS` | `6`                     | BATON 참가자·방별 발급 시도 수  |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS`      | `24`                    | 구간당 서버 전체 발급 시도 수   |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`              | `10000`                 | 발급 제한 상태의 최대 IP 수     |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_PARTICIPANTS`         | `10000`                 | BATON 참가자 상태 최대 수       |
| `COMPOSE_PROFILES`                                    | `none`                  | `observability`이면 Alloy 실행  |
| `GRAFANA_ALLOY_IMAGE`                                 | Alloy 1.18.1 digest     | digest로 고정한 Alloy 이미지    |
| `GRAFANA_CLOUD_PROMETHEUS_URL`                        | 없음                    | 메트릭 원격 전송 URL            |
| `GRAFANA_CLOUD_PROMETHEUS_USER`                       | 없음                    | 메트릭 인스턴스 사용자 ID       |
| `GRAFANA_CLOUD_API_TOKEN`                             | 없음                    | `metrics:write` 전용 토큰       |

프레임 수와 수신 바이트 제한은 세션, IP 합산, 서버 전체 순서로 함께 적용됩니다. 세션
초과 연결은 닫고 IP 또는 서버 전체 제한을 넘은 프레임은 다른 클라이언트에 영향을 주지
않도록 버립니다. IP 합산 제한은 세션 제한 이상이어야 하고, 서버 전체 제한은 고정
집계 구간의 시작 시점 차이를 고려해 IP 합산 제한의 두 배 이상이어야 합니다. 미입장 연결 검사
주기는 100~1,000ms 범위이며 미입장 종료 기한을 넘을 수 없습니다. 송신 큐는 참가자별
프레임·바이트 제한과 서버 전체 64MiB 바이트 제한을 함께 적용합니다. TURN 발급 제한도
서버 전체 한도에 같은 규칙을 적용합니다.
마지막 연결이 끊겨도 IP별 수신량은 현재 집계 구간이 끝날 때까지 유지되므로 같은
IP에서 재연결해도 한도가 초기화되지 않습니다. 만료된 비활성 상태는 새 연결을 받거나
주기 검사를 할 때 정리합니다. 상태 맵이 가득 차면 활성 상태를 보존하고 비활성 상태만 제거합니다.

독립 실행 방장 기능을 켤 때는 HTTP 기본 인증 비밀번호와 다른 최소 32자의 무작위 키를 만들고
서버에는 그 SHA-256 해시만 저장합니다. 하나의 키가 해당 독립 실행 서버의 모든 방에
적용되므로 원문 키는 방장에게만 전달하고 유출 시 즉시 교체해야 합니다. 참가자 화면에는
원문이 저장되거나 다시 표시되지 않으며, 빈 값은 일반 참가자 입장입니다.

BATON 모드에서는 연결을 맺는 중이거나 연결된 WebSocket을 합쳐 동일 참여권 `jti`당 1개,
동일 `(room_id, sub)`당 2개까지만 허용합니다. 두 번째 연결은 BATON이 새 `jti`로
발급한 참여권으로 재연결할 때 기존 연결과 잠시 겹치는 경우를 위한 것입니다. 세 번째 연결은 기존 연결을 끊지 않고 HTTP 429로
거절합니다. 이 제한은 독립 실행 모드에는 적용되지 않습니다.

TURN 발급 횟수의 기본 집계 구간은 자격 증명 수명(TTL)과 같은 600초입니다. IP당 12회는 같은 NAT 뒤의
6명 참가자가 최초 발급 후 8분경 한 번씩 자동 갱신할 수 있게 하고 서버 전체는 24회로
제한합니다. TTL이나 브라우저 갱신 시점을 변경하면 발급 구간과 한도도 함께 검토해야
합니다. BATON 모드는 같은 구간에 `(room_id, sub)`당 6회의 발급 한도도 함께 적용하며,
새 `jti` 발급이나 접속 IP 변경으로 초기화되지 않습니다. 참가자·IP·서버 전체 제한은 모두
통과할 때만 한 번에 차감됩니다. 독립 실행 모드는 참가자별 발급 한도를 적용하지 않습니다.
운영 Compose의 Caddy는 공유 접근 자격을 요구해 익명 요청을 차단하지만, 이를 알고 있는
사용자를 서로 구분하거나 스터디 멤버십까지 확인하지는 않습니다. BATON에서도 IP·전역
발급 한도와 Cloudflare 사용량 경보는 계정 탈취와 TURN 중계 자원 남용을 제한하기 위해 계속
유지합니다.

## 저장소 구조

```text
apps/
  web/          React + Vite 화면
  signaling/    Java 21 + Spring Boot WebSocket 시그널링 서버
packages/
  protocol/     클라이언트/서버 공유 메시지 계약
  rtc-core/     React에 의존하지 않는 WebRTC 엔진
```

자세한 설계 의도는 [docs/architecture.md](docs/architecture.md)에 정리되어 있습니다.

## 실제 배포 전 알아둘 점

카메라와 마이크는 `localhost`를 제외하면 HTTPS에서만 사용할 수 있습니다. 외부 스터디원과
사용하려면 웹은 HTTPS, 시그널링은 WSS로 배포해야 합니다.

기본 STUN 설정만으로는 회사·학교망이나 제한적인 NAT 환경에서 연결을 보장할 수 없습니다.
실사용 배포에는 TURN 서비스가 필요합니다. ROUND는 coturn의 임시 자격 증명을 발급하거나
Cloudflare API에서 받아 브라우저에 전달합니다. 공유키와 API 토큰은 브라우저 번들에 넣지 않습니다.
메시 방식은 참가자마다
업로드 스트림 수가 늘어나므로 영상은 기본 640×360, 최대 15fps이며 첫 버전은 6명으로
제한합니다.

운영 배포에는 Caddy와 Java 시그널링 서버 1대를 포함한 Compose 구성이 준비되어
있습니다. TURN은 자체 coturn 또는 Cloudflare를 선택합니다. 웹 앱·WebSocket·TURN 자격 증명 API는
Caddy의 HTTPS 공유 인증 뒤에 두고, `/healthz`만 공개합니다. 서버 준비, 접근 비밀번호 해시, DNS,
방화벽, Cloudflare 키, TURN 중계 전용 검증과 롤백 절차는 [배포 가이드](docs/deployment.md)를
따르세요. 스터디 그룹에 공개하기 전에는 [파일럿 체크리스트](docs/pilot-checklist.md)를
모두 통과해야 합니다.

추가 과금 없는 홈서버 연동과 `b4ton.com` 서브도메인 관련 조건은
[홈서버 연동 검토](docs/home-server-integrations.md)에 정리했습니다.

## BATON 연동과 역할

ROUND는 BATON과 별도 저장소에서 개발하고 독립적으로 배포·실행합니다. BATON은 사용자, 스터디와
참여 권한을 관리하고, ROUND는 메모리에 보관하는 방·참가자 상태, WebSocket 시그널링과 TURN 자격
증명 발급을 담당합니다. 두 서비스는 데이터베이스를 공유하지 않으며 시그널링 프레임마다
서로를 호출하지 않습니다.

브라우저가 사용하는 동일 출처 경로는 다음 세 개입니다.

| 목적               | 공개 경로                                           | 처리 주체 |
| ------------------ | --------------------------------------------------- | --------- |
| 참여권 갱신        | `/round/rooms/{roomId}/participation-grant/refresh` | BATON     |
| WebSocket 시그널링 | `/round/rooms/{roomId}/signal`                      | ROUND     |
| TURN 자격 증명     | `/round/rooms/{roomId}/turn-credentials`            | ROUND     |

BATON은 현재 스터디 참여 권한을 확인해 해당 방에서만 쓸 수 있는 단기 RS256 참여권 쿠키를 발급합니다.
ROUND는 공개 JWK로 참여권 서명과 요청한 방 ID를 검증합니다. BATON 모드에서 검증에 실패하거나
필수 설정이 누락되면 요청을 거부하며 독립 실행 모드로 전환하지 않습니다. 참여권의 `sub`는 로그인 공급자 정보가 아닌 재할당되지
않는 BATON `Account.id`입니다.

BATON 웹은 방 권한을 확인하기 전 입장 화면과 장치 권한 요청을 열지 않습니다. 활성 연결은
참여권 만료, 같은 계정의 새 연결로 교체, TURN 갱신 실패를 각각 정해진 종료·재시도 정책으로
처리합니다. 상세 JWT 클레임, 쿠키, JWK 교체, 갱신 응답, 연결 승인과 배포 순서는
[BATON 연동 계약 원본인 ADR 0001](docs/adr/0001-round-independent-service.md)을 따릅니다.
실제 배포 전 확인 항목은 [파일럿 체크리스트](docs/pilot-checklist.md)의 BATON 연동 필수 검사를
사용합니다.
