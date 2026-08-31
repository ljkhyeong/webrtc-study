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
SDP/ICE 메시지를 전달하는 역할만 합니다. 직접 경로를 사용할 수 없으면 Cloudflare TURN이 암호화된
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

채팅 DataChannel은 `round-room` label, `ordered=true`, 재전송 횟수와 수명 제한이 없는
신뢰성 전송 계약을 사용합니다. 원격 피어가 이 계약과 다른 channel을 열면 브라우저는 해당
channel을 즉시 닫고 현재의 정상 channel을 유지합니다.

로컬 메시지는 대상인 모든 피어의 현재 `RoomSession`이 메시지를 검증·기록하고
`chat.ack`를 반환할 때까지 `pending`으로 남습니다. 이 확인 응답은 애플리케이션이
수락했다는 뜻이지, 사람이 메시지를 읽었다는 뜻은 아닙니다. 모든 대상의 확인 응답을 받으면
`sent`, 확인된 응답과 복구 불가능한 피어 실패가 함께 있으면 `partial`, 확인된 수신자가
없으면 `failed`가 됩니다. 중복 재전송은 `(peerId, messageId)`로 중복 제거하지만 다시 확인
응답하므로, channel 복구 중 유실된 ACK가 채팅을 두 번 표시하지 않고도 최종 상태에
수렴할 수 있습니다.

각 피어는 확인되지 않은 채팅 frame을 최대 50개까지 보유하며, 각 frame에는 프로토콜의
32 KiB 상한과 절대 45초의 전달 기한이 적용됩니다. 브라우저는 DataChannel 송신 buffer가
256 KiB를 넘기 전에 일반 채팅을 일시 중지하고, 64 KiB에서 `bufferedamountlow`가 발생한
뒤 재개합니다. 개수가 제한된 ACK 제어 frame은 병합된 최신 미디어 상태와 대기 중인 채팅보다
먼저 전송합니다.

채팅 frame의 `sentAt`은 표시와 wire 호환성을 위한 wall clock epoch이고, 피어별 수신량
제한 구간은 시스템 시각 변경에 영향받지 않는 monotonic clock을 사용합니다.

사용자가 연결 진단을 열면 `RoomSession`은 각 `RTCPeerConnection`의 표준 `getStats()`를 한 번
호출합니다. 화면에는 연결 상태, local·remote candidate 유형, 왕복 지연, 패킷 손실률, 수신
jitter 최댓값만 표시합니다. 방 코드, peer ID, 표시 이름, candidate 주소와 포트는 진단 결과에
포함하지 않으며 서버로 전송하거나 주기적으로 수집하지 않습니다. 따라서 운영 지원에 필요한
TURN 사용 여부와 품질 정보는 복사할 수 있지만 참가자의 네트워크 주소는 노출하지 않습니다.

`chat.ack`는 기존에 추가된 peer protocol frame이며 Java signaling protocol version을
변경하지 않습니다. ROUND는 현재 이 기능을 협상하지 않고 web client를 원자적으로
배포합니다. pilot 참가자는 web release 후 모두 새로고침해야 합니다. ACK를 구현하지 않은
오래된 client는 채팅을 표시할 수 있지만, 새 발신자는 성공으로 잘못 보고하지 않고 45초
기한 뒤 수신 확인 실패로 안전하게 실패합니다.

채팅 본문은 `linkify-react`로 HTTP·HTTPS 주소만 링크로 표시하며, HTML을 실행하거나
외부 미리보기를 요청하지 않습니다. 링크는 `noopener noreferrer`를 붙여 새 탭에서 엽니다.
메시지 복사는 Clipboard API로 줄바꿈을 포함한 원문을 복사하며, 권한이 없으면 직접 선택해
복사하도록 안내합니다. 전송 frame과 휘발성 보관 정책은 바꾸지 않습니다.

채팅 화면은 사용자가 목록 하단을 보고 있을 때만 새 메시지를 따라갑니다. 이전 메시지를
읽는 동안에는 스크롤 위치를 유지하고 새 메시지·전송 문제 개수와 최신 대화 이동 버튼을
표시합니다. 수신 ACK만 바뀌는 경우에는 스크롤하지 않습니다. 채팅을 다시 열거나 직접
메시지를 보내면 최신 대화로 이동합니다. 메시지 보관 한도와 휘발성 전달 방식은 그대로입니다.

## 미디어 소스와 관리 경계

입장 전 마이크 입력 표시는 이미 허용받은 트랙을 Web Audio `AnalyserNode`로 분석합니다.
출력 장치에는 연결하지 않으며 녹음·서버 전송·추가 권한 요청을 하지 않습니다. 트랙 교체,
음소거, 입장 화면 종료 시 분석 노드와 `AudioContext`만 정리하고 트랙 소유권은 변경하지 않습니다.

