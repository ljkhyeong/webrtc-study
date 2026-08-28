# ROUND 파일럿 릴리스 체크리스트

아래의 모든 P0 항목에 담당자, 날짜, 통과 결과가 기록된 뒤에만 ROUND를 스터디 그룹 파일럿에
사용할 수 있습니다. 자동화한 브라우저 미디어 stub은 회귀 테스트에 유용하지만 이 문서의 실제
장치 검사를 대체하지는 않습니다.

이 체크리스트는 저장소에서 관리하는 standalone Compose를 검증합니다. `compose.yml`은 의도적으로
`ROUND_AUTH_MODE=standalone`으로 고정되어 있으므로 이 검사 결과를 BATON 배포의 증거로 표시하지
마세요. BATON을 사용하는 스터디는 이 문서 마지막의 별도 연동 gate도 통과해야 합니다.

검사할 standalone edge 정책을 기록하세요. Linux 프로덕션 `compose.yml`은 정적 앱, `/signal`,
`/api/turn-credentials`를 하나의 공유 Basic Auth 경계 뒤에 둡니다. 임시 macOS Docker Desktop
override는 `Caddyfile.macos-pilot`을 사용합니다. 이 구성에서는 UI와 정적 asset만 Basic Auth 뒤에
남고 두 브라우저 전송 경로는 모바일 호환성을 위해 의도적으로 이를 우회합니다. **Linux
standalone** 또는 **macOS pilot**이라고 명시한 항목은 해당 토폴로지에만 적용합니다. 한 정책의
증거를 다른 정책에 복사하지 마세요.

## 릴리스 후보

- [ ] 릴리스 commit은 변경할 수 없으며 tag가 지정되어 있습니다.
- [ ] GitHub artifact attestation 제공 범위를 확인했습니다. 저장소가 공개이거나, 비공개 또는
      internal 저장소라면 GitHub Enterprise Cloud 소유 구조여야 합니다. 현재와 같은 비공개 개인
      저장소에서는 이 조건을 충족하기 전 `release-images`를 실행하지 않습니다.
- [ ] 기본 브랜치 HEAD의 annotated tag와 동일 SHA의 CI 성공을 확인한 뒤 `release-images`
      `repository_dispatch` 조정자가 통과하고 일반 edge, relay-only edge, signaling, TURN
      manifest digest를 기록합니다.
- [ ] 깨끗한 checkout에서 `npm run check`가 통과합니다.
- [ ] 프로덕션 Compose 구성이 누락된 변수 없이 rendering됩니다.
- [ ] 임시 dummy fixture로 `ops/ci/validate-deployment.sh`가 통과합니다.
- [ ] 이전 immutable 이미지 세트를 rollback에 사용할 수 있습니다. 첫 파일럿에서는 알려진 정상
      배포 이미지 세트가 생길 때까지 서비스 종료와 DNS 제거를 명시적인 rollback으로 기록합니다.
- [ ] signaling 서비스가 정확히 replica 하나로 설정되어 있습니다.

## 공개 네트워크 경로

- [ ] HTTP가 HTTPS로 redirect됩니다.
- [ ] 평문 HTTP에서는 HTTP Basic Auth를 절대로 허용하지 않으며 웹 앱이 mixed-content 경고 없이
      HTTPS로 로드됩니다.
- [ ] **두 토폴로지 모두:** 공유 credential이 없거나 올바르지 않으면 UI와 정적 asset에 `401`을
      반환하고 `/healthz`는 공개 상태를 유지합니다.
- [ ] **Linux standalone 전용:** 공유 credential이 없거나 올바르지 않으면 `/signal`과
      `/api/turn-credentials`에도 `401`을 반환합니다.
- [ ] **macOS pilot 전용:** 정책상 `/signal`과 `/api/turn-credentials`가 Basic Auth를 우회하는지
      확인합니다. 이 경로에 `401`을 요구하거나 기록하지 마세요. 이 단기 노출의 수용 여부를
      기록하고 애플리케이션이 외부, 누락, wildcard, HTTPS가 아닌 Origin을 계속 거부하는지
      확인합니다.
- [ ] 한 client 네트워크에서 credential을 포함한 요청을 5분 안에 96회 넘게 보내면 `429`를
      반환하고, header가 없는 challenge와 `/healthz`는 이 고비용 인증 예산을 소모하지 않습니다.
