# ROUND 아키텍처

ROUND는 의도적으로 네 컴포넌트로 분리되어 있으며 BATON과 독립적으로 배포할 수 있습니다.
BATON은 signaling 런타임을 흡수하는 대신 인증된 서비스 경계를 통해 연동합니다.

```text
apps/web          React room UI
apps/signaling    Java 21 + Spring Boot raw WebSocket signaling server
packages/protocol Shared, versioned signaling and peer DataChannel wire contracts
packages/rtc-core Framework-free WebRTC room engine
```

## MVP 토폴로지

각 참가자는 원격 참가자마다 하나의 `RTCPeerConnection`을 엽니다. 오디오, 영상, 채팅
데이터는 브라우저 사이를 직접 이동합니다. signaling 서버는 피어가 서로를 찾도록 돕고
SDP/ICE 메시지를 전달하는 역할만 합니다. 직접 경로를 사용할 수 없으면 coturn이 암호화된
WebRTC 패킷을 중계하며, 그 미디어 내용을 Java 애플리케이션에 노출하지 않습니다.

이 mesh 토폴로지는 첫 버전을 저렴하게 자체 호스팅할 수 있게 합니다. 피어가 늘어날수록
업로드 대역폭과 CPU 사용량이 증가하므로 의도적으로 참가자를 6명으로 제한합니다.

## 이식성 경계

- `@round/rtc-core`는 React, router, CSS framework를 import하지 않습니다.
- `@round/protocol`은 브라우저 측 wire-message 타입과 runtime validation을 소유합니다.
- `apps/signaling`은 WebSocket 경계에서 protocol v3 validation을 동일하게 수행하고
  `com.personal.round.signaling` 아래의 메모리에 방 상태를 보관합니다.
- `apps/web`은 방 snapshot을 React에 맞게 변환하고 모든 화면 표시를 소유합니다.
- 방 식별자는 불투명한 문자열입니다. BATON은 peer engine을 변경하지 않고 참여권을 발급하기
  전에 해당 방을 승인합니다.

## DataChannel 전달 경계

`@round/protocol`은 브라우저 사이의 `chat.message`, `chat.ack`, `participant.media` frame도
소유합니다. 채팅은 휘발성 peer-to-peer 데이터로 유지됩니다. Java signaling 서비스는 이
frame을 검사, 중계, 확인 응답 또는 저장하지 않습니다.

로컬 메시지는 대상인 모든 피어의 현재 `RoomSession`이 메시지를 검증·기록하고
`chat.ack`를 반환할 때까지 `pending`으로 남습니다. 이 확인 응답은 애플리케이션이
수락했다는 뜻이지, 사람이 메시지를 읽었다는 뜻은 아닙니다. 모든 대상의 확인 응답을 받으면
`sent`, 확인된 응답과 복구 불가능한 피어 실패가 함께 있으면 `partial`, 확인된 수신자가
없으면 `failed`가 됩니다. 중복 재전송은 `(peerId, messageId)`로 중복 제거하지만 다시 확인
응답하므로, channel 복구 중 유실된 ACK가 채팅을 두 번 표시하지 않고도 최종 상태에
수렴할 수 있습니다.

각 피어는 확인되지 않은 채팅 frame을 최대 50개까지 보유할 수 있으며, 이에 대응하는
byte 상한과 절대 45초의 전달 기한이 적용됩니다. 브라우저는 DataChannel 송신 buffer가
256 KiB를 넘기 전에 일반 채팅을 일시 중지하고, 64 KiB에서 `bufferedamountlow`가 발생한
뒤 재개합니다. 개수가 제한된 ACK 제어 frame은 병합된 최신 미디어 상태와 대기 중인 채팅보다
먼저 전송합니다.

`chat.ack`는 기존에 추가된 peer protocol frame이며 Java signaling protocol version을
변경하지 않습니다. ROUND는 현재 이 기능을 협상하지 않고 web client를 원자적으로
배포합니다. pilot 참가자는 web release 후 모두 새로고침해야 합니다. ACK를 구현하지 않은
오래된 client는 채팅을 표시할 수 있지만, 새 발신자는 성공으로 잘못 보고하지 않고 45초
기한 뒤 수신 확인 실패로 안전하게 실패합니다.