입장 전 장치 선택은 실제 사용 중인 트랙이 같은 장치일 때만 요청을 생략합니다. 사용 가능한
트랙이 없으면 목록의 기본 선택과 관계없이 선택 안내를 표시해 장치를 다시 요청할 수 있게 합니다.

입장 전 장치가 분리돼도 마이크·카메라의 마지막 켜기·끄기 선택을 방 세션에 전달합니다.
따라서 입장 후 장치를 다시 선택해도 꺼 둔 입력이 자동으로 켜지지 않습니다. 장치 확인 없이
미디어 없이 입장한 경우에는 기존처럼 처음 선택한 장치를 켭니다.

통화 중 입력 장치는 `RoomSession.selectInputDevice`가 새 트랙을 얻고 기존 송신자의
`replaceTrack`으로 교체합니다. 기존 트랙은 모든 교체가 끝난 뒤 해제하며 음소거 상태를
유지합니다. 실패하면 기존 트랙으로 복원하고, 복원까지 실패한 피어 연결만 다시 만듭니다.
장치가 분리돼도 마지막 켜기·끄기 선택을 유지하며, 장치가 없는 동안 받은 방장 끄기 요청도
다음 장치에 적용합니다. 사용자가 다시 켜면 이후 장치 교체에는 변경된 선택을 적용합니다.
단절 기록은 마이크와 카메라별로 보관하며 해당 장치를 복구해야 해제합니다. 다른 연결 경고가
먼저 표시되더라도 장치 단절 기록은 유지하고, 그 경고가 해결되면 남은 장치 복구 안내를 표시합니다.
교체나 복원 중 피어가 종료되면 해당 대기를 취소하고 남은 피어만 처리합니다.
처음 장치를 켜는 경우에는 `addTrack`과 추가 협상을 사용합니다. 기존 방 세션과 채팅 기록은
유지하며 화면 공유 중에는 마이크만 바꿀 수 있습니다. BATON 참여권은 새 장치 요청 전에 확인합니다.

통화 장치 설정의 카메라 송신 모드는 `RTCRtpSender.setParameters()`로 적용합니다. 일반은
브라우저의 송신 제어를 사용하고 데이터 절약은 연결별 카메라 영상을 최대 150kbps·10fps,
가로·세로 절반 크기로 제한합니다. 기본 입력 기준으로 약 320×180이며 실제 송신량은
네트워크·브라우저에 따라 더 낮을 수 있습니다. 오디오·수신 영상·로컬 미리보기는 바꾸지
않습니다. 화면 공유에는 이 제한을 해제하고 카메라 복귀 시 다시 적용합니다. 선택은 새 피어와
재연결에도 유지하지만 방을 나가면 초기화합니다. 일부 연결이 설정을 거부하면 통화는 유지하고
재적용 또는 카메라 끄기를 안내합니다. 자동 네트워크 판정과 SDP 직접 수정은 하지 않습니다.

스피커 선택은 브라우저 화면에서만 관리하며 `RoomSession`과 송신 트랙은 변경하지 않습니다.
`HTMLMediaElement.setSinkId`로 기존·신규 원격 영상에 적용하고, 지원되는 환경에서는 사용자
버튼으로 `selectAudioOutput` 선택창도 열 수 있습니다. 출력 선택만을 위해 마이크 권한을 요청하지 않습니다.
적용 전에는 원격 음성을 음소거하고, 실패하면 다른 출력으로 우회하지 않고 설정 안내를 표시합니다.
동일 장치를 다시 적용해도 재시도합니다. 선택한 장치가 분리되면 알림을 표시하며 시스템 스피커로
자동 전환하지 않습니다. 미지원 브라우저는 시스템 기본 출력을 사용하고 운영체제 설정을 안내합니다.
선택은 방 화면을 벗어나면 버리며 장치 ID를 저장하거나 서버에 보내지 않습니다.

참가자 타일의 **소리 끄기**는 해당 영상 요소의 `muted`만 바꿉니다. 상대의 마이크와 다른
참가자의 재생에는 영향을 주지 않으며 방장의 마이크 끄기 요청과 별개입니다. 같은 참가자의
스트림·스피커 교체와 카메라 끄기 뒤에도 유지하지만, 참가자 퇴장이나 새 연결로 타일이
교체되면 초기화합니다. 개인 음소거 상태를 저장하거나 서버로 보내지 않습니다.

확인음은 사용자가 누른 뒤에만 Web Audio의 `OscillatorNode`로 0.6초 재생합니다.
`MediaStreamAudioDestinationNode`와 오디오 요소를 사용해 통화와 같은 출력 장치로 보내며,
완료·실패·설정 닫기 시 확인음 스트림과 `AudioContext`를 정리합니다.