- [ ] 실제 파일럿 host에 논리 CPU가 2개 이상인 상태에서, 선택한 토폴로지에서 Basic Auth가 필요한
      UI/정적 경로를 대상으로 문법상 올바른 Basic 요청 96개를 동시에 보냅니다. username은 모두
      서로 다르고 Caddy 사용자 map에 없는 것을 확인하며 password도 모두 다르게 합니다. 이렇게
      하면 더 저렴한 설정 사용자 cost-12 경로 대신 cost-14 미등록 사용자 fake-hash 경로를
      확실히 사용합니다. 실제 참가자 6명이 대표적인 peak session을 유지하는 동안 burst를
      실행하고, TURN과 signaling이 파일럿 peak를 함께 처리하도록 가능하면 relay-only 이미지를
      사용합니다. edge와 host의 CPU 및 memory, container restart, signaling 직접 `/healthz`, 공개
      `/healthz`, 두 번째 네트워크에서 올바르게 인증한 요청을 기록합니다. 참가자 6명 모두의 audio,
      video, chat 연결이 유지되어야 하고, 두 health 요청과 두 번째 네트워크의 요청은 5초 안에
      완료되어야 하며, container가 restart되거나 OOM-kill되어서는 안 됩니다. 잘못된 요청이 끝난
      뒤 3분 안에 모든 측정값이 테스트 전 범위로 돌아와야 합니다. 공격 네트워크가 남은 5분
      window 동안 의도적으로 계속 제한된다는 점을 기록합니다. 노출 전에 이 standalone 파일럿의
      잔여 위험을 명시적으로 수용합니다.
- [ ] **Linux standalone 전용:** Basic Auth로 인증한 `wss://<domain>/signal`이 정확한 프로덕션
      Origin을 허용하고 Basic Auth로 인증한 TURN credential POST가 성공합니다.
- [ ] **macOS pilot 전용:** `wss://<domain>/signal`과 TURN credential POST가 Authorization
      header에 의존하지 않고 정확한 프로덕션 Origin을 허용합니다. probe에서 공유 credential을
      제공해도 이 우회 경로가 이를 인증했다는 증거가 되지는 않습니다.
- [ ] 외부, 누락, wildcard, HTTPS가 아닌 Origin을 signaling 애플리케이션 경계에서 거부합니다.
- [ ] 공개 인터넷에서 signaling container 포트에 직접 접근할 수 없습니다.
- [ ] 배포 env에는 bcrypt cost-12 password hash만 저장합니다. 평문 공유 password는 Git, 이미지,
      shell history, log에 없어야 하며 signaling으로 proxy하기 전에 `Authorization`을 제거합니다.
- [ ] 공유 credential을 별도 경로로 전달했고 유출 및 회전 절차를 예행했으며, BATON의 신원 및
      스터디 멤버십 authorization이 이를 대체할 때까지 임시 수단이라는 점을 팀이 수용합니다.
      macOS pilot에서는 이 credential이 두 전송 경로가 아닌 UI/정적 전달만 보호한다는 점도
      기록합니다.
- [ ] TURN shared secret은 Git, 이미지 history, 브라우저 bundle, access log, 애플리케이션 log에
      없습니다.
- [ ] 초대 경로를 방문해도 Caddy access log에 방 코드가 남지 않습니다. 동시에 공유 인증 `401`과
      rate-limit `429`를 포함한 모든 경로는 header와 URI를 제거하고 client 주소를 hash한 상태로
      status를 통해 계속 관측할 수 있습니다.

## Relay-only 테스트

서로 다른 네트워크에 있는 물리 장치 두 대에서 이 테스트를 실행합니다. 한 장치는 가정용 Wi-Fi를,
다른 장치는 cellular tethering이나 다른 ISP를 사용해야 합니다.

- [ ] signaling 또는 TURN 이미지 digest를 변경하지 않고 릴리스 workflow의 `-relay` edge 이미지를
      배포합니다.
