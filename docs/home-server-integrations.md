# 추가 과금 없는 연동 검토

검토일: 2026-09-12. 대상은 ROUND 코드와 연동 설정이다. 홈서버 설치나 DNS 변경은 포함하지 않는다.
Ubuntu 홈서버의 k3s, `b4ton.com`과 서비스별 서브도메인, 기존 Let’s Encrypt 자동 갱신을 전제로 한다.

## 적용 결과

| 대상                  | 선택                          | 줄어드는 작업                                     | 이번 변경                                            |
| --------------------- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| 통화 중계             | 홈서버 coturn                 | NAT 중계 서버·인증 프로토콜을 직접 만들 필요 없음 | `TURN_PROVIDER=coturn` 지원, 설정 예시 추가          |
| 서버 지표·경보        | 로컬 Prometheus               | 지표 저장·조회·경보 판단을 직접 구현하지 않음     | 기존 Actuator와 경보 6개를 재사용하는 수집 설정 추가 |
| 중계 접속·인증서      | Blackbox Exporter             | TLS 접속·인증서 만료 검사 코드 불필요             | 선택적인 coturn 상태 검사와 경보 3개 추가            |
| 장애·복구 알림        | Alertmanager → Discord 웹훅   | 알림 묶기·반복 전송·복구 알림 코드 불필요         | 기본 수신처 연동 예시 추가, 전송은 비활성            |
| 유동 IP의 DNS 갱신    | ddclient → Cloudflare DNS API | IP 확인·변경 감지·DNS API 호출 스크립트 불필요    | 선택적인 설정 예시 추가. 고정 IP면 사용하지 않음     |
| 인증서                | 기존 Let’s Encrypt 자동 갱신  | 발급·갱신 작업 중복 방지                          | 기존 체계 사용, 새 갱신 프로그램 추가 없음           |
| 초대 공유·QR          | Web Share API·qrcode          | 외부 링크·QR 생성 API 불필요                      | 기존 연동 유지                                       |
| 공유 화면 작은 창     | Picture-in-Picture API        | 다른 앱 위에 영상을 띄우는 창 관리 구현 불필요    | 지원 브라우저에서 상대 공유 화면의 작은 창 보기 추가 |
| 브라우저 오류         | 기존 Faro 연동                | 별도 오류 수집 API·조회 화면 불필요               | 기본 비활성 유지, 사용 시 기존 무료 플랜 조건 확인   |
| 운영·검사 이미지 갱신 | Dependabot Docker Compose     | 새 버전·digest 확인 작업 감소                     | Alloy와 공식 검사 도구의 주간 업데이트 PR            |

coturn·Prometheus·Blackbox Exporter·Alertmanager는 오픈소스 연동이다. 사용량 과금은 없지만
홈서버의 전력·저장 공간·회선 자원을 사용한다. 로컬 Prometheus만으로 홈서버 전원·회선 장애를
외부에서 감지할 수는 없다. 외부 장애 감시는 기존 [모니터링 연동](external-monitoring.md)을 참고한다.

## 운영 이미지 업데이트

Dependabot의 `docker-compose` 항목으로 `compose.yml`의 Alloy 이미지와
`ops/ci/compose.observability.yml`의 검사 도구 이미지를 매주 확인하고 업데이트 PR을 엽니다.
설정이 GitHub 기본 브랜치에 반영된 뒤 작동하며, PR 검토·병합과
배포는 별도로 진행합니다. Dependabot 버전 업데이트는 모든 GitHub 저장소에서 사용할 수 있습니다.
[지원 범위](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories),
[버전 업데이트](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates).