`RoomSession`은 한 번에 하나의 발신 영상 소스를 소유합니다. 화면 공유를 시작하면 display
track을 얻어 모든 기존 `RTCRtpSender`의 camera track을 교체합니다. 화면 공유를 중지하거나
브라우저의 기본 **공유 중지** 동작을 실행하면 보관해 둔 camera track을 복원합니다. 오디오는
microphone track에 그대로 남습니다. display capture가 활성화된 동안에는 camera 전환을
비활성화해 하나의 제어가 숨겨진 소스를 실수로 변경하지 않게 합니다. 새 피어는 현재 선택된
소스를 수신하며, peer-to-peer `participant.media` frame은 그 소스가 `camera`인지
`screen`인지 전달합니다.

수신한 공유 화면은 한 개를 크게 고정할 수 있습니다. 고정은 해당 브라우저의 배치만 바꾸며
영상 요소와 `MediaStream`을 유지합니다. 채팅을 열거나 전체 화면으로 전환할 수 있고,
공유가 끝나거나 해당 참가자가 나가면 고정을 해제합니다. 고정 선택은 서버로 보내거나 저장하지 않습니다.

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

BATON은 사용자, 스터디, 일정과 입장 허용 결정을 소유합니다. ROUND는 휘발성 방·피어 상태,
raw WebSocket signaling과 TURN 자격 증명 발급만 소유하며 BATON의 데이터베이스나 엔티티를
참조하지 않습니다. 승인 결과는 방 범위의 짧은 RS256 참여권으로 전달하고 ROUND가 공개
JWK로 로컬 검증합니다.

| 목적               | 공개 same-origin 경로                               | 처리 경계                              |
| ------------------ | --------------------------------------------------- | -------------------------------------- |
| 참여권 갱신        | `/round/rooms/{roomId}/participation-grant/refresh` | BATON 소유                             |
| WebSocket 시그널링 | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`               |
| TURN 자격 증명     | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials` |

참여권은 URL, JavaScript 또는 브라우저 저장소에 노출하지 않고 방별 host-only 쿠키로
전달합니다. 공개 경로, 내부 경로, `room.join`과 참여권의 방 식별자가 모두 일치해야 하며,
사용자 식별자는 로그인 공급자 값이 아닌 canonical BATON `Account.id`를 사용합니다. 키
회전, claim, 수명, clock 처리, 오류 상태와 갱신 응답의 상세 계약은
[ADR 0001](adr/0001-round-independent-service.md)을 단일 원본으로 사용합니다.

연결된 socket은 handshake에서 검증한 참여권을 불변 lease로 보유합니다. 만료된 연결은
정해진 disconnect 경로로 한 번만 정리하고, 새 참여권 연결과 기존 연결이 잠시 겹치는
범위만 admission에서 허용합니다. 같은 사용자의 새 연결이 방에 입장하면 더 최근 연결을
남기고 이전 연결을 터미널 상태로 닫습니다. standalone 모드에는 이 BATON lease와 사용자별
admission 정책을 적용하지 않습니다.

BATON 웹은 Account session과 현재 방 참여권을 확인하기 전 landing·prejoin과 장치 권한
요청을 열지 않습니다. 갱신 관리자는 중복 요청을 하나로 합치고, TURN 갱신과 WebSocket
연결·재연결 전에 최신 참여권을 확인합니다. 인증·권한·방 종료 응답은 각각 로그인 안내,
BATON 복귀, 종료 화면으로 전환하며 내부 응답이나 자격 증명을 사용자 화면에 노출하지
않습니다.

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

Cloudflare TURN API token은 signaling runtime에만 존재합니다. 브라우저는 standalone
모드에서는 `/api/turn-credentials`, BATON 모드에서는 방 범위 endpoint에서 시간이 제한된
credential을 요청합니다. API token이나 장기 자격 증명은 Vite bundle에 compile하지 않습니다.
signaling은 기존 인증·Origin·quota 경계를 통과한 요청만 Cloudflare credential API로 전달하고,
공급자 장애는 503과 제한된 counter로 드러냅니다.
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
않습니다. `negotiationId`는 protocol v2에서 도입됐으며, 현재 wire 계약은 관리 메시지를 포함한
protocol v3입니다. web client와 signaling 서버는 함께 배포해야 하며 현재 ROUND client는 항상
이 optional field를 보냅니다. 방 제한을 늘리거나 여러 영상 소스를 추가할 때는 이 mesh 복구
모델을 무기한 확장하지 말고 미디어 토폴로지를 SFU로 전환해야 합니다.