- [ ] 두 참가자가 서로 보고 들을 수 있습니다.
- [ ] 순서가 보장되는 DataChannel chat이 양방향으로 동작합니다.
- [ ] 원격 브라우저에 메시지가 표시된 뒤에만 각 발신자의 **전송 확인 중** 상태가 끝납니다. 한
      수신자가 연결을 닫거나 timeout되면 이미 ACK한 수신자에게 다시 전송하지 않고 부분 또는 실패
      수신 확인 상태가 됩니다.
- [ ] 릴리스 후 모든 참가자가 web client를 reload합니다. 의도적으로 남겨 둔 ACK 이전 버전의
      client는 성공을 잘못 표시하지 않고 45초 수신 확인 deadline에 fail-closed합니다.
- [ ] `RTCPeerConnection.getStats()`에서 선택된 candidate pair의 local candidate type이 `relay`로
      표시됩니다.
- [ ] UDP relay가 성공합니다.
- [ ] UDP를 차단했을 때 TCP 또는 TLS relay fallback이 성공합니다.

## 권한 및 장치 동작

- [ ] 명시적인 사용자 동작 전에 초대 링크를 열어도 미디어 권한을 요청하거나 WebSocket을 열지
      않습니다.
- [ ] 입장 전 화면에서 선택한 camera를 미리 보여 줍니다.
- [ ] 입장 후 선택한 camera와 microphone을 사용합니다.
- [ ] 사용자가 **화면 공유**를 누른 뒤에만 화면 공유 prompt가 표시되고, 원격 참가자에게 보내는
      camera를 대체하며, ROUND의 공유 중지 버튼과 브라우저의 기본 공유 중지 동작 모두에서 camera를
      복원합니다.
- [ ] display picker를 거부하거나 취소해도 기존 camera 통화를 계속 사용할 수 있고 방을 끝내지 않은
      채 한국어로 다음 동작을 안내합니다.
- [ ] camera를 거부했거나 사용할 수 없어도 audio-only 입장을 허용합니다.
- [ ] microphone을 거부했거나 사용할 수 없어도 video-only 입장을 허용합니다.
- [ ] 사용자가 장치 설정을 다시 시도하거나 의도적으로 미디어 없이 입장할 수 있습니다.
- [ ] 권한, 장치 누락, 장치 사용 중 오류는 가공하지 않은 브라우저 예외 대신 한국어로 다음 동작을
      안내합니다.
- [ ] 물리 공간마다 활성 microphone/speaker pair를 하나만 두거나 headphone을 사용해 acoustic echo를
      테스트합니다. 브라우저 echo cancellation 활성화만으로 통과한 것으로 보지 않습니다. 가까운
      두 번째 장치를 mute하거나 연결 해제해 들리던 echo가 사라지는지 확인합니다.

## 방장 관리 동작

- [ ] 설정한 standalone 방장 key는 공유 Basic Auth password와 달라야 하고 최소 32개의 random
      byte를 포함해야 하며, runtime env에는 SHA-256 digest로만 존재해야 합니다. 평문은 Git, 이미지,
      URL, 브라우저 storage, log, shell history에 없어야 합니다.
- [ ] 운영자는 하나의 standalone digest가 이 signaling instance의 모든 방에 적용된다는 점을
      수용하고, 유출 시 이를 회전한 뒤 signaling을 restart하고 허용된 방장을 다시 연결하는 절차를
      예행했습니다.
- [ ] 유효한 방장이 다른 참가자의 microphone이나 camera를 끌 수 있고, 두 브라우저 모두 변경된
      상태와 명확한 관리 알림을 표시합니다.
- [ ] 참가자, 올바르지 않은 방장 key, 자기 자신인 대상, 방장인 대상, 나간 대상, 다른 방의 대상을
      거부하며 어떤 미디어 상태도 변경하지 않습니다.
- [ ] 어떤 UI나 프로토콜 경로도 다른 사람의 microphone, camera, screen을 원격으로 켤 수 없습니다.
      영향을 받은 참가자는 비활성화된 장치를 의도적으로 다시 켤 수 있습니다.
- [ ] 대상이 화면을 공유하는 동안 video를 비활성화하면 display capture가 중지되고 복원된 camera는
      비활성 상태로 남습니다.
- [ ] 변조한 mesh client는 비활성화 요청을 무시할 수 있음을 팀이 수용합니다. 악의적인 참가자를 더
      강하게 제어하는 기능은 kick/ban이나 SFU가 소유하는 미디어 전달이 생길 때까지 미룹니다.

