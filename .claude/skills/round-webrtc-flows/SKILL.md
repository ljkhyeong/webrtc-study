---
name: round-webrtc-flows
description: ROUND의 WebRTC 연결·협상·ICE·미디어·화면 공유·DataChannel 채팅·재연결 동작이나 브라우저와 서버 사이 메시지 계약(packages/protocol, packages/rtc-core, apps/web 통화 흐름)을 바꿀 때 사용한다. 단순 문구·스타일·문서 수정에는 사용하지 않는다.
---

# ROUND WebRTC 흐름

범위와 검증 기준은 저장소 `AGENTS.md`와 `docs/agent-validation.md`를 따른다.
설계 배경이 필요하면 `docs/architecture.md`에서 해당 절만 읽는다.

## 변경 위치

- 메시지 타입·검증은 `packages/protocol/src`의 `types.ts`·`validation.ts`, DataChannel 메시지는 `data-channel.ts`, 클라이언트 버전 호환은 `compatibility.ts`에 있다.
- 통화 동작은 `packages/rtc-core/src/room-session.ts`와 역할별 `*-lifecycle.ts`(협상·피어·로컬 미디어·화면 공유·시그널링 복구), 채팅은 `room-chat.ts`·`peer-data-channel.ts`에 있다.
- 화면과 React 연결은 `apps/web/src/components`, `apps/web/src/lib/use-*.ts`에 있다. 영향받는 코드만 추적한다.
- 이벤트 형식·필드·오류 코드가 바뀌면 TypeScript 계약, Java `ProtocolParser`, 해당 메시지 처리와 테스트를 함께 맞춘다. Java 쪽은 `round-spring-signaling` 스킬을 함께 사용한다.
- `@round/rtc-core`는 React·라우팅에 의존하지 않는다. 연결 객체와 트랙의 생성·종료는 기존 세션·미디어 담당 코드가 관리한다.

## 유지할 동작

- 새 참가자가 기존 참가자에게 offer를 보낸다. 원격 설명을 설정하기 전에는 ICE 후보를 대기시킨다.
- DataChannel이 열리면 현재 미디어 상태를 보내고, 크기가 제한된 채팅 대기열을 순서대로 한 번 비운다. 수신 확인이 없다는 이유로 미도착·읽지 않음으로 단정하지 않는다.
- 음소거·카메라 켜기와 끄기는 `track.enabled`로 처리하며 재협상하지 않는다. 스트림이 있으면 영상 요소를 유지해 카메라를 꺼도 음성이 끊기지 않게 한다.
- 참가자 재연결·퇴장은 해당 피어 자원만 정리한다. 시그널링 재연결 중에는 로컬 트랙을 유지하고, 최종 실패나 방 퇴장 때 전체 자원을 정리한다.
- 저장된 이름이 있어도 장치 확인 전에는 카메라·마이크 권한을 요청하지 않는다. BATON 입장은 로그인·방 참여 권한을 먼저 확인한다.

## 검증

- 웹은 alias로 두 패키지의 `src`를 직접 읽는다. `rtc-core` 테스트는 `@round/protocol`의 `dist`를 읽으므로, 프로토콜을 바꿨으면 `npm run build -w @round/protocol`을 먼저 실행한다.
- 패키지: `npm run typecheck -w @round/rtc-core`와 `npm run test -w @round/rtc-core -- test/<파일>`. 프로토콜도 같은 형식이다.
- 웹: `npm run check:web -- <apps/web 기준 테스트 파일>`.
- 입장·협상·채팅·미디어·재연결이 바뀌면 `round-e2e` 스킬로 두 참가자 브라우저 흐름을 확인한다.
- 메시지 계약을 바꾸면 브라우저 검증과 Java 파서의 허용·거부 결과가 일치하는지 확인한다.
- 배포·연결 설정을 바꾸면 `round-ops` 스킬과 `docs/pilot-checklist.md`의 해당 항목을 사용한다. 로컬 STUN 연결로 외부망 TURN 연결을 검증했다고 보고하지 않는다.
