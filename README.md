# ROUND

시간 제한 없이 소규모 스터디원이 영상, 음성, 채팅으로 만나는 개인용 WebRTC
스터디룸입니다.

ROUND의 첫 버전은 최대 6명이 브라우저끼리 직접 연결되는 mesh 구조입니다. signaling
서버는 참가자를 찾아주고 연결 정보를 전달할 뿐, 영상과 음성을 저장하거나 중계하지
않습니다.

## MVP 기능

- 읽기 쉬운 방 코드와 공유 가능한 초대 링크
- 카메라·마이크 기반 다자간 WebRTC 통화
- 마이크 음소거와 카메라 켜기/끄기
- WebRTC DataChannel 기반 휘발성 텍스트 채팅
- 참가자 입장·퇴장과 연결 상태 표시
- 카메라/마이크 권한 거부 시 미디어 없이 입장
- 데스크톱과 모바일 반응형 화면

계정, 녹화, 화면 공유, 채팅 저장, 관리자 기능은 아직 포함하지 않습니다.

## 로컬 실행

필요한 도구:

- Node.js 22 이상
- npm 11 이상

```bash
npm install
cp .env.example .env
npm run dev
```

브라우저에서 [http://localhost:5173](http://localhost:5173)을 엽니다. 서로 다른 브라우저
프로필이나 시크릿 창을 함께 열면 2명 입장을 로컬에서 확인할 수 있습니다.

전체 검증:

```bash
npm run check
```

## 환경 변수

| 변수                   | 기본값                  | 설명                          |
| ---------------------- | ----------------------- | ----------------------------- |
| `PORT`                 | `8787`                  | signaling HTTP/WebSocket 포트 |
| `HOST`                 | `0.0.0.0`               | signaling bind 주소           |
| `ALLOWED_ORIGINS`      | `http://localhost:5173` | 쉼표로 구분한 허용 Origin     |
| `MAX_ROOM_SIZE`        | `6`                     | 방 최대 참가자 수             |
| `VITE_SIGNALING_URL`   | 현재 호스트의 `/signal` | 브라우저가 연결할 WSS/WS 주소 |
| `VITE_STUN_URLS`       | Google 공개 STUN 2개    | 쉼표로 구분한 STUN 주소       |
| `VITE_TURN_URL`        | 없음                    | 운영용 TURN 주소              |
| `VITE_TURN_USERNAME`   | 없음                    | TURN 사용자 이름              |
| `VITE_TURN_CREDENTIAL` | 없음                    | TURN credential               |

## 저장소 구조

```text
apps/
  web/          React + Vite 화면
  signaling/    Node.js WebSocket signaling 서버
packages/
  protocol/     클라이언트/서버 공유 메시지 계약
  rtc-core/     React에 의존하지 않는 WebRTC 엔진
```

자세한 설계 의도는 [docs/architecture.md](docs/architecture.md)에 정리되어 있습니다.

## 실제 배포 전 알아둘 점

카메라와 마이크는 `localhost`를 제외하면 HTTPS에서만 사용할 수 있습니다. 외부 스터디원과
사용하려면 웹은 HTTPS, signaling은 WSS로 배포해야 합니다.

기본 STUN 설정만으로는 회사·학교망이나 제한적인 NAT 환경에서 연결을 보장할 수 없습니다.
실사용 배포에는 coturn 같은 TURN 서버를 연결하는 것을 권장합니다. mesh 방식은 참가자마다
업로드 스트림 수가 늘어나므로 첫 버전은 6명으로 제한합니다.

## BATON 통합 방향

`@round/rtc-core`는 React, 라우터, CSS 프레임워크를 import하지 않습니다. 이후 BATON에서는
이 패키지를 `features/meeting` 어댑터에서 감싸고, 방 접근 권한만 BATON의 인증 모델에 맞춰
연결할 수 있습니다.

BATON의 현재 Caddy 설정은 `Permissions-Policy`에서 카메라와 마이크를 차단하고 있으므로
통합 시 해당 헤더와 WebSocket `connect-src` 정책을 함께 조정해야 합니다.
