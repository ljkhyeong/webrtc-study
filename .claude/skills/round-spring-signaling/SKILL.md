---
name: round-spring-signaling
description: ROUND의 Java 시그널링 서버(apps/signaling)에서 WebSocket 메시지 처리·방과 세션·BATON 참여권 인증·연결과 요청 제한·TURN 자격 증명·Spring 설정을 바꿀 때 사용한다. 단순 문구·문서 수정에는 사용하지 않는다.
---

# ROUND Java 시그널링

범위와 검증 기준은 저장소 `AGENTS.md`와 `docs/agent-validation.md`를 따른다.
서버 코드는 `apps/signaling/src/main/java/com/personal/round`, 테스트는 같은 패키지 구조의 `apps/signaling/src/test`에 있다.

## 패키지 책임

- `protocol`: 메시지 파싱·검증·인코딩. `config`·`net`·`signaling`·`turn`(실행 계층)에 의존하지 않는다.
- `signaling`: 방·세션·중계·연결과 수신 제한·전송. `*WebSocketHandler`는 `protocol`·`signaling`만 사용하며 서비스 규칙을 추가하지 않는다.
- `auth`: BATON 참여권·JWT·쿠키·방 접근. `signaling`·`turn`에 의존하지 않는다.
- `turn`: TURN 자격 증명 발급과 발급 제한. `config`: Spring 설정·핸드셰이크. `net`: 클라이언트 주소.
- 위 경계는 `ArchitectureTest`가 확인한다. 메시지 형식·필드·오류 코드가 바뀌면 `round-webrtc-flows` 스킬로 TypeScript 계약과 관련 처리를 맞춘다.
- 인증·연결 제한을 바꿀 때만 `apps/signaling/README.md`의 참여권 만료, 연결 슬롯 예약, 요청 제한 규칙을 확인한다. 간소화 판단은 `docs/java-spring-review.md`의 유지할 코드를 참고한다.

## 유지할 동작

- `peerId`와 중계 메시지의 `from`은 서버가 정한다. 발신자와 대상이 같은 방에 있을 때만 offer·answer·ICE를 중계한다.
- 방 정원과 연결 제한은 동시 요청에도 초과하지 않아야 한다. 입력·인증·자원 제한 검사를 중복이라는 이유만으로 제거하지 않는다.
- BATON 참여권의 방·사용자·만료 검증과 정확한 Origin 검증을 유지한다. 비밀값은 코드·로그·테스트 기대값에 남기지 않는다.
- 퇴장·연결 종료·서버 종료가 겹쳐도 방과 예약을 한 번만 정리하고, 실제 퇴장 시 `peer.left`를 한 번 알린다. 빈 방은 삭제한다.
- ping에 대응하는 pong을 확인하고 응답 기한이 지난 연결을 정리한다. 음성·영상 내용은 처리하거나 저장하지 않는다.

## 검증

- 작성 직후: 운영 코드는 `./gradlew --no-daemon :apps:signaling:compileJava`, 테스트 코드는 `compileTestJava`.
- 동작 확인: `./gradlew --no-daemon :apps:signaling:test --tests '<패키지.클래스>'`로 관련 테스트만 실행한다. `--tests`는 여러 번 지정할 수 있다.
- 설정·빈 연결은 실제 Spring 컨텍스트 테스트(`config` 패키지의 `*ConfigurationTest`·`WebSocketConfigTest` 등)로 확인한다. 동시성·세션 정리를 바꾸면 경합·중복 종료 결과를 확인한다.
- 종료 직전 Java 소스나 빌드 설정을 바꿨으면 `npm run check:architecture`. 같은 리비전에서 `npm run check:java`가 통과했다면 생략한다.
- Gradle 캐시 잠금·`EPERM`은 환경 문제다. 권한 승인을 받아 실행하고 같은 명령을 조건 변경 없이 반복하지 않는다.
