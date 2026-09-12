# API 연동과 빌드 준비

확인일: 2026-09-12. ROUND `583aeb5`와 로컬 BATON `d768625`의 참여권 API·런타임 계약을 대조했다.
이번 범위는 연동 코드, 애플리케이션 설정, 빌드다. 홈서버·공유기·DNS·인증서·k3s 설정과
컨테이너 이미지 빌드는 운영자가 진행한다.

## 사용할 연동

| 기능                    | 연결 대상                   | 준비 상태                                                             |
| ----------------------- | --------------------------- | --------------------------------------------------------------------- |
| 로그인·스터디 참여 권한 | BATON 참여권 API와 공개 JWK | 기존 API 사용. ROUND는 Spring Security·Nimbus로 서명을 검증           |
| 통화 중계               | 홈서버 coturn               | 기존 임시 자격 증명 발급 사용. BATON의 설정명과 Secret 파일 호환 보완 |
| 장애·복구 알림          | Alertmanager → Discord 웹훅 | 기존 기본 연동 사용. 실제 웹훅 URL은 아직 미설정                      |
| 브라우저 오류 수집      | Grafana Faro                | 기존 SDK 사용. 수집 URL이 비어 있으면 전송하지 않음                   |

coturn의 [TURN REST 인증](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)과
Alertmanager의 [Discord 연동](https://prometheus.io/docs/alerting/latest/configuration/#discord_config)을
사용하므로 중계 서버나 알림 재시도 코드를 ROUND에 추가하지 않는다. 사용량 과금이 있는
회의 SDK로 전환하지 않는다. Faro는 기존 안내대로 무료 플랜을 확인한 경우에만 활성화한다.
일정·공휴일 API는 BATON/CAL의 기능이며 ROUND 타이머를 대체하지 않는다.

## 수정한 계약 불일치

- BATON은 `TURN_URLS`와 `round.turn.shared-secret` 파일을 전달하지만 ROUND는 다른 설정명을
  사용하고 있었다. `production` 프로필에서 두 이름을 읽도록 연결했다. 새 `TURN_COTURN_URLS`와
  `TURN_COTURN_SECRET`을 명시하면 새 값이 우선한다. 빈 값을 명시해도 기존 값으로 대체하지 않는다.
- `production`의 기본값을 BATON 인증과 coturn으로 정했다. 필수값이 없으면 기존 검증으로
  시작에 실패한다. 독립 실행·TURN 비활성은 명시적으로 선택할 수 있다. 로컬 기본값은 유지한다.
- BATON 상태 검사가 읽는 `/srv/.round-auth-mode`를 실제 웹 빌드 모드에 맞춰 생성한다.
  BATON 이미지는 `baton`, 독립 실행 빌드는 `standalone`을 기록한다.

## 중계 API 요청 제한 처리

통화 중 중계 정보 갱신이 `429`로 거절되면 서버가 반환한 초 단위 `Retry-After`를 다음 요청에
반영한다. 서버가 120초를 지정했는데 30초마다 재요청하던 동작을 수정했다. 최소 대기는 30초이며,
대기 시간 누락·잘못된 값·일반 오류는 기존 30초 재시도를 유지한다. 통화는 유지하고 퇴장 시
재시도를 취소한다. 새 환경변수나 운영 설정은 필요하지 않다.
[HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

## 빌드

```bash
cp .env.baton.example .env.baton.local
npm run build:baton
```

Java 21, Node.js와 npm 의존성이 준비된 저장소에서 실행한다. 프로토콜·RTC 패키지, 서버 JAR,
BATON 웹을 빌드한다. 웹만 다시 빌드하려면 `npm run build:web:baton`을 사용한다.
BATON 모드와 동일 출처 API 경로는 명령이 고정하므로 로컬 `.env`의 독립 실행 설정이 섞이지 않는다.
`.env.baton.local`은 Git과 이미지 빌드 컨텍스트에서 제외한다.

산출물은 `apps/web/dist/`와 `apps/signaling/build/libs/signaling-*.jar`다.
직접 컨테이너 이미지를 만들 때는 기존 Dockerfile의 `baton-web-runtime`, `signaling-runtime`
대상을 사용한다. 웹의 공개 설정은 Docker 빌드 인자 `VITE_STUN_URLS`,
`VITE_ICE_TRANSPORT_POLICY`, `VITE_FARO_COLLECTOR_URL`로 전달한다.
서버 비밀값은 이미지에 넣지 않고 실행 시 전달한다.

## 환경변수·웹훅 인계

- 웹 빌드: [.env.baton.example](../.env.baton.example). 기본 오류 수집은 비활성이다.
- 시그널링 실행: [ops/baton.env.example](../ops/baton.env.example). 실제 JWK 경로는 BATON
  `/.well-known/round-participation-jwks.json`과 맞췄다. `TURN_COTURN_SECRET`을 실제 coturn 공유키로 채운다.
  파일로 전달할 때의 Spring `configtree` 설정도 같은 예시에 있다.
  파일 읽기는 [Spring Boot의 외부 설정 기능](https://docs.spring.io/spring-boot/reference/features/external-config.html#features.external-config.files.configtree)을 사용한다.
- Discord: 기존 [alertmanager-discord.yml](../ops/observability/alertmanager-discord.yml)이
  `/run/secrets/round-discord-webhook` 파일을 읽는다. 실제 URL을 채팅·이미지·Git에 넣지 않는다.
  알림 대상은 현재 비활성이며 활성화·네트워크 연결은 운영자가 맡는다.

이번 작업의 `output/runtime/signaling.env`는 로컬 검증 전용 임시 공유키를 담는다.
운영에 재사용하지 않는다. 실제 BATON 서명키, coturn 공유키, Discord 웹훅과 Faro 수집 URL은
발급하거나 변경하지 않았다.

## 공개 주소 계약

현재 로그인·참여권 쿠키는 `b4ton.com`의 호스트 전용 쿠키다. 따라서 통화의 공개 주소는
`https://b4ton.com/room/{roomId}`를 사용하고 `round.b4ton.com/room/{roomId}`는 이 주소로
연결해야 한다. 서비스·컨테이너는 별도로 실행할 수 있다.

| 공개 경로                                                                      | 연결 대상                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `/room/{roomId}`, `/round-ui/*`                                                | ROUND 웹, 경로 유지                                   |
| `/round/rooms/{roomId}/signal`                                                 | ROUND 시그널링 `/rooms/{roomId}/signal`               |
| `/round/rooms/{roomId}/turn-credentials`                                       | ROUND 시그널링 `/api/rooms/{roomId}/turn-credentials` |
| `/round/rooms/{roomId}/participation-grant/refresh`                            | BATON, 경로 유지                                      |
| `/api/v1/auth/session`, `/login`, `/.well-known/round-participation-jwks.json` | BATON                                                 |

이 경로 연결과 `round.b4ton.com`의 이동 처리는 운영자가 구성할 프록시의 계약이다.
주소창까지 `round.b4ton.com`으로 유지하려면 BATON의 별도 로그인 교환 API가 필요하다.
현재 코드에는 이 API가 없으며 쿠키 Domain 확장으로 대신하지 않는다.
상세 인증 규칙은 [ADR 0001](adr/0001-round-independent-service.md)을 따른다.

## 확인 범위

`npm run build:baton`으로 BATON 웹·서버 JAR 빌드를 통과했다. 웹 설정 관련 테스트 20개와
Spring 설정·Secret 파일 읽기·coturn 발급·아키텍처 테스트 29개를 통과했다.
산출물의 BATON 표식·정적 경로를 확인했고, 실제 JAR에 임시 환경 파일을 넣어 준비 상태 200과
미인증 TURN 요청 401을 확인한 뒤 종료했다.

Discord·모니터링 설정은 이전 검증 리비전 `d111196` 이후 변경이 없어 공식 도구 검사와
모의 장애·복구 전송 결과를 재사용했다. 실제 외부 계정 호출이나 운영 웹훅 전송은 포함하지 않는다.
배포 후에는 실제 BATON 로그인·공개키 조회, 서로 다른 외부망의 두 참가자 TURN 통화와
실제 장애·복구 알림을 확인해야 한다. 로컬 빌드 성공으로 이 결과까지 보장하지 않는다.
