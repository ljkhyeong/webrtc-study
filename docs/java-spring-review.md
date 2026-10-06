# Java·Spring 구현 간소화 검토

- 검토일: 2026-09-05(재검토 2026-10-05, 3차 2026-10-06)
- 기준 커밋: `e328428`
- 범위: `apps/signaling`의 운영 Java 코드와 관련 테스트
- 기준 환경: Java 21, Spring Boot 4.1.0. 기존 서버 JAR에서 Jackson 3.1.4와 Spring Security 7.1.0을 확인했다.

4개 항목을 모두 반영했다. 숫자 중복 검사와 수동 JSON 변환을 줄이고, 서비스의 방·대상 검사와 메트릭 등록 설정을 공유했다. 오류 응답과 검증 순서는 유지했다.

## 재검토: 2026-10-05

검토 기준은 `e85b8ac`다. 2026-09-12 추가 점검에서 보지 않은 설정·인증·TURN·요청 제한·파서 코드를 중심으로,
Spring·Java 표준 API로 대신할 수 있는 직접 구현과 과한 검증을 확인했다. 운영 데이터와 배포 이력이 없어
호환성 유지 부담 없이 2건을 반영하고, 2건은 프레임워크 제약으로 유지했다.

### 반영

| 위치                                                         | 이전 구현                                                                                                       | 반영 내용                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 참여권 변환(`ParticipationGrantAuthenticationConverter`)     | 토큰 검증기가 클레임을 참여권으로 바꾼 뒤, 핸드셰이크 인터셉터와 TURN 컨트롤러가 `Principal`에서 다시 변환했다. | `jwt.jwtAuthenticationConverter(...)`가 인증 주체를 참여권으로 한 번 만든다. 클레임 형식이 다르면 `InvalidBearerTokenException`으로 401을 반환한다. 컨트롤러는 `@AuthenticationPrincipal`로 받고, `BatonParticipationTokenValidator`는 시간 정책만 검사한다. |
| `SignalingProperties`·`TurnProperties`·`RoundAuthProperties` | 단일 필드 제약 61개에 속성 이름을 되풀이한 메시지를 직접 적었다.                                                | 기본 메시지를 쓰고 Spring Boot의 `BindValidationFailureAnalyzer`가 속성·값·위치를 보고한다. 교차 검증과 `@Pattern` 메시지는 유지하고, 제한값의 근거는 주석으로 남겼다. 검사는 로케일과 무관한 제약 코드(`Max.round.signaling.maxRoomSize` 등)로 확인한다.    |

### 2차 반영(같은 날)

운영 데이터와 배포 이력이 없다는 조건으로, 1차에서 "Spring과 동작이 다르다"며 유지한 항목을 다시 판단했다.

| 위치                                                                  | 이전 구현                                                                                                        | 반영 내용                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin 검사(`HttpOrigin`·`OriginPolicy`·`OriginHandshakeInterceptor`) | Origin 파싱·정규화와 WebSocket 인터셉터를 직접 구현하고, Spring의 검사는 `setAllowedOriginPatterns("*")`로 껐다. | WebSocket 등록의 `setAllowedOrigins`, `CorsConfiguration.checkOrigin`, `WebUtils.isSameOrigin`을 쓴다. 브라우저는 WebSocket에 Origin을 항상 보내고 비브라우저는 Origin을 꾸밀 수 있어, Origin이 없는 요청을 거부해도 교차 사이트 공격 방어에 이득이 없다. 시작 시 허용 출처 검사는 `AllowedOrigins`에 남겼다. |
| `TurnProperties`·`SignalingProperties` 생성자                         | null을 빈 문자열·빈 목록으로 직접 바꿨다.                                                                        | Spring Boot `@DefaultValue`로 지정한다.                                                                                                                                                                                                                                                                       |
| `RoundAuthProperties.isSecureServiceUri`                              | 질의·조각·빈 포트·포트 범위까지 직접 검사했다.                                                                   | HTTPS 또는 로컬 HTTP, 호스트 존재, 사용자 정보 없음만 확인한다. 나머지 오류는 토큰 검증·JWK 조회에서 바로 드러난다.                                                                                                                                                                                           |