## 미디어 소스와 관리 경계

`RoomSession`은 한 번에 하나의 발신 영상 소스를 소유합니다. 화면 공유를 시작하면 display
track을 얻어 모든 기존 `RTCRtpSender`의 camera track을 교체합니다. 화면 공유를 중지하거나
브라우저의 기본 **공유 중지** 동작을 실행하면 보관해 둔 camera track을 복원합니다. 오디오는
microphone track에 그대로 남습니다. display capture가 활성화된 동안에는 camera 전환을
비활성화해 하나의 제어가 숨겨진 소스를 실수로 변경하지 않게 합니다. 새 피어는 현재 선택된
소스를 수신하며, peer-to-peer `participant.media` frame은 그 소스가 `camera`인지
`screen`인지 전달합니다.

미디어 관리는 의도적으로 비활성화만 허용합니다. Signaling protocol v3는 입장이 승인된 각
피어에 서버가 판정한 `host|participant` role을 부여합니다. host는 서버에 같은 방의 다른
참가자 오디오나 영상을 끄도록 요청할 수 있습니다. 서버는 자신이 소유한 명령을 보내기 전에
행위자, 대상, 방, role을 검증합니다. 참가자는 장치를 명시적으로 다시 켤 수 있지만, 원격
사용자는 microphone, camera, screen capture를 켤 수 없습니다. standalone 모드에서는
선택적인 host key를 `ROUND_STANDALONE_HOST_TOKEN_SHA256`과 대조해 검증하고 판정한 role만
보관합니다. BATON 모드에서는 검증된 참여권의 `role`이 권위 있는 값이며 standalone key는
거부합니다.

이 제어는 신뢰하는 소규모 스터디 mesh pilot에는 적합하지만 악의적인 client를 강제하는
수단은 아닙니다. 미디어 패킷이 피어 사이를 직접 이동하므로 변조된 브라우저는 비활성화 명령을
무시할 수 있습니다. 강제 퇴장이나 지속적인 서버 측 미디어 잠금을 구현하려면 kick/ban 정책
또는 미디어 전달을 소유하는 SFU가 필요합니다.

## 식별과 권한 부여 경계

BATON은 사용자, 스터디, 일정과 사용자의 스터디룸 입장 허용 결정을 소유합니다. ROUND는
휘발성 방·피어 상태, raw WebSocket signaling, TURN credential 발급만 소유합니다. ROUND는
BATON의 database나 entity를 공유하지 않고 signaling frame마다 BATON을 동기 호출하지
않습니다.

BATON은 멤버십을 확인한 뒤 `RS256`으로 서명한 수명이 짧은 JWT 참여권을 발급하며, JOSE
header에는 공개키 `kid`가 포함됩니다. BATON은 발급에 사용할 key를 전환하기 전에 새
공개키를 JWK Set에 추가하고, 기존 참여권의 수명과 clock skew가 지날 때까지 이전 key를
유지합니다. 참여권은 `HttpOnly`, `Secure`, `SameSite=Strict` cookie로 전달합니다. 여러 방의
참여권이 충돌하지 않도록 cookie path를 `/round/rooms/{roomId}`로 제한합니다. 필수 claim은
`iss`, `aud=round`, `sub`, `exp`, `iat`, `jti`, `room_id`, `study_id`,
`role=host|participant`입니다.

`sub`는 재할당되지 않는 정규 BATON `Account.id` UUID입니다. Google OIDC subject, Naver
profile ID, email 주소, display name, 공유 workspace key를 사용하지 않습니다. 따라서 기존
BATON account에 다른 login identity를 연결해도 provider나 profile claim을 ROUND에 노출하지
않고 동일한 ROUND 참가자와 TURN quota identity를 유지합니다.

브라우저와 내부 routing 계약은 다음과 같습니다.

