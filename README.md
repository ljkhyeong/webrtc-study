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
- WebRTC DataChannel 기반 휘발성 텍스트 채팅
- 참가자 입장·퇴장과 연결 상태 표시
- 한쪽 미디어 권한만 허용해도 음성 전용 또는 영상 전용으로 입장
- 일시적인 signaling·ICE 연결 장애 자동 복구
- 데스크톱과 모바일 반응형 화면

계정, 녹화, 화면 공유, 채팅 저장, 관리자 기능은 아직 포함하지 않습니다.

## 로컬 실행

필요한 도구:

- Node.js 22 이상
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

## 환경 변수

| 변수                                             | 기본값                  | 설명                          |
| ------------------------------------------------ | ----------------------- | ----------------------------- |
| `PORT`                                           | `8787`                  | signaling HTTP/WebSocket 포트 |
| `HOST`                                           | `0.0.0.0`               | signaling bind 주소           |
| `ALLOWED_ORIGINS`                                | `http://localhost:5173` | 쉼표로 구분한 허용 Origin     |
| `MAX_ROOM_SIZE`                                  | `6`                     | 방 최대 참가자 수             |
| `MAX_SIGNALING_CONNECTIONS_PER_CLIENT`           | `12`                    | IP별 동시 signaling 연결 제한 |
| `HEARTBEAT_INTERVAL_MS`                          | `30000`                 | 연결 상태 확인 주기(ms)       |
| `VITE_SIGNALING_URL`                             | 현재 호스트의 `/signal` | 브라우저가 연결할 WSS/WS 주소 |
| `VITE_STUN_URLS`                                 | Google 공개 STUN 2개    | 쉼표로 구분한 STUN 주소       |
| `VITE_TURN_CREDENTIALS_URL`                      | `/api/turn-credentials` | 만료형 TURN credential API    |
| `VITE_ICE_TRANSPORT_POLICY`                      | `all`                   | `relay`이면 TURN만 강제       |
| `TURN_URLS`                                      | 없음                    | 서버가 브라우저에 전달할 TURN |
| `TURN_SHARED_SECRET`                             | 없음                    | signaling과 coturn 공유 비밀  |
| `TURN_CREDENTIAL_TTL_SECONDS`                    | `600`                   | TURN credential 수명(초)      |
| `TURN_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`      | `60`                    | IP별 발급 제한 구간(초)       |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS`        | `12`                    | 구간당 IP별 최대 발급 수      |
| `TURN_CREDENTIAL_RATE_LIMIT_GLOBAL_MAX_REQUESTS` | `8`                     | 구간당 서버 전체 최대 발급 수 |
| `TURN_CREDENTIAL_RATE_LIMIT_MAX_CLIENTS`         | `10000`                 | rate-limit 상태 최대 IP 수    |

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
실사용 배포에는 coturn 같은 TURN 서버가 필요합니다. ROUND는 TURN shared secret을 브라우저
번들에 넣지 않고 Java 서버가 짧은 수명의 credential을 발급합니다. mesh 방식은 참가자마다
업로드 스트림 수가 늘어나므로 영상은 기본 640×360, 최대 15fps이며 첫 버전은 6명으로
제한합니다.

운영 배포에는 Caddy, 단일 Java signaling 인스턴스, coturn을 포함한 Compose 구성이
준비되어 있습니다. 서버 준비, DNS, 방화벽, 인증서, relay-only 검증과 롤백 절차는
[배포 가이드](docs/deployment.md)를 따르세요. 스터디 그룹에 공개하기 전에는
[파일럿 체크리스트](docs/pilot-checklist.md)를 모두 통과해야 합니다.

## BATON 통합 방향

`@round/rtc-core`는 React, 라우터, CSS 프레임워크를 import하지 않습니다. Java signaling
코드도 `com.personal.round.signaling` 아래에 격리되어 있습니다. 이후 BATON에서는
WebRTC 코어를 `features/meeting` 어댑터에서 감싸고, signaling 패키지를 BATON의 inbound
adapter로 옮긴 뒤 방 접근 권한만 BATON 인증 모델에 맞춰 연결할 수 있습니다.

BATON의 현재 Caddy 설정은 `Permissions-Policy`에서 카메라와 마이크를 차단하고 있으므로
통합 시 해당 헤더와 WebSocket `connect-src` 정책을 함께 조정해야 합니다.