### 검토 후 유지한 후보

| 위치                                      | 대안                                                    | 유지 이유                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClientCompatibilityHandshakeInterceptor` | `@GetMapping(params = "compatibility")` MVC 컨트롤러    | `/signal`을 WebSocket과 공유한다. 먼저 검사되는 MVC 매핑의 `params` 조건이 맞지 않으면 `RequestMappingInfoHandlerMapping.handleNoMatch`가 업그레이드 요청을 400으로 끝낼 수 있어, 핸들러 매핑 순서까지 바꿔야 한다.            |
| `ConnectionAdmissionHandshakeHandler`     | `DefaultHandshakeHandler` 상속과 `determineUser` 재정의 | Spring WebSocket 7.0.8의 `AbstractHandshakeHandler.doHandshake`가 `final`이라 연결 예약과 헤더 정제를 업그레이드 앞뒤에 넣을 수 없다. 위임 이유와 주체 교체 이유(JWT를 담은 인증 객체를 세션에 남기지 않음)를 주석으로 남겼다. |

손들기 대기열의 구버전 클라이언트 구분(`supportedPeerIds`, 서버 `RoomHandQueue`의 구독자, DataChannel `participant.hand`)은
배포 이력이 없어 같은 날 프로토콜·서버·RTC 코어·웹에서 함께 제거했다. 서버 대기열이 손들기 표시의 유일한 기준이다.

### 유지

| 코드                                                                        | 이유                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProtocolParser`의 JSON 트리 검증                                           | Jackson 다형 역직렬화와 Bean Validation으로 바꾸려면 스칼라 강제 변환 차단, 정확한 키 집합(Jackson 3.1.4의 `FAIL_ON_UNKNOWN_PROPERTIES` 기본값은 false), JavaScript 공백·UTF-8 규칙용 사용자 정의 제약, `$.payload...` 오류 경로를 다시 구현해야 하고, 중계 payload의 원본 JSON도 따로 보존해야 한다. TS `validation.ts`와 규칙을 한 줄씩 대응시키는 현재 구조가 계약 확인에 유리하다. |
| `TurnIssuanceLimiter`·`SignalingInboundLimiter`·`ConnectionAdmissionPolicy` | Java·Spring에는 요청 제한 API가 없고 Bucket4j·Resilience4j는 새 의존성이다. 두 제한기는 집계 방식(허용 시에만 증가·재시도 시간 계산 / 거부 프레임 포함·바이트 집계)이 달라 공통화 이득도 작다.                                                                                                                                                                                         |
| 단일 audience `JwtClaimValidator`, `BatonJwsKeySelector`의 `kid` 형식 검사  | 여러 대상용 토큰의 재사용과 임의 `kid`로 인한 JWK 재조회를 막는 정책이다.                                                                                                                                                                                                                                                                                                              |
| `TurnProperties.toString`, `CoturnCredentials`, `StandaloneRoomAccess`      | 비밀값 가리기, TURN REST 규격의 HMAC-SHA1 서명, 상수 시간 비교(`MessageDigest.isEqual`)에 이미 표준 Java API를 사용한다.                                                                                                                                                                                                                                                               |

아래 "유지할 코드"의 기존 판단(송신 디스패처, 자원별 제한, 참여권 만료 재확인, 만료 경계, ECMAScript 공백·UTF-8 길이, 중복 쿠키 거부)도 그대로 유효하다.

### 3차 반영: 2026-10-06

기준 커밋 `a527da9`. 영역별(설정·인증·TURN·시그널링·제한·프로토콜) 탐색과 반박 검증, API 목록 기준 누락 점검을 거쳐
반영했다. 1·2차의 '유지' 판단도 운영 이력 없음을 전제로 다시 따졌다. API 동작은 사용 중인 JAR을 `javap`로 확인했다.