| 목적               | 공개 same-origin 경로                               | 처리 경계                              |
| ------------------ | --------------------------------------------------- | -------------------------------------- |
| 참여권 갱신        | `/round/rooms/{roomId}/participation-grant/refresh` | BATON 소유, ROUND로 proxy하지 않음     |
| WebSocket 시그널링 | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`               |
| TURN 자격 증명     | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials` |

ROUND는 `RS256`만 허용하며 BATON의 JWK Set을 사용해 서명, issuer, audience, 만료, 모든 필수
claim을 로컬에서 검증합니다. audience 목록에는 설정한 값(기본 `round`)이 정확히 하나만
있어야 하며 다른 audience가 추가되면 거부합니다. ROUND는 가져온 JWK Set을 JVM cache에
60초 동안 보관하고, 형식이 올바르지만 cache에 없는 `kid`를 만나면 갱신합니다. cold load와
cache-miss 재시도를 허용하기 위해 Nimbus source는 JVM마다 30초 window에서 최대 두 번의
외부 source 접근 burst를 허용합니다. rate limit이 적용된 unknown key는 JWK를 다시 가져오지
않고 HTTP 401로 실패합니다. 형식이 잘못되거나 만료되었거나 검증할 수 없는 token도 HTTP
401을 유지합니다. 실제 JWK source 또는 검증 infrastructure 장애에는 비어 있고 no-store인
HTTP 503을 반환해 client와 metric이 서버 가용성 문제를 잘못된 credential로 오분류하지
않게 합니다.
따라서 BATON은 발급을 새 `kid`로 전환하기 전에 cache TTL보다 오랫동안 새 공개키를 미리
게시해야 합니다.
기본 참여권 최대 수명은 5분이며, 미래 `iat`에는 60초의 clock skew만 허용합니다. 서명과
`exp`가 다른 면에서 유효해도 더 긴 참여권은 거부합니다. WebSocket upgrade와 TURN
요청에서는 path의 `roomId`가 `room_id`와 일치해야 합니다. 검증된 참여권은 WebSocket
session으로 전달되며, 방 입장 전에 `room.join`이 path와 claim 모두에 일치해야 합니다.
BATON 모드는 ticket이나 verifier 설정이 없거나 잘못되면 안전하게 실패합니다. Standalone
모드는 소규모 pilot을 위한 기존의 거친 공유 edge credential을 유지합니다.

연결된 socket은 handshake에 사용한 참여권에서 얻은 불변 lease를 유지합니다. ROUND는 연결
시점, 수신 quota 사용과 송신 enqueue 전, heartbeat 중, 1초 주기의 sweep에서 lease를
검사합니다. 만료된 socket은 `4001 / Participation grant expired`로 닫습니다. wall-clock
`exp`와 연결 시점의 monotonic deadline을 함께 적용하므로 system clock을 과거로 돌려도
lease가 연장되지 않습니다. 일반적인 멱등 disconnect 경로는 방, 입장 reservation, 송신
queue, gauge를 정확히 한 번 해제합니다. HTTP JWT decoder는 동일하게 주입된 clock과 0의
expiry skew를 사용하며, 참여권 전용 미래 `iat` 허용 범위는 60초로 유지합니다. Standalone
접근에는 lease deadline이 없습니다.

BATON connection admission은 진행 중인 handshake와 연결된 socket을 모두 계산합니다. 같은
참여권 `jti`는 하나의 reservation만 소유할 수 있고, 같은 `(room_id, sub)`는 두 개의
reservation을 소유할 수 있어 새로 발급한 참여권을 사용하는 reconnect가 기존 socket과 잠시
겹칠 수 있습니다. 같은 참여권을 replay하거나 세 번째 participant-room 연결을 시도하면
handshake admission 중 연결된 socket을 내보내지 않고 HTTP 429를 반환합니다. 같은 참가자의
승인된 socket 두 개가 `room.join`을 시도하면 동일한 방 상태 lock 아래에서 connection
sequence가 더 큰 쪽이 이깁니다. ROUND는 새 피어를 승인하기 전에 이전 피어를 제거하고 진
socket을 `4002 / Participation session superseded`로 닫습니다. 브라우저는 이 정책에 따른
종료를 reconnect하지 않는 terminal 상태로 처리합니다. 따라서 6명 제한에서도 방에는 BATON
참가자마다 최대 하나의 피어만 존재합니다. 진 socket의 admission reservation은 terminal
close 시도가 끝날 때까지 유지되어 close가 막힌 동안 세 번째 연결이 들어오는 것을 방지하고,
close가 I/O 실패를 보고해도 정확히 한 번 해제됩니다. 다른 reservation은 방 멤버십 기간뿐
아니라 socket 전체 수명 동안 유지되므로 `room.leave`로 제한을 우회할 수 없습니다.
Standalone 모드는 영향을 받지 않습니다.

