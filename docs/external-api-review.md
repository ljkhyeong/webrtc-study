# 외부 API 연동 검토

확인일: 2026-09-07. 코드 기준: `fd874e2`.
ROUND 소스·배포 설정과 제공사의 공식 문서를 대조했다. 실제 계정 설정과 API 호출은 확인하지 않았다.

가장 큰 대체 후보는 직접 만든 통화 엔진이다. 관리형 회의 SDK로 연결·참가자·미디어 관리를 맡기면 유지보수할 코드를 줄일 수 있다. 작은 변경으로 추가할 후보는 브라우저 오류 수집이다. TURN 중계와 서버 지표 전송은 이미 외부 서비스 연동이 구현되어 있다.

## 후보와 효과

| 대상                         | 연동 후보                                          | 줄일 수 있는 작업                                                                 | 판단                                                   |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 영상·음성 연결, 참가자 관리  | Cloudflare RealtimeKit Core SDK, LiveKit Cloud SDK | 피어별 SDP/ICE 전달, 연결 상태 관리, 미디어 연결·재연결 구현                      | 코드 감소 효과가 가장 큼. 통화 엔진 교체가 필요한 작업 |
| 기본 통화 화면               | RealtimeKit UI Kit, Daily Prebuilt                 | 영상 타일, 기본 장치 제어, 화면 공유·참가자·채팅 화면 구현                        | 화면을 제공사 구성에 맞출 수 있을 때 효과가 큼         |
| 브라우저 오류 수집           | Grafana Faro + Frontend Observability              | 오류 수집 서버, 오류 조회 화면, 브라우저 성능 수집 기능을 새로 만들 필요가 줄어듦 | 현재 코드 삭제보다 운영 기능 추가에 해당               |
| 스터디 일정·개인 캘린더 반영 | Google Calendar API                                | 일정 등록·수정·삭제와 변경 알림을 캘린더 서비스에 연동                            | ROUND에는 일정 관리가 없으므로 BATON에서 검토          |