| 위치                                                                  | 이전 구현                                                                                          | 반영 내용                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 준비 상태(`SignalingHealthIndicator`)                                 | 서비스 `running`을 읽는 헬스 지표를 readiness 그룹에 넣었다.                                       | 지표와 `health` 패키지를 지웠다. `ServletWebServerApplicationContext.doClose`가 수명 주기 정지 전에 `ReadinessState.REFUSING_TRAFFIC`를 발행한다. `server.shutdown`·probes·`show-details` 등 Boot 기본값과 같은 설정도 지웠다.                                                                  |
| `SignalingService` 수명 주기                                          | `stop(Runnable)` 재정의, 보조 잠금, 실행기 종료 검사, `isAcceptingConnections()`                   | `SmartLifecycle` 기본 구현과 `isRunning()`을 쓴다. 7.0.8의 `DefaultLifecycleProcessor.doStop`은 `stop()` 예외를 잡아 대기 수를 줄이므로, 재정의는 오히려 예외 때 대기 수를 두 번 줄였다(2차의 '유지' 근거 정정).                                                                                |
| 방 일치 검사(`ParticipationGrantHandshakeInterceptor`, TURN 컨트롤러) | 경로를 `PathPatternParser`로 다시 파싱해 인터셉터와 컨트롤러에서 각각 비교했다.                    | `authorizeHttpRequests(...).access(...)`에서 `RequestAuthorizationContext.getVariables()`의 `roomId`와 참여권을 비교한다. 다른 방 403에는 `BearerTokenAccessDeniedHandler`의 `WWW-Authenticate: Bearer error="insufficient_scope"`가 붙는다. 핸드셰이크 처리기는 인증 주체에서 참여권을 읽는다. |
| 참여권 인증 객체                                                      | `AbstractOAuth2TokenAuthenticationToken`을 직접 상속했다.                                          | `JwtAuthenticationToken(jwt, grant, authorities)`를 쓴다. 참여권 record의 미사용 `studyId`·`issuedAt`과 도달할 수 없는 `ClassCastException` 처리를 지웠다(클레임 검증은 유지). STATELESS 체인의 중복 `requestCache` 비활성화도 지웠다.                                                          |
| 핸드셰이크 처리기·헤더 가림 요청                                      | `Lifecycle`·`ServletContextAware` 전달, `ServletServerHttpRequest` 하위 클래스                     | `StandardWebSocketUpgradeStrategy`가 두 인터페이스를 구현하지 않아 전달을 지웠다. 가림은 `HttpServletRequestWrapper` 하나로 두고 `ServletServerHttpRequest`로 감싼다.                                                                                                                           |
| 클라이언트 주소 키·TURN 요청 정책                                     | 주소→`InetSocketAddress`→주소 변환, 상태 없는 `@Component` 주입                                    | `getRemoteAddr()` 문자열 하나로 키를 만든다(WebSocket 경로의 DNS 조회 가능성 제거). 두 클래스는 정적 함수로 바꿨다.                                                                                                                                                                             |
| 시그널링 게이지                                                       | 상태가 바뀔 때마다 `AtomicX`에 값을 밀어 넣었다.                                                   | `SignalingService`가 `MeterBinder`로 상태를 읽는 게이지를 등록한다. Boot가 자동 바인딩한다.                                                                                                                                                                                                     |
| 수신 제한·연결 거절 지표                                              | 이름이 섞인 카운터 6개와 기록 메서드 6개, 거절 사유별 메서드 4개                                   | `round.signaling.frames.limited{scope,limit}` 하나와 `EnumMap`으로 합쳤다. 경보 규칙과 서버 README를 함께 바꿨다. 연결 거절은 `Rejection` 기준으로 기록한다.                                                                                                                                    |
| 수신 제한기 용량 거절                                                 | 연결 승인과 같은 상한으로 도달할 수 없는 1013 닫기 경로                                            | 경로를 지우고 불변식은 `Assert.state`로 남겼다.                                                                                                                                                                                                                                                 |
| WebSocket 핸들러                                                      | 바이너리 프레임을 집계 후 오류 응답하고, 64KiB 바이너리 버퍼를 연결마다 할당했다.                  | `TextWebSocketHandler`가 1003으로 닫는다. 바이너리 버퍼 설정을 지워 Tomcat 기본 8KiB를 쓴다. pong은 `ByteBuffer.equals`로 비교한다.                                                                                                                                                             |
| `ServerMessageEncoder`                                                | 메시지 9종을 `ObjectNode`로 직접 작성했다.                                                         | 봉투·payload record를 `ObjectMapper.writeValueAsString`으로 직렬화한다. 역할·미디어 종류의 소문자 값은 enum 상수의 `@JsonProperty`로 정한다(`WRITE_ENUMS_TO_LOWERCASE`는 기본 로케일을 써서 쓰지 않는다).                                                                                       |
| `ProtocolParser`·`ClientMessage`                                      | `MalformedJsonException`, 도달할 수 없는 null 분기, 쓰지 않는 `type()`, 방만 담는 메시지 파싱 중복 | 지우거나 공통화했다. 잘못된 JSON 오류 문구는 TS와 같은 `$: must be valid JSON`이다.                                                                                                                                                                                                             |
| TURN                                                                  | 자체 예외 래퍼, 제한 범위 enum의 태그·우선순위 필드, 손으로 고르는 거부 사유                       | `RestClientException`, `MeterProvider`, `Comparator`와 enum 선언 순서를 쓴다.                                                                                                                                                                                                                   |
| 테스트 설정                                                           | 위치 인자 오버로드 9개와 기본값 상수 복제                                                          | `Binder`와 `NoUnboundElementsBindHandler`로 application.yml 기본값에 속성 이름을 덮어쓴다. 설정 경계 검사 6개는 매개변수 테스트로, 인증 설정 생성 복제 3벌은 하나로 합쳤다.                                                                                                                     |