## 복구 동작

- [ ] signaling 연결, 방 입장, peer 연결에는 각각 제한된 timeout이 있으며 어떤 spinner도 무한정
      기다리지 않습니다.
- [ ] Wi-Fi와 hotspot 사이를 전환해도 페이지를 새로고침하지 않고 복구됩니다.
- [ ] 10초 동안 네트워크가 끊긴 뒤 연결이 돌아오면 15초 안에 복구됩니다.
- [ ] signaling 프로세스를 restart하면 제한된 자동 재입장이 시작됩니다.
- [ ] 복구 후 중복 참가자 tile이나 ghost 방 슬롯이 남지 않습니다.
- [ ] **나가기**를 선택하면 모든 재연결 및 ICE 복구 timer를 취소합니다.
- [ ] 모든 재시도를 소진하면 **재연결**과 **나가기** 동작을 표시합니다.

## 브라우저 및 장치 조합표

사용한 브라우저와 OS의 정확한 version을 기록합니다.

| 장치                  | 브라우저    | 2명 | 4명 | 6명 | 백그라운드/포그라운드 |
| --------------------- | ----------- | --- | --- | --- | --------------------- |
| 데스크톱 또는 노트북  | Chrome/Edge | [ ] | [ ] | [ ] | N/A                   |
| macOS                 | Safari      | [ ] | [ ] | [ ] | N/A                   |
| iPhone/iPad           | Safari      | [ ] | [ ] | [ ] | [ ]                   |
| Android 휴대폰/태블릿 | Chrome      | [ ] | [ ] | [ ] | [ ]                   |

표시한 모든 칸에서 입장, 원격 audio/video, 화면 공유 시작/중지, chat, mute, camera 전환, 방장의
비활성화 전용 제어, 나가기, 재입장, 초대 복사 동작을 확인하고 예상하지 못한 console 오류가 하나도
없는지 검증합니다.

## 용량 및 장시간 테스트

- [ ] 참가자 2명과 4명이 각각 최소 30분 동안 연결을 유지합니다.
- [ ] 실제 참가자 6명이 최소 90분 동안 연결을 유지합니다.
- [ ] 참가자 2명의 relay-only session이 4시간 동안 연결을 유지합니다.
- [ ] relay-only 참가자 6명이 coturn의 `user-quota`, `total-quota`, relay 포트 고갈 없이 동시에
      입장할 수 있고, 기본값을 변경하기 전에 관측한 allocation 수를 기록합니다.
- [ ] 6명 video가 문서화한 저대역폭 capture 정책을 사용하고 알아들을 수 있는 audio를 유지합니다.
- [ ] RTT, packet loss, 송신 bitrate, 프로세스 memory, 열린 file descriptor, TURN egress를
      기록합니다.
- [ ] 브라우저 crash, 무제한 queue 증가, ghost peer, 원인을 설명할 수 없는 disconnect가 발생하지
      않습니다.

## 운영

- [ ] `docker compose up -d --wait --wait-timeout 120`이 로컬 signaling, edge, TURN listener의 시작
      gate를 통과합니다.
- [ ] TURN host와 그 NAT 외부의 네트워크에서 secret store의 monitor 입력과 새로 발급한 단기 TURN
      credential을 사용해 외부 TURN probe의 UDP, TCP, TLS 검사가 통과합니다.
- [ ] **Linux standalone 전용:** probe의 HTTPS credential fetch를 공유 Basic Auth gate가 monitor
      account를 허용했다는 증거로 기록합니다.
- [ ] **macOS pilot 전용:** 같은 probe를 정확한 Origin의 credential 발급과 coturn 인증 및 relay의
      증거로 기록하며 공유 Basic Auth의 증거로 기록하지 않습니다. 정적 UI의 `401`과 전송 Origin
      거부는 별도로 검증합니다.
- [ ] 기본 branch 규칙이 외부 TURN workflow, target property, probe, TLS 검증 및 resolver script,
      workflow 계약 validator/test에 pull request와 code owner review를 요구합니다. 저장소 plan이
      해당 제어를 지원하는 경우 self-review와 관리자 우회를 비활성화합니다.
