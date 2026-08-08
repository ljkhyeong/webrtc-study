# ADR 0001: ROUND를 BATON과 독립된 실시간 통신 서비스로 유지한다

- 상태: 승인
- 결정일: 2026-07-29
- 개정일: 2026-07-31 (RS256/JWK 참여권 계약과 인증 경계 검증)

## 맥락

ROUND는 별도 저장소에서 웹 클라이언트, Java signaling 서버, WebRTC 프로토콜과 코어,
coturn 배포 구성을 함께 관리한다. BATON에 스터디 기능을 붙일 때 기존 signaling 코드를
BATON 애플리케이션 내부로 옮길 수도 있지만, 그렇게 하면 실시간 연결 수명주기와 BATON의
회원·스터디 도메인 수명주기가 같은 배포 단위에 묶인다.

반대로 ROUND가 BATON의 데이터베이스나 엔티티를 직접 참조하거나 signaling 프레임마다
BATON API에 권한을 질의하면 두 서비스가 사실상 동시에 가용해야 한다. WebSocket 연결이
이미 성립한 뒤에도 BATON의 지연과 장애가 SDP/ICE 교환에 전파되고, BATON 내부 모델 변경이
ROUND 배포를 요구하게 된다.

따라서 저장소와 런타임을 분리한 채 BATON의 권한 판정 결과를 짧은 수명의 서명된 참여권으로
전달하는 경계가 필요하다.

## 결정

### 서비스와 데이터 소유권

ROUND는 BATON과 별도 저장소, 배포, 런타임을 유지한다. 각 서비스의 소유권은 다음과 같다.

| 서비스 | 소유하는 정보와 책임                                                           |
| ------ | ------------------------------------------------------------------------------ |
| BATON  | 사용자 신원, 스터디, 스터디 참여 권한, 일정, 참여권 발급                       |
| ROUND  | 휘발성 room·peer 상태, WebSocket signaling, SDP/ICE 전달, TURN credential 발급 |

ROUND는 BATON 데이터베이스 또는 엔티티를 공유하지 않는다. WebSocket 프레임마다 BATON에
동기 API 호출을 하지 않으며, BATON이 발급한 참여권을 ROUND가 로컬에서 검증한다. 미디어와
DataChannel 채팅은 계속 브라우저 사이를 직접 흐르고 ROUND 애플리케이션에 저장되지 않는다.
BATON 참여권으로 발급하는 TURN credential의 만료는 참여권 `exp`보다 늦지 않게 제한한다.

### 공개 경로와 내부 경로

BATON과 ROUND는 브라우저에서 같은 Origin으로 보이도록 edge proxy 뒤에 배치한다. 외부
경로와 ROUND 내부 경로의 계약은 다음과 같다.

| 용도                | 브라우저가 사용하는 외부 경로                       | 처리 경계                               |
| ------------------- | --------------------------------------------------- | --------------------------------------- |
| 참여권 갱신         | `/round/rooms/{roomId}/participation-grant/refresh` | BATON이 직접 처리하며 ROUND로 전달 금지 |
| WebSocket signaling | `/round/rooms/{roomId}/signal`                      | `/rooms/{roomId}/signal`                |
| TURN credential     | `/round/rooms/{roomId}/turn-credentials`            | `/api/rooms/{roomId}/turn-credentials`  |

edge proxy는 signaling과 TURN 외부 경로만 대응하는 ROUND 내부 경로로 전달한다. 이 두
요청의 `roomId`는 공개 경로, 내부 경로, 참여권 claim에서 같은 값이어야 한다.

BATON은 참여권을 URL query parameter나 브라우저 저장소에 노출하지 않고 다음 속성의
쿠키로 전달한다.

- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- `Path=/round/rooms/{roomId}`
- `Domain` 속성 생략(host-only)

방별 쿠키 경로는 같은 브라우저가 여러 방을 열었을 때 다른 방의 참여권이 signaling 또는
TURN 요청에 실리는 것을 방지한다. WebSocket upgrade와 TURN credential POST에는 기존의
정확한 Origin 검사도 계속 적용한다.

### 참여권 갱신 계약

BATON은 `POST /round/rooms/{roomId}/participation-grant/refresh`에서 인증된 사용자 신원과
현재 스터디 멤버십을 다시 확인한다. 유효하면 새 `jti`와 만료 시각으로 위 방별 쿠키를
회전하고 `Cache-Control: no-store`와 함께 다음 두 숫자 필드만 반환한다.

```json
{
  "expiresAt": 1780000000,
  "refreshAfterSeconds": 240
}
```

JWT는 응답 본문이나 JavaScript에 반환하지 않는다. BATON은 정확한 동일 출처 `Origin`과
`Sec-Fetch-Site: same-origin`을 요구하고 CORS를 허용하지 않는다. 브라우저는
`1..300` 범위의 `refreshAfterSeconds`만 받아 monotonic clock 기반 상대 시간으로
사용하며, 로컬 wall clock과 `expiresAt`의 차이로 갱신 시점을 다시 계산하지 않는다.
중복 타이머와 TURN·WebSocket의 동시 선행 확인은 single-flight 갱신 하나로 합친다.