검토 후 반영하지 않은 후보:

- 환경변수 이름을 Boot 표준 이름(`ROUND_SIGNALING_*`)으로 바꾸는 안: BATON 운영 compose가 현재 이름과 단위 없는 숫자를 넣어, 이름을 바꾸면 값이 조용히 무시된다.
- `ProtocolParser`를 Jackson 다형 역직렬화와 Bean Validation으로 바꾸는 안: 위 '유지' 표의 근거가 그대로 유효하다.
- 스터디 명령 action enum화: 일반 switch 문은 망라성 검사를 받지 않아 이득이 없다.
- `RoundJwtDecoderIntegrationTest`의 겹치는 kid·sub 검사 4개 삭제, BATON 테스트 발급자 3벌 통합, `TurnCredentialsTest`의 JSON 계약 중복 검사 삭제: 보안 테스트 변경이라 이번 작업에서 진행하지 않았다.

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

## 4. 메트릭 등록 시 공통 설정을 공유한다

위치: [SignalingMetrics 생성자](../apps/signaling/src/main/java/com/personal/round/signaling/SignalingMetrics.java#L56)

입장 거절 지표 4개와 연결 거절 지표 6개의 등록을 Micrometer의 `MeterProvider<Counter>` 두 개로 합쳤다. 지표별 이름·설명을 공통 설정하고 `withTag()`로 각 카운터를 생성한다. 사용하는 Micrometer 1.17.0 JAR에서 `withRegistry()`와 `withTag()` 지원을 확인했다. [Micrometer MeterProvider 문서](https://docs.micrometer.io/micrometer/reference/1.18/concepts/meter-provider.html)

- 변경: 생성자에서 지표별 공통 설정을 한 번 정의하고 기존 `Counter` 필드에 태그별 카운터를 넣는다.
- 유지: 지표명, 태그 값, 기존 증가 메서드, 시작 시 값이 0인 카운터도 등록되는 동작.
- 효과: 반복되는 등록 코드를 줄인다. 생성자에서 한 번 실행되는 코드이므로 처리 성능 개선 효과를 기대하는 변경은 아니다.
- 확인: 초기 등록 테스트와 기존 입장·연결 거절 테스트의 카운터 값 검사를 통과했다.

검증 로직에서 추가로 제거할 만한 확실한 중복은 찾지 못했다.

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

4번 반영 시 초기 등록·연결 제한·방 권한 관련 테스트 19개를 실행해 모두 통과했다. 지표명·태그와 초기값 0을 유지하며, 운영 코드는 23줄 줄었다.