- [ ] `external-pilot-target.properties`에는 commit된 예시 host 대신 검토한 공개 ROUND Origin, TURN
      host, `coturn/coturn@sha256` digest가 들어 있습니다.
- [ ] `round-pilot` GitHub environment는 기본 branch만 허용하고, 공유 접근 값과 선택적인 private CA
      값만 secret으로 저장하며, 지원되는 경우 self-review가 비활성화된 reviewer를 요구합니다.
- [ ] 수동 `External TURN pilot probe` workflow가 운영자가 선언한 annotated 릴리스 tag에서
      통과합니다. 실행 요약에는 tag object, 릴리스와 workflow commit, 정확한 target, probe 이미지
      digest, 인증된 UDP, TCP, TLS 결과를 기록합니다.
- [ ] `round-external-turn-pilot-evidence` JSON artifact를 보관합니다. `result=passed`, 실행 URL,
      릴리스·workflow commit, target, probe 이미지와 세 전송 방식이 기록되고,
      `deploymentIdentityVerified=false`인지 확인합니다.
- [ ] 기록한 릴리스와 tag object를 배포 revision 또는 immutable 이미지 게시 증거와 별도로
      대조합니다. `v*` tag ruleset은 릴리스 tag의 갱신과 삭제를 막습니다.
- [ ] TLS probe가 certificate chain과 `TURN_PROBE_HOST`를 모두 검증합니다. 신뢰하지 않는
      certificate나 hostname 불일치는 relay traffic을 시도하기 전에 배포 gate를 실패시킵니다.
      검증을 비활성화하는 대신 private CA를 snapshot하고 host verifier와 coturn utility container가
      모두 사용합니다.
- [ ] 자동 promotion gate나 프로덕션 alert가 생길 때까지 0이 아닌 외부 TURN probe 결과를 수동
      파일럿 중단 조건으로 강제합니다.
- [ ] edge `/healthz`와 로컬 STUN listener를 공개 TURN 인증이나 relay media 상태의 증거로 인정하지
      않습니다.
- [ ] 방과 peer의 활성 수, 거부한 연결과 입장, 잘못되었거나 session/client/global 제한을 받은
      frame, queue overflow, heartbeat 종료를 방 ID, 이름, SDP, ICE candidate, chat text를 기록하지
      않고 관측할 수 있습니다.
- [ ] graceful SIGTERM은 새 입장을 거부하고 기존 socket을 restart에 적합한 code로 닫은 뒤 설정된
      timeout 안에 종료됩니다.
- [ ] 이전 이미지를 5분 안에 복원하고 smoke test할 수 있습니다.

## 파일럿 단계

1. maintainer가 함께 있는 상태에서 2~3명 파일럿을 실행합니다.
2. 모든 P0 문제를 수정하고 실패한 scenario를 반복합니다.
3. 의도한 그룹과 최대 6명의 전체 스터디 session을 실행합니다.
4. 수동 페이지 새로고침이나 원인을 설명할 수 없는 미디어 손실 없이 전체 session이 끝난 경우에만
   promotion합니다.

녹화, 영속 chat, account, 악의적인 client의 미디어 제어, 6명보다 큰 방은 명시적으로 이 파일럿
gate의 범위 밖입니다. BATON 연동은 위의 standalone gate 범위 밖이며 아래의 필수 검사를 별도로
적용합니다.

## BATON 연동 gate

BATON이 소유한 edge와 별도로 배포한 ROUND instance를 대상으로 다음 검사를 실행합니다. 이를
실행하려고 bundle된 standalone Compose를 변경하지 마세요.

### 2026-07-31 로컬 리허설 증거(프로덕션 승인 아님)

- [x] 프로덕션 이미지, Caddy local-CA HTTPS, mock OIDC, 실제 MySQL session과 활성 OWNER/MEMBER
      membership, BATON RS256/JWK, BATON 모드 web/signaling, 로컬 coturn을 BATON 소유 edge 뒤에
      구성했습니다.
- [x] 격리된 Chromium identity 두 개가 refresh 200, TURN credential 200, WSS 입장, relay-only로
      선택된 UDP candidate pair, 양방향 audio/video traffic, ACK된 chat, 원격 미디어 상태 전파,
      정상 나가기를 완료했습니다.