이 항목은 서비스의 `image`를 확인합니다. 빌드 인자로 지정한 Node·Java·Caddy 이미지와
`CADDY_VERSION`은 여전히 함께 확인해 갱신해야 합니다.
[Compose 파서](https://github.com/dependabot/dependabot-core/blob/main/docker/lib/dependabot/docker_compose/file_parser.rb).

Alloy 배포 전 검사는 환경 파일과 기본값을 합친 Compose 결과를 사용한다. 특정 버전 번호를
검사 코드에 복제하지 않고, `grafana/alloy`의 태그와 SHA-256 digest가 고정됐는지 확인한다.

## 통화 중계

Cloudflare TURN은 월 1,000GB 무료 구간 이후 송신량에 따라 과금된다. 따라서 추가 과금을 피하는
홈서버 구성에는 coturn을 선택한다. 기존 Cloudflare 연동은 선택지로 유지하며 자동 전환하지 않는다.
[Cloudflare 요금](https://developers.cloudflare.com/realtime/), [coturn](https://github.com/coturn/coturn).

ROUND 시그널링 설정:

```dotenv
TURN_PROVIDER=coturn
TURN_COTURN_URLS=turn:turn.b4ton.com:3478?transport=udp,turn:turn.b4ton.com:3478?transport=tcp,turns:turn.b4ton.com:5349?transport=tcp
TURN_COTURN_SECRET=
TURN_CLOUDFLARE_KEY_ID=
TURN_CLOUDFLARE_API_TOKEN=
```

공유키는 32자 이상의 무작위 값으로 생성해 Kubernetes Secret 등 Git 밖에 보관한다. coturn의
`static-auth-secret`에도 같은 값을 넣는다. 브라우저에는 공유키 대신 만료 시각과 무작위 식별자로
만든 사용자명, HMAC-SHA1 서명을 전달한다. 이는 coturn의 TURN REST 인증 규격이며 외부 HTTP 호출은 없다.
기존 참여권 만료·요청 제한·갱신 주기·브라우저 응답 형식을 그대로 사용한다.
[인증 규격](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

[coturn 설정 예시](../ops/coturn/turnserver.conf.example)의 IP와 인증서 경로를 실제 값으로 바꾼다.

- `turn.b4ton.com`은 공인 IPv4를 가리키는 **DNS only A 레코드**를 사용한다. Cloudflare HTTP 프록시로 TURN을 전달하지 않는다.
- 공유기와 호스트 방화벽에 TCP·UDP 3478, TCP 5349, UDP 49160–49259를 같은 포트 번호로 전달한다.
- k3s에서 coturn은 `hostNetwork`로 실행하고 `listening-ip`·`relay-ip`에는 노드의 LAN IP를 사용한다. `external-ip`에는 공인 IP/LAN IP를 지정한다. 일반 HTTP Ingress를 통과시키지 않는다.
- 인증서는 `turn.b4ton.com`을 포함해야 한다. 기존 갱신 도구가 갱신한 인증서를 coturn에 연결하고, 기존 갱신 후 처리에서 coturn이 새 인증서를 읽도록 재시작한다. 진행 중인 중계 통화에 영향이 있으므로 통화가 없는 시간에 적용한다.
- 443만 허용하는 제한망까지 이 구성으로 보장할 수는 없다. 443은 웹 서비스가 사용하므로 TURN TLS는 5349를 사용한다.
- 예시의 총 allocation 한도는 120개다. 참가자 수와 같은 값이 아니며 여러 피어 연결·전송 방식이 각각 allocation을 사용할 수 있다.

공유키 교체·중계 서버 재시작·공인 IP 변경은 진행 중인 통화에 영향을 줄 수 있다. DNS 갱신만으로
coturn의 `external-ip` 설정까지 바뀌지는 않는다. 실제 운영 전에는 서로 다른 외부망의 두 참가자로
`iceTransportPolicy=relay`에서 영상·음성·채팅을 확인한다. 로컬 통과와 외부망 통과는 구분한다.

Compose 배포 전 검사도 coturn을 지원한다. 새 `ops/production.env.example`은 coturn을 기본으로
사용하며, 기존 Cloudflare 환경은 그대로 사용할 수 있다. 두 공급자의 필수값 검사와 Compose
보간을 같은 CI에서 확인한다. 이 배포 검사는 k3s 설치나 실제 중계 접속 검사를 수행하지 않는다.

## DNS와 서비스 주소

기본 주소는 `b4ton.com`, 서비스 주소는 `round.b4ton.com`, `cal.b4ton.com`으로 정한다.
`b4ton.com`과 `turn.b4ton.com`의 A 레코드를 공인 IP로 지정하고, 웹 서비스 서브도메인은
`b4ton.com`을 가리키는 CNAME으로 둘 수 있다. TURN은 프록시된 웹 호스트의 CNAME 대신 별도 DNS only A를 유지한다.
IPv6 경로를 준비하지 않았다면 AAAA 레코드를 추가하지 않는다.

유동 IP라면 [ddclient 설정 예시](../ops/dns/ddclient.conf.example)로 두 A 레코드를 갱신한다.
토큰은 `b4ton.com`의 DNS 편집·Zone 읽기 권한으로 제한한다. 새 DDNS 서비스를 구독하거나
ROUND에 DNS 관리 API를 추가할 필요는 없다. 고정 IP라면 이 구성도 불필요하다.
[Cloudflare 안내](https://developers.cloudflare.com/dns/manage-dns-records/how-to/managing-dynamic-ip-addresses/),
[ddclient 공식 설정](https://github.com/ddclient/ddclient/blob/main/ddclient.conf.in).

**ROUND의 공개 주소 전환에는 BATON 측 인증 연동이 필요하다.** 현재 브라우저는 같은 출처의
`/api/v1/auth/session`과 방별 참여권 갱신 API를 호출하고, 참여권 쿠키는 host-only다.
DNS만 `round.b4ton.com`으로 바꾸면 로그인이 전달되지 않는다. 쿠키 Domain을 `.b4ton.com`으로
넓혀 해결하지 않는다. 현재 계약을 유지하려면 공유 링크를 BATON의 `/room/{roomId}`로 연결하고,
`round.b4ton.com`에서도 해당 BATON 경로로 연결한다. 주소창까지 ROUND 도메인으로 분리하려면
BATON에서 일회용 입장 코드 교환 등 서브도메인 로그인 계약을 먼저 구현해야 한다.
이번 변경은 해당 인증·라우팅을 변경하지 않았다. [현재 계약](adr/0001-round-independent-service.md).

## 로컬 지표 수집

[prometheus-local.yml](../ops/observability/prometheus-local.yml), 기존
[round-alerts.yml](../ops/observability/round-alerts.yml),
[alertmanager-targets.yml](../ops/observability/alertmanager-targets.yml)을 Prometheus의
`/etc/prometheus`에 같은 파일명으로 연결한다. 알림 대상의 기본값은 빈 목록 `[]`이다.
수집 주소는 실제 k3s Service·namespace에 맞춘다. `/actuator/prometheus`와 Prometheus 관리 화면은
외부 Ingress로 공개하지 않는다. Grafana는 이 Prometheus를 데이터 소스로 사용할 수 있다.

초기 보관 한도는 실행 옵션 `--storage.tsdb.retention.time=7d`, `--storage.tsdb.retention.size=512MB`로
줄일 수 있다. WAL·현재 수집 데이터는 별도 공간을 사용한다. 같은 지표를 Alloy와 Prometheus에서
불필요하게 이중 수집하지 않는다. 아래 선택 설정을 연결하기 전에는 기존 서버 지표와 경보 6개만
사용한다. [Prometheus 설정](https://prometheus.io/docs/prometheus/latest/configuration/configuration/).

## 중계 TLS·인증서 검사

coturn 자격 증명은 ROUND 안에서 서명해 발급하므로, 발급 성공만으로 중계 서버가 살아 있는지
알 수 없다. Blackbox Exporter가 1분마다 coturn의 TLS 포트에 접속해 인증서까지 확인하도록 한다.
검사 주소는 내부 Service를 사용하되 인증서 이름은 `turn.b4ton.com`으로 검증한다.

| 실행 도구         | 저장소 파일                                                         | 연결할 경로                                            |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| Blackbox Exporter | [blackbox-turn.yml](../ops/observability/blackbox-turn.yml)         | `/etc/blackbox-exporter/config.yml`                    |
| Prometheus        | [scrape-turn-tls.yml](../ops/observability/scrape-turn-tls.yml)     | `/etc/prometheus/optional-scrapes/turn-tls.yml`        |
| Prometheus        | [round-turn-alerts.yml](../ops/observability/round-turn-alerts.yml) | `/etc/prometheus/optional-rules/round-turn-alerts.yml` |

Blackbox Exporter에는 `--config.file=/etc/blackbox-exporter/config.yml`을 지정한다.
수집 설정의 coturn·Blackbox Exporter 주소는 실제 Service 이름으로 바꾼다. Prometheus의 선택 수집
파일과 경보 파일을 **함께** 연결하고 설정을 다시 읽히면 다음 경보가 활성화된다.

- TLS 접속·인증서 검증이 2분 동안 실패하면 중계 접속 실패를 알린다.
- 실제 제공 중인 인증서가 14일 이내 만료될 상태로 10분간 유지되면 갱신·반영 확인을 알린다.
- 검사 지표가 3분간 수집되지 않으면 Blackbox Exporter나 수집 설정 문제를 알린다.

기존 Let’s Encrypt 자동 갱신은 그대로 사용한다. 이 검사는 TURN 인증·중계 할당·UDP·실제 통화를
확인하지 않는다. 내부망 검사이므로 공인 DNS·포트 전달·홈서버 전원·회선 장애의 외부 감지도
대신하지 않는다. [Blackbox Exporter 설정](https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md).

검사를 끌 때는 선택 수집 파일과 경보 파일을 함께 제거하고 Prometheus 설정을 다시 읽힌다.
경보 파일만 남기면 의도한 중지까지 지표 누락으로 감지한다.

## 장애·복구 알림

[Alertmanager의 기본 Discord 연동](https://prometheus.io/docs/alerting/latest/configuration/#discord_config)을
사용한다. 별도 봇 서버나 유료 알림 서비스를 추가하지 않는다.
[Discord 웹훅](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)을 받을 채널과
연결할 때만 다음 설정을 활성화한다.

1. [alertmanager-discord.yml](../ops/observability/alertmanager-discord.yml)을 Alertmanager의
   `/etc/alertmanager/alertmanager.yml`에 연결하고 `--config.file`에 같은 경로를 지정한다.
2. 웹훅 URL은 Kubernetes Secret 등 Git 밖에 보관하고 Alertmanager의
   `/run/secrets/round-discord-webhook`에 읽기 전용 파일로 연결한다. 일반 Discord 웹훅 URL을 사용한다.
3. `alertmanager-targets.yml`의 `[]`를 아래 목록으로 바꾸고 실제 Service 주소를 지정한다.

```yaml
- targets: ['alertmanager.monitoring.svc.cluster.local:9093']
```

같은 종류의 경보를 묶어 최초 30초 뒤 알리고, 변경은 5분 간격, 해결되지 않은 경보는 4시간 간격으로
전송한다. 복구 알림도 보낸다. 전송 내용은 규칙에 적힌 경보 제목·설명이며 참가자·방·채팅 정보는
포함하지 않는다. 새 경보 전달을 중지하려면 대상 목록을 다시 `[]`로 바꾼다.

Prometheus 9090, Alertmanager 9093, Blackbox Exporter 9115는 클러스터 내부에서만 연결한다.
특히 Blackbox Exporter는 요청자가 검사 주소를 지정할 수 있으므로 외부 Ingress로 공개하지 않는다.
Alertmanager의 데이터 디렉터리를 영구 볼륨에 두면 재시작 후에도 음소거 설정·알림 전송 상태를 유지한다.

## 연동 설정 검사

아래 명령으로 Prometheus 기본·선택 수집 설정, 경보식과 기존 경보 테스트,
Alertmanager 알림 설정, Blackbox TLS 설정을 확인한다. 기존 배포 CI에서도 실행한다.

```bash
bash ops/ci/validate-observability.sh
```

설정 해석과 경보 판단은 공식 `promtool`, `amtool`, Blackbox의 `--config.check`에 맡긴다.
검사 컨테이너는 외부 통신을 차단하며, 실제 웹훅이나 홈서버 연결 정보가 필요하지 않다.
이미지를 처음 받을 때는 레지스트리 연결이 필요하다.
[Prometheus 검사 명령](https://prometheus.io/docs/prometheus/latest/command-line/promtool/).

## 추가하지 않은 기능

- 일정·공휴일·캘린더 API는 BATON/CAL의 책임이다. ROUND의 집중·휴식 타이머에는 외부 일정 데이터가 필요하지 않다.
- 회의 SDK·녹화·자막 API는 사용량 과금 또는 별도 연산 자원이 필요하다. 현재 통화 코드를 교체할 만큼의 필요는 확인되지 않았다.
- 외부 단축 URL·QR API는 이미 동작하는 초대 기능과 중복된다.
- 결제·배송·주소 조회처럼 현재 ROUND에 없는 업무를 위한 API는 추가하지 않았다.

## 확인 범위

코드와 설정을 준비했으며 홈서버 설치·DNS 변경·실제 인증서 연결은 하지 않았다.
관련 Java 테스트와 아키텍처 검사, coturn을 통한 로컬 두 참가자의 영상·음성·채팅,
Prometheus 설정과 기존 경보 6개를 통과했다. coturn 설정은 테스트 인증서로 시작을 확인했다.
추가 연동은 Prometheus 3.14.0, Blackbox Exporter 0.28.0, Alertmanager 0.34.0으로 검증했다.
기본·선택 설정 검사, 신규 경보의 실패·복구·인증서 갱신·지표 누락 테스트를 통과했다.
격리된 로컬 환경에서 TLS 성공·이름 불일치·신뢰 실패·접속 거부와 Discord 형식의 장애·복구 전송을
확인했다. 실제 Discord 채널로는 전송하지 않았다.
외부망 중계, 실제 DNS 갱신, 인증서 갱신 후 반영은 운영 환경에서 확인할 항목이다.