signaling 서비스는 계속 peer ID를 소유하고 wire-level 발신자 identity를 덮어쓰며, 현재 같은
방에 있는 피어 사이에서만 SDP/ICE를 중계해야 합니다. ROUND는 HTTP upgrade 뒤 raw
WebSocket frame을 사용하므로 일반 MVC interceptor, argument resolver, STOMP message rule로
이 검사를 대체할 수 없습니다.

## 프로덕션 경계

`localhost`에서는 TLS 없이 camera, microphone, screen capture를 사용할 수 있습니다. 배포된
환경에서는 HTTPS/WSS를 사용하고 `Permissions-Policy`에서 camera, microphone과 함께
`display-capture`를 허용해야 합니다. 제한적인 NAT 또는 회사 네트워크 뒤의 사용자를 위해
프로덕션 배포에는 TURN 서비스도 필요합니다. STUN만으로 연결을 보장할 수 없습니다.

Caddy는 유일한 공개 HTTP 진입점입니다. standalone 모드에서는 정적 브라우저 build,
`/signal`, `/api/turn-credentials`에 공유 접근 credential을 요구하고, proxy하기 전에
Authorization header를 제거하며, 가용성 검사에는 `/healthz`만 공개합니다. BATON 모드에서는
same-origin edge가 위의 방 범위 공개 경로를 ROUND에 연결하고, Spring Security가 signaling과
TURN 작업 전에 참여 cookie를 검증합니다. 참여권 갱신 경로는 BATON에 남아 현재 identity와
membership을 다시 확인합니다.
BATON이 소유한 Vite build는 `VITE_ROUND_AUTH_MODE=baton`을 사용합니다. 브라우저는 동일한
정규 room ID에서 세 경로를 모두 파생하고 endpoint override를 거부하므로 실수로 standalone
transport 경계로 돌아갈 수 없습니다.

방 상태, 참여 connection reservation, TURN 발급 window는 메모리에 있습니다. 따라서 공유
방·admission·quota registry, room routing, cross-node relay를 도입하기 전에 signaling replica를
여러 개 실행하면 하나의 논리적 방이 나뉘고 각 process가 참가자 제한을 독립적으로 적용합니다.
참여권은 WebSocket upgrade와 방 입장에서 검사한 뒤 자체 `exp`까지 해당 socket의 범위를
제한합니다. 따라서 BATON membership 취소는 다음 갱신에서 반영되지만, 이미 연결된 socket은
현재의 짧은 참여권이 만료될 때까지 승인 상태를 유지할 수 있습니다.

coturn shared secret은 signaling과 TURN runtime에만 존재합니다. 브라우저는 standalone
모드에서는 `/api/turn-credentials`, BATON 모드에서는 방 범위 endpoint에서 시간이 제한된
HMAC credential을 요청합니다. 수명이 긴 TURN password는 Vite bundle에 compile하지 않습니다.
BATON 발급은 유효 client 주소, `(room_id, sub)`, 서버 전체에 fixed-window quota를 원자적으로
적용합니다. 새 `jti`를 발급하거나 client 주소를 변경해도 참가자 window가 초기화되지 않습니다.
Standalone 발급은 client와 global 차원만 유지합니다. Quota metric은 참가자, 방, token,
주소 값 대신 제한된 scope label을 노출합니다.