- [x] 강화된 생명주기를 Spring `configtree`용 read-only TURN secret mount 하나로 다시
      실행했습니다. coturn은 같은 secret을 tmpfs runtime config에 복사했습니다. container argv,
      environment, log에 secret이 없었고, 정리 후 남아 있는 project container, volume, network가
      하나도 없음을 확인했습니다.
- [x] 로컬 안전성 suite는 안전하지 않거나 symlink되었거나 위조된 상태, Compose 2.24.3, stale
      volume/network, 주위 Compose override, 실패한 정리를 거부하며 SIGINT/SIGTERM은 130/143을
      반환합니다.
- [ ] 이 로컬 증거에는 실제 Google OIDC, Naver OAuth 2.0, 로컬 verified-email login, 하나의 BATON
      `Account.id`를 유지하는 identity 연결, 공개 DNS/ACME, 실제 미디어 장치, 공개
      TURN/NAT/firewall 동작, TCP/TLS relay fallback, 외부 네트워크, key 회전, 참여권 수명 두 번,
      장시간 session 안정성, 6명 부하가 포함되지 않습니다.

아래의 미완료 프로덕션 gate가 계속 최종 기준입니다.

- [ ] BATON에 실제 인증된 사용자 identity와 현재 스터디 멤버십 authorization이 있습니다. 참여권의
      `sub`는 재할당되지 않는 canonical BATON `Account.id`입니다. Google OIDC `sub`, Naver profile
      ID, email, 공유 access key, 표시 이름이나 다른 client claim을 `sub`로 사용하지 않습니다.
- [ ] 실제 Google, Naver, 검증된 로컬 email account가 각각 참여권 refresh, TURN 발급, WSS 입장을
      완료합니다. 이러한 identity를 하나의 BATON account에 명시적으로 연결하면 같은 JWT `sub`가
      유지되고 email이나 연결된 login provider를 변경해도 새 ROUND 참가자가 생성되지 않습니다.
- [ ] ROUND 배포는 `ROUND_AUTH_MODE=baton`, 정확한 BATON issuer, `aud=round`, 프로덕션 HTTPS JWK
      Set URI, 최대 5분인 참여권 수명 상한, BATON의 정확한 HTTPS Origin을 사용합니다. 필수 verifier
      설정을 하나라도 제거하면 시작에 실패합니다.
- [ ] BATON은 참여권을 `RS256`으로 서명하고 JOSE header에 서명 key의 `kid`를 포함하며 private key를
      ROUND에 제공하지 않습니다. ROUND는 공개 JWK Set만 받습니다. 예행한 회전에서는 발급 key를
      바꾸기 전에 새 key를 게시하고, 이전 참여권 수명과 clock skew가 지날 때까지 두 공개 key를
      모두 유지합니다.
- [ ] BATON은 참여권을 `Domain` attribute 없이 `/round/rooms/{roomId}` 범위의 `HttpOnly`, `Secure`,
      `SameSite=Strict` cookie로만 발급합니다. token은 URL, 브라우저 storage, proxy log,
      애플리케이션 log, monitoring label에 없어야 합니다.
- [ ] edge는 방 ID, WebSocket upgrade, 원래 `Origin`, cookie를 보존하면서
      `/round/rooms/{roomId}/signal`을 `/rooms/{roomId}/signal`로,
      `/round/rooms/{roomId}/turn-credentials`를 `/api/rooms/{roomId}/turn-credentials`로
      mapping합니다. `/round/rooms/{roomId}/participation-grant/refresh`는 BATON에 남겨 두며 그
      경로를 ROUND로 proxy하지 않습니다.
- [ ] BATON 소유 web bundle을 `VITE_ROUND_AUTH_MODE=baton`으로 빌드하고 signaling 또는 TURN
      endpoint override를 두지 않습니다. 직접 초대는 입장 전 화면을 rendering하거나 미디어 요청을
      허용하기 전에 Account session과 방 참여 preflight를 완료합니다. 명시적인 입장에는 방 범위
      공개 경로 세 개만 사용하고 standalone endpoint는 사용하지 않습니다.
- [ ] preflight `401`은 canonical `/room/{roomId}`만 `returnTo`로 사용해 BATON login을 제안하고,
      `403`은 login loop 없이 BATON으로 돌아갑니다. 어떤 응답 body, CSRF token, 참여 cookie, JWT도
      rendering하거나 URL에 넣지 않습니다.
