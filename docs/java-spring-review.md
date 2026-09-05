# Java·Spring 구현 간소화 검토

- 검토일: 2026-09-05
- 기준 커밋: `e328428`
- 범위: `apps/signaling`의 운영 Java 코드와 관련 테스트
- 기준 환경: Java 21, Spring Boot 4.1.0. 기존 서버 JAR에서 Jackson 3.1.4와 Spring Security 7.1.0을 확인했다.

1~3번 항목은 모두 반영했다. 숫자 중복 검사와 수동 JSON 변환을 줄이고, 서비스의 방·대상 검사를 공유했다. 오류 응답과 검증 순서는 유지했다. 4번은 `bc2c247` 기준 추가 검토 결과이며 아직 적용하지 않았다.

## 1. 숫자 검사는 Jackson API가 보장하는 부분을 제거한다

위치: [ProtocolParser.boundedInteger](../apps/signaling/src/main/java/com/personal/round/protocol/ProtocolParser.java#L105)

기존에는 `canConvertToLong()` 앞뒤에서 `isNumber()`와 `doubleValue() != longValue()`를 추가로 검사했다. Jackson 3의 `canConvertToLong()`은 숫자 여부, 정수 여부, `long` 범위를 함께 확인하므로 두 조건을 제거했다. 공식 API와 현재 사용하는 3.1.4 JAR의 구현을 확인했다. [Jackson 숫자 변환 API](<https://javadoc.io/static/tools.jackson.core/jackson-databind/3.0.0/tools.jackson.databind/tools/jackson/databind/JsonNode.html#canConvertToLong()>)

- 변경: 누락 여부와 `canConvertToLong()`을 확인한 뒤 `longValue()`를 한 번 읽어 업무 범위를 검사한다.
- 유지: 타이머의 60~7200초 범위와 JavaScript에서 정확하게 표현할 수 있는 revision 상한.
- 효과: 정수 판정을 직접 구현할 필요가 없어지고, 같은 클래스의 `numericLiteral()`·`nullableOptionalInteger()`와 검사 방식이 맞아진다.
- 확인: 기존 `ProtocolParserTest`, `StudyProtocolTest`의 정수·소수·범위 검사. 빠져 있던 revision 상한과 초과 값 검사를 추가했다.

## 2. 이미 정의된 상태 record는 Jackson으로 JSON에 넣는다

위치: [ServerMessageEncoder.studyState·handState](../apps/signaling/src/main/java/com/personal/round/protocol/ServerMessageEncoder.java#L73)

기존에는 `StudyState`와 `HandQueueState`의 필드와 참가자 목록을 JSON 노드에 수동 복사했다. 기존 record를 `ObjectMapper.valueToTree(state)`로 변환하도록 바꿨다. [Jackson 객체·JSON 트리 변환 API](https://javadoc.io/static/tools.jackson.core/jackson-databind/3.1.4/tools.jackson.databind/tools/jackson/databind/package-summary.html)

- 변경: `handState`는 변환한 노드를 `payload`에 넣는다. `studyState`는 변환한 객체 노드에 응답 전용 필드인 `conflict`만 추가한다.
- 유지: JSON 필드명, 배열 순서, `requestId`가 없을 때 필드 자체를 생략하는 동작.
- 효과: 상태 필드를 바꿀 때 record와 인코더를 각각 수정하는 부담이 줄어든다.
- 확인: 기존 손들기·스터디 테스트와 응답 전체 필드·배열 순서·빈 배열·요청번호 생략 검사를 통과했다.

기존 두 record에만 적용했다. 이후 record에 내부용 필드를 추가한다면 전송 제외 여부를 함께 정해야 한다.

## 3. 메시지마다 복사된 방·대상 참가자 검사를 합친다

위치: [SignalingService.requireJoinedRoom](../apps/signaling/src/main/java/com/personal/round/signaling/SignalingService.java#L724), [findTargetInRoom](../apps/signaling/src/main/java/com/personal/round/signaling/SignalingService.java#L743)

방 입장 여부와 요청한 방의 일치 여부가 6개 처리 메서드에 반복되어 `requireJoinedRoom()`으로 합쳤다. `relay`·`reconnect`·`moderate`의 자기 자신을 대상으로 하는지 검사하는 부분과 같은 방의 대상 조회는 `findTargetInRoom()`으로 합쳤다.

- 변경: `leave`·`relay`·`reconnect`·`hand`·`study`·`moderate`에서 방 검사 구현을 공유한다. 대상 검사는 기존과 같은 위치에서 호출한다.
- 유지: 현재 잠금 안에서 검사하는 위치, 오류 코드와 `requestId`, 메시지별 안내 문구, 방장 권한 검사의 순서.
- 효과: 복사된 조건문과 오류 응답 생성을 줄이고, 방 접근 규칙을 한곳에서 수정할 수 있다.
- 확인: 관련 시그널링 테스트의 미입장·다른 방·자기 자신·없는 대상·권한 부족 사례를 통과했다.

각 메시지에서 검사를 수행하는 것 자체는 필요하다. 공통 메서드로 구현을 공유하며 요청별 검사는 유지한다. 현재 방 상태를 확인해야 하므로 Bean Validation이나 AOP로 옮기지 않았다.

## 4. 메트릭 등록 시 공통 설정을 공유한다 — 미반영

위치: [SignalingMetrics 생성자](../apps/signaling/src/main/java/com/personal/round/signaling/SignalingMetrics.java#L55)

입장 거절 지표 4개와 연결 거절 지표 6개가 같은 이름으로 각각 `Counter.builder()`를 호출한다. 이유를 나타내는 `reason` 태그가 달라지는 구조이므로 Micrometer의 `MeterProvider<Counter>` 두 개로 이름·설명을 공통 설정하고 `withTag()`로 각 카운터를 생성할 수 있다. 사용하는 Micrometer 1.17.0 JAR에서 `withRegistry()`와 `withTag()` 지원을 확인했다. [Micrometer MeterProvider 문서](https://docs.micrometer.io/micrometer/reference/1.18/concepts/meter-provider.html)

- 변경: 생성자에서 지표별 공통 설정을 한 번 정의하고 기존 `Counter` 필드에 태그별 카운터를 넣는다.
- 유지: 지표명, 태그 값, 기존 증가 메서드, 시작 시 값이 0인 카운터도 등록되는 동작.
- 효과: 반복되는 등록 코드를 줄인다. 생성자에서 한 번 실행되는 코드이므로 처리 성능 개선 효과를 기대하는 변경은 아니다.
- 적용 후 확인: 기존 입장·연결 거절 테스트의 카운터 값과 초기 등록 여부를 확인한다.

우선순위는 낮다. 검증 로직에서 추가로 제거할 만한 확실한 중복은 찾지 못했다. 이번 추가 검토에서는 애플리케이션 코드를 수정하거나 테스트를 다시 실행하지 않았다.

## 유지할 코드

| 코드                                                | 유지 이유                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SignalingOutboundDispatcher`와 서비스의 전송 처리  | Spring의 `ConcurrentWebSocketSessionDecorator`는 동시 전송 직렬화와 세션별 버퍼 제한을 제공한다. 현재 구현은 서버 전체 바이트 제한, 과부하 시 연결 정리, 퇴장 알림 순서와 Ping 전송 시점까지 처리한다. 단순 교체하면 동작이 빠진다. [Spring 전송 래퍼 API](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/socket/handler/ConcurrentWebSocketSessionDecorator.html) |
| 연결·수신·TURN 발급 제한                            | 연결 수, 수신 프레임·바이트, 외부 TURN 발급 횟수는 서로 다른 자원을 제한한다. 중복 검사로 볼 수 없다.                                                                                                                                                                                                                                                                                                        |
| JWT 인증 후 WebSocket 참여권 만료 재확인            | 인증과 메시지 처리 사이에 시간이 흐르고, 연결은 오래 유지된다. 기존 테스트도 수신 허용 후 메시지 처리 전 만료를 다룬다.                                                                                                                                                                                                                                                                                      |
| `BatonParticipationTokenValidator`의 만료 경계 검사 | Spring Security 7.1.0의 `JwtTimestampValidator`는 현재 시각이 만료 시각보다 뒤인지 검사한다. ROUND는 만료 시각과 같아도 거부하므로 결과가 완전히 같지 않다. [Spring Security 구현](https://raw.githubusercontent.com/spring-projects/spring-security/7.1.0/oauth2/oauth2-jose/src/main/java/org/springframework/security/oauth2/jwt/JwtTimestampValidator.java)                                              |
| ECMAScript 공백 검사와 UTF-8 길이 계산              | JavaScript의 문자열 계약을 맞추는 코드다. 특히 짝이 없는 서로게이트를 브라우저 `TextEncoder`처럼 처리하므로 단순한 `String.isBlank()`·기본 바이트 변환으로 바꾸면 허용 범위가 달라질 수 있다.                                                                                                                                                                                                                |
| `CookieBearerTokenResolver`                         | 같은 이름의 쿠키가 중복되면 거부한다. 첫 쿠키만 찾아 반환하는 도우미로 바꾸면 이 정책이 사라진다.                                                                                                                                                                                                                                                                                                            |

설정값은 이미 Bean Validation, 외부 HTTP 요청은 `RestClient`, JWT 서명·JWK 캐시는 Spring Security와 Nimbus, 실행기는 Java 가상 스레드 API를 사용한다. 이 영역에서 표준 API를 대체한 대규모 직접 구현은 확인하지 못했다.

## 확인 결과

1~3번 반영 시 프로토콜 테스트와 서비스의 방 권한·재연결·스터디·손들기 테스트 38개를 Gradle 1회 호출로 실행해 모두 통과했다. 문서 형식과 Git 차이도 확인했다. 설정·메시지 형식·브라우저 동작은 바뀌지 않아 전체 빌드와 브라우저 검사는 실행하지 않았다.