### 참여권 계약

BATON은 개인키로 짧은 수명의 JWT 참여권을 `RS256`으로 서명하고 JOSE header에 공개키를
식별하는 `kid`를 포함한다. ROUND는 BATON JWK Set의 대응 공개키로 오프라인 검증하며
`RS256` 외의 알고리즘을 허용하지 않는다. 공유 대칭키로 BATON과 ROUND 모두가 토큰을
발급할 수 있게 만들지 않는다.

키를 교체할 때 BATON은 새 공개키를 JWK Set에 먼저 추가한 뒤 새 `kid`로 발급을 전환한다.
기존 공개키는 이전 키로 발급한 참여권의 최대 수명과 clock skew가 모두 지난 뒤 제거한다.
ROUND에는 개인키를 배포하지 않으며, JWK Set cache가 갱신될 수 있도록 두 공개키의
중첩 기간을 실제 배포에서 리허설한다.

참여권에는 다음 claim이 반드시 있어야 한다.

| claim      | 의미                              |
| ---------- | --------------------------------- |
| `iss`      | 신뢰하도록 설정한 BATON issuer    |
| `aud`      | 고정값 `round`                    |
| `sub`      | BATON 사용자 식별자               |
| `exp`      | 참여권 만료 시각                  |
| `iat`      | 참여권 발급 시각                  |
| `jti`      | 참여권 고유 식별자                |
| `room_id`  | 입장할 ROUND 방 식별자            |
| `study_id` | 권한을 판정한 BATON 스터디 식별자 |
| `role`     | `host` 또는 `participant`         |

ROUND는 `RS256` 서명과 JWK 공개키, `iss`, `aud`, 만료 시각, 필수 claim의 존재와 형식을
모두 검증한다. HTTP 검증과 WebSocket lease는 같은 `Clock`을 사용하며 `exp`에는 clock
skew를 허용하지 않는다. 60초 허용치는 미래 `iat`에만 적용하고, 기본 5분인 최대 참여권
수명보다 긴 `exp - iat`도 거부한다. URL 경로의 `roomId`와 `room_id`가
다르면 WebSocket upgrade 및 TURN credential 요청을 거부한다. WebSocket 연결 후에는
검증된 참여권 정보를 세션에 보존하고 `room.join`의 방 식별자도 경로 및 `room_id`와
일치할 때만 입장을 허용한다.

검증된 참여권은 WebSocket 연결 당시의 immutable active lease가 된다. ROUND는 연결 직후,
inbound quota 차감 전, outbound enqueue 전, heartbeat와 1초 주기 sweep에서 이를 확인한다.
wall clock의 `exp`와 연결 시점에 고정한 monotonic 남은 수명 중 먼저 도달한 시점에 기존
disconnect 경로로 상태를 한 번만 정리하고 `4001 / Participation grant expired`로 닫는다.
따라서 시스템 시계가 뒤로 이동해도 lease가 늘어나지 않는다. standalone 연결에는 만료
lease를 적용하지 않는다.

ROUND는 활성 handshake와 WebSocket에 한해 동일 `jti`의 동시 사용을 1개로 제한한다.
연결이 종료되면 저장 상태도 제거하므로 만료 전 순차 재사용까지 막는 replay 저장소는
아니다. 따라서 `jti`는 동시 replay 제한, 추적과 향후 회수 기능을 위한 식별자이며
one-time 사용을 보장하지 않는다. 문서와 구현에서 참여권을 one-time ticket으로 표현하지
않는다.

동일 `(room_id, sub)`는 서로 다른 `study_id`나 `jti`를 사용하더라도 활성 handshake와
WebSocket을 합쳐 2개까지만 허용한다. ROUND의 실제 room 경계는 `room_id`이므로
`study_id`가 달라져도 같은 room의 제한을 분리하지 않는다. 두 번째 슬롯은 BATON이 새
`jti`의 참여권을 갱신한 뒤 재연결이 기존 socket과 잠시 겹치는 경우를 위한 것이다. 동일
참여권의 두 번째 연결 또는 사용자-방의 세 번째 연결은 HTTP 429로 거부하며 handshake
승인만으로 기존 socket을 종료하지 않는다. 두 승인 연결이 `room.join`을 시도하면 단일
room lock 안에서 더 최근 연결만 남긴다. 기존 peer 또는 뒤늦게 입장한 오래된 연결은 정상
disconnect 경로로 정리하고 `4002 / Participation session superseded`로 닫는다. 브라우저는
이 정책 종료를 자동 재연결하지 않으므로 두 연결의 상호 인계 반복을 막는다. reservation은
`room.leave`가 아니라 socket 종료 시 해제된다. 인계에서 밀려난 연결의 reservation은
터미널 close 시도가 끝날 때까지 유지하여 close가 막힌 틈에 세 번째 연결이 들어오지 못하게
하고, close가 I/O 실패를 보고해도 그 직후 정확히 한 번 해제한다. 이 정책은 BATON 모드에만
적용한다.