- [ ] preflight와 활성 방 시작은 하나의 single-flight 참여권 manager를 재사용합니다.
      `refreshAfterSeconds` 전에 활성 방을 mount해도 두 번째 refresh, 서명 작업, quota 차감이
      발생하지 않습니다.
- [ ] `refreshAfterSeconds`가 지난 뒤에도 입장 전 화면에서 기다리면 camera, microphone, 미디어 없는
      입장 전에 authorization을 다시 수행합니다. 이후의 `401`, `403`, `404`는 30초 refresh loop
      없이 활성 방에서 나가게 하며 지원하지 않는 auth mode는 landing이나 입장 전 화면을 rendering할
      수 없습니다.
- [ ] 한 account가 입력한 BATON alias를 account 구분이 없는 브라우저 storage에서 다음 account에
      미리 채우지 않습니다.
- [ ] hash가 붙은 `/round-ui/assets/*`만 immutable cache합니다. `/room/*` HTML은 `no-store`이고,
      `/round-ui/`는 standalone 방 생성이나 초대 코드 제어 없이 no-store 404를 반환합니다.
- [ ] edge는 client가 보낸 forwarding header를 버리고 canonical HTTPS host와 client 주소를 직접
      설정하며 방 범위 공개 경로 세 개 모두에 제한된 pre-auth rate limit을 적용합니다.
- [ ] refresh에는 인증된 BATON session이 필요하고, 현재 스터디 멤버십, 정확한 same-origin
      `Origin`, `Sec-Fetch-Site: same-origin`을 다시 확인하며 CORS 접근을 노출하지 않습니다. 성공
      시 새 `jti`와 만료 시점을 가진 host-only Strict cookie를 회전하고 숫자인 `expiresAt`과
      `refreshAfterSeconds`만 반환하며 `Cache-Control: no-store`를 설정합니다. JWT는 JavaScript,
      URL, log에 도달하지 않습니다.
- [ ] 동시에 실행한 참여권 검사는 하나의 refresh 요청을 공유합니다. 브라우저는 wall clock 값을
      `expiresAt`에서 빼는 대신 monotonic 상대 clock을 기준으로 `refreshAfterSeconds`를 예약합니다.
- [ ] TURN 발급은 숫자인 server-derived `refreshAfterSeconds`를 반환하고 브라우저는 수신 시점의
      monotonic deadline을 기준으로 예약합니다. 브라우저 wall clock을 변경해도 새 credential을
      거부하거나 갱신을 미루지 않습니다.
- [ ] 누락되었거나, 잘못된 형식이거나, 만료되었거나, 서명·issuer·audience·방이 잘못된 참여권을
      WebSocket upgrade와 TURN credential 발급에서 모두 거부합니다.
- [ ] 잘못된 참여권에는 no-store `401`을 반환합니다. cold-cache JWK endpoint 장애에는 빈 no-store
      `503`을 반환하고 credential 실패가 아니라 infrastructure 가용성 문제로 집계합니다.
- [ ] 미래 `iat`가 60초를 넘거나 `exp - iat`가 `ROUND_AUTH_MAX_GRANT_LIFETIME_SECONDS`보다 큰
      참여권을 거부합니다.
- [ ] 유효한 참여권은 공개 path, 내부 path, `room.join` payload를 변경해도 다른 방에 입장할 수
      없고, 거부된 시도는 방이나 참가자 상태를 만들지 않습니다.
- [ ] 요청에 다른 면에서 유효한 참여권이 있어도 외부, 누락, wildcard, HTTPS가 아닌 Origin을
      거부합니다.
- [ ] Java signaling 포트는 BATON edge와 monitoring plane에서만 접근할 수 있습니다.
      `/actuator/prometheus`와 `/actuator/metrics/**`는 private이며 공개 health 규칙은 전송 계층
      전용 `GET /healthz`만 노출합니다.
- [ ] BATON 페이지의 `Permissions-Policy`는 자체 camera, microphone, display-capture 사용을
      허용하고 `connect-src`는 정책 범위를 관계없는 Origin으로 넓히지 않으면서 방 범위 WSS
      endpoint를 허용합니다.