RealtimeKit은 미디어 라우팅과 피어 관리를 추상화하며 회의·참가자·UI 기능을 제공한다. LiveKit SDK는 네트워크 변경 시 시그널링 복구, ICE 재시작과 전체 재연결을 처리한다. [Cloudflare 제품 비교](https://developers.cloudflare.com/realtime/), [LiveKit 연결·재연결](https://docs.livekit.io/intro/basics/connect/).

Daily Prebuilt는 영상통화 UI, 대역폭 관리, 화면 공유, 채팅, 손들기 등을 제공한다. 기본 회의 화면을 임베드하는 방식이므로 ROUND의 세부 화면 동작을 그대로 옮길 수 있다고 가정하지 않는다. [Daily Prebuilt](https://docs.daily.co/docs/prebuilt).

## 1. 통화 엔진: 가장 큰 대체 후보

현재 직접 구현한 주요 위치:

- [room-session.ts](../packages/rtc-core/src/room-session.ts): 방 세션과 연결·미디어·채팅 상태를 조합한다.
- [peer-negotiation-lifecycle.ts](../packages/rtc-core/src/peer-negotiation-lifecycle.ts), [peer-connection-lifecycle.ts](../packages/rtc-core/src/peer-connection-lifecycle.ts): 참가자별 연결 협상과 연결 수명을 관리한다.
- [signaling-transport.ts](../packages/rtc-core/src/signaling-transport.ts), [signaling-recovery-lifecycle.ts](../packages/rtc-core/src/signaling-recovery-lifecycle.ts): WebSocket과 재연결을 관리한다.
- [peer-data-channel.ts](../packages/rtc-core/src/peer-data-channel.ts): 참가자 간 채팅 전송 채널을 관리한다.
- [SignalingService.java](../apps/signaling/src/main/java/com/personal/round/signaling/SignalingService.java): 참가자, 연결 메시지 전달, 권한, 타이머·손들기 상태를 관리한다.

SDK로 옮길 때 연결·전송 부분을 교체하고, BATON의 멤버십·방장 판정과 스터디 타이머·주제 규칙은 유지한다. 이 파일들에는 제품 규칙도 섞여 있으므로 파일 전체나 특정 비율을 삭제할 수 있다고 단정할 수는 없다.

선택 기준:

| 선택                                | 맞는 조건                                                      | 남는 작업                                                                       |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| RealtimeKit Core SDK                | 현재 Cloudflare 연동 환경에서 회의 SDK를 먼저 검토할 때        | BATON 권한을 회의 참가자·권한 설정에 연결하고 기존 React 화면에 SDK 상태를 반영 |
| LiveKit Cloud SDK                   | 현재 화면을 유지하면서 SDK의 연결·트랙·데이터 기능을 사용할 때 | 참가자 토큰 발급, 화면과 SDK 이벤트 연결, 스터디 상태 처리                      |
| RealtimeKit UI Kit / Daily Prebuilt | 기본 통화 화면까지 제공받아 관리할 코드를 크게 줄일 때         | BATON 입장 처리, 브랜딩, 타이머 같은 별도 제품 기능 연결                        |

RealtimeKit은 별도 앱·API 권한·참가자 토큰이 필요하다. 기존 TURN 키만 설정하면 전환되는 구조는 아니다. LiveKit도 방·사용자·권한을 담은 참가자 토큰을 사용한다. [RealtimeKit 시작 절차](https://developers.cloudflare.com/realtime/realtimekit/quickstart/), [LiveKit 연결](https://docs.livekit.io/intro/basics/connect/).

Cloudflare의 **Realtime SFU 단독 API**는 이번 목적에서 우선순위가 낮다. 미디어 전달을 제공하지만 방·참가자·권한·접속 상태와 시그널링은 애플리케이션이 관리해야 한다. 코드 감소가 목적이면 RealtimeKit 같은 상위 SDK를 먼저 검토한다. [Realtime SFU 역할](https://developers.cloudflare.com/realtime/sfu/).

채팅은 통화 SDK의 데이터 기능과 함께 검토한다. 예를 들어 LiveKit의 text stream은 실시간 전송과 React 채팅 컴포넌트를 제공하며 장기 저장은 포함하지 않는다. 현재 ROUND의 참가자별 수신 확인·2분 이내 대상별 재전송은 별도 요구사항이므로 SDK 기본 채팅으로 동일하게 동작한다고 가정하면 안 된다. 채팅만을 위해 별도 서비스를 추가하는 것은 현재 규모에서는 우선하지 않는다. [LiveKit 텍스트 전송](https://docs.livekit.io/transport/data/text-streams/).

비용도 선택 기준이다. 확인일의 RealtimeKit 영상·음성 참가자 요금은 1인·1분당 $0.002다. 예를 들어 6명이 2시간 이용하면 `6 × 120 × $0.002 = $1.44`, 같은 모임이 월 20회면 $28.80다. 공개 단가로 계산한 통화료이며 세금·녹화·다른 서비스 비용은 제외했다. 카메라를 끄는 것만으로 음성 전용 요금이 되는 것은 아니며 참가자의 preset에 설정한 회의 유형을 따른다. [RealtimeKit 요금](https://developers.cloudflare.com/realtime/realtimekit/pricing/).

**권장 검토 순서:** RealtimeKit Core SDK를 먼저 소규모로 비교하고, 현재 화면·재연결 요구를 맞추기 어렵다면 LiveKit Cloud를 비교한다. 장치 확인 전 미디어 접근 금지, BATON 권한 상실 처리, 채팅 수신 확인과 타이머 동작을 확인한 뒤 전환 여부를 결정한다. 현재 mesh의 참가자별 재연결과 SFU의 서버 연결 복구는 구조가 다르므로 같은 동작을 약속하지 않는다.

## 2. 브라우저 오류 수집: 작은 규모로 추가할 후보

[compose.yml](../compose.yml)에는 Alloy가 Spring 지표를 Grafana Cloud로 전송하는 설정이 있다. 웹 앱에는 Faro/Sentry SDK 연동이 없고, 통화 진단은 [connection-diagnostics.ts](../packages/rtc-core/src/connection-diagnostics.ts)에서 요청할 때 측정하는 구조다.

Grafana Faro는 브라우저 오류·성능·로그 수집을 제공하므로 오류 저장 API와 조회 화면을 직접 만들 필요를 줄인다. 서버 지표 연동과는 별도 설정이며, 자동 수집만으로 WebRTC 품질이나 앱에서 처리한 모든 오류가 수집되는 것은 아니다. 통화 실패 코드·배포 버전 등 필요한 이벤트만 추가하고, 토큰·방 링크·채팅 원문은 수집 항목에서 제외한다. [Grafana Frontend Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/), [Faro 기본·사용자 정의 수집](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/custom-signals/).

## 3. 일정 연동: BATON에서 검토

현재 [아키텍처](architecture.md)에서 사용자·스터디·일정은 BATON이 담당하고 ROUND의 타이머는 현재 방의 집중·휴식 시간만 관리한다. 개인 캘린더 동기화는 타이머 코드를 대체하지 않는다.

Google Calendar API로 BATON 일정과 ROUND 입장 링크를 개인 캘린더에 등록·수정할 수 있다. 사용자 OAuth 동의가 필요하며, 변경 알림을 받는 방식도 알림 수신 후 실제 변경 내용을 다시 조회해야 한다. 알림 누락과 구독 갱신을 처리해야 하므로 API 호출 하나로 양방향 실시간 동기화가 끝나지는 않는다. [일정 생성](https://developers.google.com/workspace/calendar/api/guides/create-events), [변경 알림](https://developers.google.com/workspace/calendar/api/guides/push).

이 저장소에 없는 새 기능이므로 이번 코드 감소 대상에서는 제외한다. BATON의 기존 캘린더 연동은 이번 점검에서 확인하지 않았다.

## 이미 외부 서비스를 사용하도록 구현된 부분

- **TURN 중계:** [CloudflareTurnClient.java](../apps/signaling/src/main/java/com/personal/round/turn/CloudflareTurnClient.java)가 Spring `RestClient`로 Cloudflare API에서 단기 자격 증명을 발급받는다. 직접 TURN 서버를 구현하는 구조가 아니다. [TurnCredentialService.java](../apps/signaling/src/main/java/com/personal/round/turn/TurnCredentialService.java)의 참여권 만료·발급 한도는 ROUND가 유지할 규칙이다.
- **서버 지표:** [compose.yml](../compose.yml)의 Alloy → Grafana Cloud 연동을 재사용한다. 별도 지표 저장소와 대시보드 서버를 추가할 필요가 없다.

공용 타이머, 이름·방 코드 검증, BATON 입장 권한은 외부 API로 바꾸는 이점이 작다. 녹화·자막·번역·메일 발송은 현재 없는 기능이므로 코드 감소 항목에 포함하지 않았다.

## 확인 범위

소스와 공식 문서의 기능 범위를 대조한 검토다. SDK 교체, 계정 생성, 유료 기능 활성화, 외부 데이터 전송은 실행하지 않았다. 실제 삭제 가능 범위·브라우저 호환성·운영 비용은 선택한 SDK로 검증해야 한다. 문서만 추가했으므로 애플리케이션 테스트는 반복하지 않는다.