`peerId`와 relay 메시지의 `from`은 계속 ROUND가 생성한다. BATON 사용자 식별자나 클라이언트
입력값을 signaling 발신자 식별자로 신뢰하지 않는다.

### 인증 모드

ROUND는 다음 두 운영 모드를 구분한다.

- `standalone`: 현재의 Caddy 공유 접근 credential을 유지한다. 이는 소규모 파일럿 접근
  통제이며 사용자 신원이나 스터디 멤버십을 증명하지 않는다.
- `baton`: 유효한 참여권이 없는 WebSocket upgrade와 TURN credential 요청을
  fail-closed로 거부한다. 검증 키나 issuer 같은 필수 설정이 누락된 상태로 인증을
  우회하지 않는다.

BATON 장애 중에도 이미 연결된 WebSocket의 signaling은 BATON 동기 호출 없이 현재
참여권 `exp`까지 계속된다. 갱신하지 못한 socket은 만료 시 `4001`로 닫히고, 새 참여권
발급과 재연결은 BATON이 복구될 때까지 fail-closed다.

## 결과

### 장점

- BATON의 도메인 모델과 ROUND의 실시간 연결 모델을 독립적으로 변경하고 배포할 수 있다.
- BATON 데이터베이스 장애와 요청 지연이 개별 SDP/ICE 프레임 전달에 전파되지 않는다.
- 비대칭 서명으로 ROUND는 참여권 검증 권한만 가지며 BATON 사용자 권한을 새로 발급할 수
  없다.
- 방별 경로와 쿠키 범위가 다중 방 참여권 혼선을 줄인다.
- 향후 다른 애플리케이션도 같은 참여권 계약으로 ROUND를 사용할 수 있다.

### 비용과 제약

- BATON의 참여권 발급, edge 경로 변환, ROUND의 Spring Security 검증 설정을 함께
  운영해야 한다.
- BATON과 ROUND 사이에 JWT claim, 공개키 교체, 경로 호환성 계약이 생긴다.
- 배포 전 두 서비스의 계약 호환성을 통합 테스트해야 한다.
- 호환 배포는 BATON 신원·멤버십·갱신 endpoint와 edge, 선갱신 web bundle, ROUND active
  lease 순서로 진행해야 한다. 롤백은 역순으로 한다.

## 알려진 잔여 위험

- ROUND의 room과 peer 상태는 메모리에 있으며 signaling은 단일 인스턴스로 운용한다. 여러
  인스턴스로 확장하려면 shared room registry, 방 라우팅과 노드 간 signaling relay가 먼저
  필요하다.
- BATON의 멤버십 회수는 ROUND에 push되지 않으므로 브라우저의 다음 갱신 또는 현재 참여권
  `exp`까지 반영이 지연될 수 있다. 더 즉각적인 회수가 필요하면 별도 revocation 채널이
  필요하다.
- 탈취된 참여권은 만료 전까지 사용할 수 있다. TLS, `HttpOnly`, `Secure`,
  `SameSite=Strict`, 방별 cookie path와 짧은 만료 시간을 함께 적용한다. 동일 `jti`의
  동시 연결 제한은 두 번째 연결을 막지만, 공격자가 먼저 슬롯을 차지하거나 정상 연결이
  종료된 뒤 만료 전에 순차 재사용하는 위험까지 제거하지는 않는다.
- 참여자 연결 제한과 `(room_id, sub)`별 TURN credential 발급 quota는 현재 단일 ROUND
  프로세스의 메모리에만 존재한다. 다중 인스턴스 전환 시에는 shared room state와 함께
  분산 admission·quota registry를 도입해야 한다.
- TURN의 참가자 quota는 한 참여자가 새 `jti` 또는 IP로 공유 발급량을 독점하는 위험을
  줄이지만, 이미 발급받은 credential 공유나 하나의 credential을 이용한 여러 relay
  allocation까지 막지는 않는다. IP·서버 전체 발급 quota와 coturn의 사용자·전체
  allocation quota를 함께 유지해야 한다.

## 검토했지만 채택하지 않은 대안

- **signaling 코드를 BATON 내부로 이동:** 독립 배포와 장애 격리 이점을 잃고 BATON의
  애플리케이션 수명주기에 실시간 연결을 결합하므로 채택하지 않는다.
- **ROUND가 BATON DB 또는 엔티티를 공유:** 데이터 소유권이 흐려지고 스키마 변경이 공동
  배포를 강제하므로 채택하지 않는다.
- **프레임마다 BATON에 권한 질의:** BATON 장애와 지연이 signaling hot path에 전파되므로
  채택하지 않는다.
- **장기 bearer token을 WebSocket URL에 전달:** 브라우저 기록, proxy와 접근 로그에
  노출될 수 있으므로 채택하지 않는다.