승인된 서비스 경계 결정과 전체 claim 계약은
[ADR 0001](adr/0001-round-independent-service.md)에 기록되어 있습니다.

## 복원력 경계

사용자가 명시적으로 입장할 때까지 prejoin이 camera와 microphone track을 소유합니다. 이후
소유권은 `RoomSession`으로 이동합니다. `RoomSession`은 제한된 signaling reconnect 동안
local track을 유지하면서 오래된 remote peer connection과 서버가 소유했던 이전 peer ID를
버립니다. 로컬에서 나가거나 복구 시도를 모두 소진하면 소유한 모든 track과 timer를
중지합니다.

BATON 모드는 prejoin을 mount하기 전에 Account session 조회와 참여권 갱신으로 방 route를
차단하고, 명시적인 미디어 동의 뒤 TURN 발급과 WebSocket 생성을 수행합니다. 인증되지 않은
응답은 정규 same-origin `/room/{roomId}` login 복귀 경로를 사용하고, membership 거부는 login
loop 없이 BATON으로 돌아갑니다. 참여권 refresh manager는 single-flight이며 즉시 두 번째
참여권을 발급하지 않고 입장 gate에서 활성 방으로 전달됩니다. 또한 monotonic 브라우저 clock을
사용해 BATON의 상대적인 `refreshAfterSeconds`에서 다음 갱신을 예약합니다. prejoin이 열린 채
그 deadline이 지나면 장치 접근, 미디어를 사용하는 입장, 미디어 없는 입장 모두 진행 전에
같은 guard를 호출합니다. 활성 방의 갱신 `401`, `403`, `404`는 terminal 상태이며 다음 갱신을
예약하지 않고 각각 login, 권한 안내, 종료된 방 화면으로 돌아갑니다. 지원하지 않는 auth-mode
설정은 landing이나 prejoin을 mount하기 전에 app root에서 실패합니다. BATON alias는 account
구분이 없는 local storage가 아니라 현재 document memory에만 남습니다. TURN 발급은 별도로
서버가 계산한 `refreshAfterSeconds`를 반환합니다. 브라우저는 TURN `expiresAt` epoch를
`Date.now()`와 비교하는 대신 이를 받은 시점의 monotonic deadline을 기록합니다. TURN
갱신과 최초 또는 reconnect WebSocket 생성은 모두 같은 참여권 `ensureFresh()` guard를 먼저
호출합니다. 참여권 갱신에 성공하면 `HttpOnly` cookie만 회전하며 현재 socket을 선제적으로
끊지 않습니다. 이전 socket의 원래 참여권이 만료되면 ROUND가 이를 닫고, 기존의 제한된
reconnect 경로가 local media와 chat history를 유지한 채 새 cookie로 새 socket을 만듭니다.

BATON web runtime은 hash가 붙은 `/round-ui/assets/*`에만 1년 immutable 정책을 적용해
제공합니다. Room HTML은 `no-store`이며, `/round-ui/`는 내장 artifact root에서 standalone
방 생성이나 초대 code 입력을 노출하는 대신 no-store 404를 반환합니다.

ICE 복구는 glare를 피하도록 피어 쌍마다 결정적인 offer initiator 하나를 사용합니다. 연결이
끊긴 피어에는 짧은 grace period를 준 뒤 ICE restart를 수행하고, restart로 복구되지 않으면
peer connection을 다시 생성합니다. 모든 ROUND offer는 제한된 `negotiationId` generation을
시작하며 answer와 ICE candidate가 이를 그대로 반환합니다. 다시 생성한 피어는 폐기된
generation의 메시지를 거부하므로 지연된 SDP나 ICE가 단 한 번의 교체 시도를 손상시키지
않습니다. Protocol v2는 이 wire-contract 변경을 나타냅니다. web client와 signaling 서버는
함께 배포해야 하며 현재 ROUND client는 항상 이 optional field를 보냅니다. 방 제한을 늘리거나
여러 영상 소스를 추가할 때는 이 mesh 복구 모델을 무기한 확장하지 말고 미디어 토폴로지를
SFU로 전환해야 합니다.