- [ ] 유효한 참가자는 signaling을 완료하고 TURN credential을 발급 및 갱신하며, 만료 전에 참여권을
      갱신하고 참여권 수명의 두 배 이상 한 방에 머물 수 있습니다. 이전 socket 자체의 `exp`가 되면
      ROUND는 `4001 / Participation grant expired`로 닫고 브라우저는 갱신된 cookie를 사용해 페이지
      새로고침 없이 재연결하면서 로컬 미디어와 chat history를 유지합니다.
- [ ] BATON이나 그 database를 사용할 수 없어도 이미 연결된 socket의 signaling frame은 현재
      참여권이 만료될 때까지만 중단되지 않습니다. BATON이 복구될 때까지 refresh와 재연결은 계속
      fail-closed하고 socket은 만료 시점에 닫힙니다.
- [ ] 유휴 상태이거나 입장하지 않은 socket은 늦어도 `exp + 1s`까지 닫히며 ROUND wall clock을
      과거로 옮겨도 monotonic lease deadline이 연장되지 않습니다. 만료 시 admission reservation,
      방 멤버십, 송신 queue 상태, gauge를 정확히 한 번 해제하고 `peer.left`를 한 번 보냅니다.
- [ ] 같은 `jti`를 사용하는 두 번째 동시 WebSocket은 기존 socket을 내보내지 않고 HTTP 429를
      받습니다. 해당 socket이 닫힌 뒤에는 정책이 영구적인 one-time token 저장소가 아니므로 아직
      유효한 같은 참여권으로 다시 연결할 수 있습니다.
- [ ] 같은 `(room_id, sub)`의 socket 두 개는 `study_id` 값이 다르더라도 각각 새로 발급한 서로 다른
      `jti`가 있을 때만 겹칠 수 있습니다. 세 번째 socket은 HTTP 429를 받고, 허용된 두 socket 중
      하나가 닫히면 해당 close 시도가 완료된 뒤 슬롯 하나를 사용할 수 있게 됩니다.
- [ ] 허용된 두 socket이 모두 `room.join`을 시도하면 더 최신 connection만 참가자로 남습니다. 6명이
      있는 방에서도 성공하고 방 크기를 6명으로 유지하며 `peer.joined`보다 `peer.left`를 먼저
      보내고, terminal close 시도 동안 이전 reservation을 유지했다가 한 번 해제하며 패자를
      `4002 / Participation session superseded`로 닫습니다. 지연된 이전 join도 패하고 해당
      브라우저는 자동으로 재연결하지 않습니다.
- [ ] 같은 `(room_id, sub)`의 TURN 발급은 BATON이 새 `jti`를 발급하거나 client 주소가 바뀌어도
      설정된 quota에 도달합니다. 거부 응답은 `Cache-Control: no-store`와 양수인 `Retry-After`를
      포함한 빈 HTTP 429이며 다른 방이나 참가자는 독립적으로 유지됩니다.
- [ ] `round.turn.credentials.rate_limited`는 제한된 `scope` label만 사용해 수집합니다. 참가자, 방,
      token, 주소 값은 metric이나 log에 나타나지 않고 monitoring runbook은 participant, client,
      global, state-capacity 압력을 구분합니다.
- [ ] `round.signaling.authorization.closes`는 참가자, 방, `jti`, role, 주소 tag가 없는 identity-free
      counter로 수집합니다.
- [ ] 위 BATON socket과 TURN 검사는 standalone 동작을 변경하지 않습니다. Standalone TURN 발급은
      참가자 quota 상태를 만들지 않고 계속 client IP와 서버 전체 quota로 제한합니다. Standalone은
      참여권 refresh 요청, lease timer, authorization-close event를 만들지 않습니다.
- [ ] BATON 연동 probe는 실제 단기 참여권을 얻고 두 token을 출력하지 않은 채 방 cookie를
      refresh하며, 새 `jti`와 정확한 no-store metadata 응답을 확인하고 UDP, TCP, TLS relay 경로를
      검증합니다. standalone Basic Auth probe를 이 경계의 증거로 사용하지 않습니다.
- [ ] BATON identity/membership/refresh와 edge, 새 web bundle, ROUND active lease 순서로 rollout을
      예행했습니다. rollback은 정확히 반대 순서로 예행했습니다.
