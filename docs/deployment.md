# ROUND 배포 가이드

운영 환경은 외부 요청을 받는 Caddy와 Spring 시그널링 서버 인스턴스 하나로 구성합니다. TURN 중계와
자격 증명 발급은 Cloudflare TURN을 사용합니다. 운영 서버에서 TURN 서버·인증서·중계 포트를
직접 관리하지 않습니다.

```text
브라우저 ── HTTPS/WSS ── Caddy ── HTTP/WS ── 시그널링
   │                                      │
   └── WebRTC 미디어 ── Cloudflare TURN ──┘ 자격 증명 API(HTTPS)
```

## 운영 전제

- Linux 서버와 Docker Engine
- `age`, `restic`, Git
- Docker Compose 2.24.4 이상
- 80/TCP, 443/TCP, 443/UDP를 수신할 수 있는 공개 주소
- ROUND 도메인의 DNS와 Caddy가 발급할 HTTPS 인증서
- Cloudflare Realtime TURN 키 ID와 해당 키의 API 토큰
- GHCR에서 발행한 `round-edge`, `round-signaling`의 고정된 이미지 digest
- NTP가 동기화된 서버 시계와 5GiB 이상의 여유 공간

TURN 키를 만들 때는 ROUND 전용 키와 토큰을 사용합니다. 토큰은 시그널링 서버에만
주입하고 Git, 컨테이너 이미지, 브라우저 번들, 명령행, 로그에 넣지 않습니다.

## 환경 파일 준비

```bash
install -d -m 0700 /etc/round
install -m 0600 ops/production.env.example /etc/round/production.env
```

다음 값은 반드시 운영 값으로 교체합니다.

- `ROUND_EDGE_IMAGE`, `ROUND_SIGNALING_IMAGE`: 릴리스 작업이 출력한 digest 참조
- `ROUND_DOMAIN`, `ACME_EMAIL`, `ALLOWED_ORIGINS`
- `ROUND_ACCESS_USER`, `ROUND_ACCESS_PASSWORD_HASH`
- `TURN_PROVIDER=cloudflare`
- `TURN_CLOUDFLARE_KEY_ID`, `TURN_CLOUDFLARE_API_TOKEN`
- `VITE_STUN_URLS=stun:stun.cloudflare.com:3478`

공유 접근 비밀번호 해시는 Caddy의 bcrypt 비용 12로 생성합니다. 평문 비밀번호는 환경
파일에 저장하지 않습니다.

```bash
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

Cloudflare API 토큰과 Caddy 비밀번호 해시를 담은 환경 파일은 일반 파일로 만들고,
소유자만 읽고 쓸 수 있도록 권한을 0600으로 설정합니다. 심볼릭 링크는 배포 도구가 거부합니다.

## Cloudflare TURN 계약

시그널링 서버는 인증·Origin·Fetch Metadata 검사와 발급 한도 검사를 통과한 요청에만
Cloudflare의 `generate-ice-servers` API를 호출합니다. 응답 중 TURN/TURNS 주소만 브라우저에
전달하고 STUN 항목과 브라우저에서 불안정한 53번 포트 주소는 제외합니다.

기본 자격 증명 수명은 600초입니다. BATON 모드에서는 참여권 만료 시각보다 길게 발급하지
않습니다. 브라우저는 서버가 반환한 `refreshAfterSeconds`에 따라 갱신하며 Cloudflare API
토큰을 알 수 없습니다.

공급자 호출 실패나 사용할 수 없는 응답은 자격 증명 API의 빈 HTTP 503으로 변환하고
`round.turn.credentials.provider.errors`를 증가시킵니다. 다음 항목을 운영 경보에 포함합니다.

- `round.turn.credentials.provider.errors` 증가
- 자격 증명 API의 503 비율
- Cloudflare TURN 사용량과 예산 한도
- TURN 중계 전용 실제 브라우저 점검 실패

## 방화벽과 네트워크

운영 서버 방화벽은 Caddy용 80/TCP, 443/TCP, 443/UDP만 외부에 엽니다. 시그널링 8787 포트는
`backend` 네트워크에서 edge에만 노출합니다. 시그널링 컨테이너는 Cloudflare 자격 증명 API
호출에 별도의 `egress` 네트워크를 사용하지만 서버 포트를 외부에 열지 않습니다. 자체 TURN용
3478, 5349, UDP 중계 범위는 열지 않습니다. 실제
WebRTC 중계 트래픽은 브라우저와 Cloudflare 사이를 이동합니다.

## 배포

Linux 배포 도구는 미커밋 변경이 없는 소스, digest로 고정한 이미지, 서명된 빌드 출처 증명,
환경·Compose 설정 사본, 시그널링 서버의 단일 인스턴스 설정과 운영 서버의 준비 상태를 검사합니다.
systemd 서비스가 참조하는 저장소 경로는 `/opt/round`로 고정합니다. 운영 서버에 처음 설치할 때
다음과 같이 소스를 준비합니다.

```bash
sudo git clone https://github.com/ljkhyeong/webrtc-study.git /opt/round
sudo git -C /opt/round switch --detach <검증한 커밋 SHA>
cd /opt/round
```

이후 운영 도구를 갱신할 때도 같은 경로에서 검증한 커밋으로 전환하고 깨끗한 상태를 확인합니다.

```bash
sudo git -C /opt/round fetch origin
sudo git -C /opt/round switch --detach <검증한 커밋 SHA>
test -z "$(sudo git -C /opt/round status --short)"
cd /opt/round
```

임의의 다른 작업 디렉터리에서 배포 스크립트만 실행하면 배포 자체는 성공할 수 있지만 예약 백업은
`/opt/round/ops/linux/backup-caddy.sh`를 실행하므로 운영 도구의 기준 경로를 바꾸지 않습니다.

```bash
sudo install -d -m 0700 /var/lib/round /var/lib/round/releases
ops/linux/preflight.sh /etc/round/production.env
ops/linux/deploy.sh /etc/round/production.env
```

배포 도구는 `edge`, `signaling` 이미지를 내려받고 상태 검사를 통과하면 현재 릴리스 정보를
`/var/lib/round/releases/current.env`에 기록합니다. `observability` 프로필을 사용하면 고정된
Alloy 이미지도 내려받습니다. 중단된 배포 기록이 있으면 새로 배포하기 전에 롤백으로 복구합니다.

```bash
ops/linux/rollback.sh \
  --confirm ROLLBACK_ROUND \
  /etc/round/production.env
```

롤백하면 활성 WebSocket이 닫힐 수 있으므로 사용자가 다시 입장할 수 있는 시간에 수행합니다.

`edge`는 `restart: always`로 실행합니다. 백업이 edge를 중지한 뒤 전원이 끊겨도 Docker가 다시
시작되면 edge가 자동으로 켜집니다. 운영자가 수동으로 중지한 경우에도 Docker 재시작 시 다시
켜집니다. 재부팅 후에도 서비스를 중단해 두려면 `docker compose --env-file /etc/round/production.env down`으로
프로젝트를 내립니다. Caddy 데이터를 보존하려면 `--volumes` 옵션을 사용하지 않습니다.

## Grafana Cloud 지표와 경보

Grafana Alloy는 시그널링 서버의 비공개 `/actuator/prometheus`를 30초마다 수집해 Grafana Cloud
Metrics로 원격 전송합니다. Alloy 관리 UI와 시그널링 관리 포트는 서버 외부에 공개하지
않습니다. Alloy의 WAL은 `alloy_data` 볼륨에 저장해 일시적인 전송 장애가 복구되면 다시 보냅니다.

Grafana Cloud에서 stack의 Prometheus remote write URL과 사용자 ID를 확인하고, 해당 stack에
`metrics:write`만 허용한 access policy token을 만듭니다. `/etc/round/production.env`에 다음 값을
넣고 profile을 활성화합니다.

```dotenv
COMPOSE_PROFILES=observability
GRAFANA_CLOUD_PROMETHEUS_URL=https://<Grafana Cloud Metrics 주소>/api/prom/push
GRAFANA_CLOUD_PROMETHEUS_USER=<Metrics instance 사용자 ID>
GRAFANA_CLOUD_API_TOKEN=<metrics:write token>
```

preflight와 정식 배포를 실행한 뒤 Grafana Explore에서 다음 식이 `1`인지 확인합니다.

```promql
up{job="round-signaling", environment="production"}
```

Grafana Alerting의 rule 가져오기에서
`ops/observability/round-alerts.yml`을 Prometheus 규칙으로 가져오고 Grafana Cloud Metrics data
source를 선택합니다. `RoundSignalingUnavailable`은 Alloy 자체가 멈춰 시계열이 사라지는 경우도
감지해야 하므로 No data 상태를 Alerting으로 설정합니다. 나머지 규칙은 다음 상황만 다룹니다.

- Cloudflare TURN 공급자 오류
- BATON JWK 원본 장애
- 전체 프레임 한도, 송신 대기열, 연결 수용 한도 도달

마지막으로 운영 연락처를 contact point에 연결하고 테스트 알림을 보냅니다. token, remote write
사용자 ID와 URL은 로그나 저장소에 기록하지 않으며 token은 `metrics:write` 외 권한을 부여하지
않습니다.

공인 HTTPS·TLS 인증서 장애와 백업 실패·예약 누락은 내부 지표만으로 확인할 수 없습니다.
선택 설치용 Synthetic Monitoring 규칙과 Healthchecks systemd 설정은
[외부 접속·백업 알림 설정](external-monitoring.md)을 따릅니다. 별도로 활성화하기 전에는 알림을 보내지 않습니다.

## 로컬과 macOS 파일럿

로컬 개발은 `.env.example`의 `TURN_PROVIDER=disabled`를 기본으로 사용합니다. 실제 relay가
필요할 때만 개인 Cloudflare key를 로컬 비공개 `.env`에 넣습니다.

macOS 파일럿은 다음 override로 edge 포트만 바꿉니다. TURN 포트나 별도 Docker network는
게시하지 않습니다.

```bash
docker compose \
  -f compose.yml \
  -f compose.macos-pilot.yml \
  --env-file ops/macos-pilot.env \
  up -d --wait
```

## 릴리스 이미지

`release-images.yml`은 여러 CPU 아키텍처용 이미지를 묶은 digest로 다음 이미지를 발행하고,
빌드 출처 증명(provenance)을 첨부합니다.

- `round-edge`: 독립 실행 웹과 Caddy
- `round-edge` 중계 전용 버전: `VITE_ICE_TRANSPORT_POLICY=relay` 검증용
- `round-baton-web`: BATON의 외부 프록시 뒤에서 실행하는 웹 서버
- `round-signaling`: Spring 시그널링 서버

TURN 이미지는 발행하지 않습니다. Cloudflare가 TURN 중계 서버를 운영합니다.

## 검증

저장소 검증:

```bash
npm run check
bash ops/ci/validate-deployment.sh --check-only
```

운영 배포 후에는 다음을 확인합니다.

```bash
curl --fail --silent https://<ROUND_DOMAIN>/healthz
docker compose --env-file /etc/round/production.env ps
```

자격 증명 API의 HTTP 200 응답만으로 TURN 중계 성공을 판정하지 않습니다. 서로 다른 네트워크의
브라우저 두 개에서 중계 전용 `edge` 이미지를 사용해 양방향 음성·영상이 전달되고 선택된 ICE 후보 쌍이
`relay` 경로를 사용하는지 확인합니다. UDP가 제한된 네트워크에서는 Cloudflare가 제공한 TCP/TLS 경로도 확인합니다.

## Cloudflare 키 교체

1. Cloudflare에서 새 TURN 키와 API 토큰을 만듭니다.
2. `/etc/round/production.env`의 키 ID와 토큰을 교체합니다.
3. 배포 전 검사를 통과한 뒤 시그널링 서버만 다시 생성하거나 정식 배포를 실행합니다.
4. 새 자격 증명 발급과 TURN 중계 전용 통화를 확인합니다.
5. 이전 키와 토큰을 폐기합니다.

이미 발급된 자격 증명은 짧은 수명 동안 남을 수 있습니다. 즉시 폐기가 필요한 사고 대응에서는
현재 통화 재입장과 최대 10분의 자격 증명 수명을 고려합니다.

## Caddy 상태 백업과 복원

Caddy의 인증서 발급·갱신 상태(ACME)는 Docker 볼륨(named volume)에 저장됩니다. 백업 도구가 age로 암호화한
로컬 백업과 체크섬을 만들고, restic이 이를 Cloudflare R2의 암호화 저장소에 보관합니다.
R2는 S3 호환 API 주소인 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`을 사용합니다.

age 복호화 키는 운영 서버가 아닌 관리용 기기에서 만들고, 암호화한 파일을 다시 복호화할 수 있는지 확인합니다.

```bash
umask 077
age-keygen -o round-backup-identity.txt
age-keygen -y round-backup-identity.txt > round-backup-recipients.txt
test "$(
  printf round-backup-test |
    age --recipients-file round-backup-recipients.txt |
    age --decrypt --identity round-backup-identity.txt
)" = round-backup-test
```

암호화에 쓰는 공개키(recipient)만 운영 서버에 설치합니다.

```bash
sudo install -m 0644 round-backup-recipients.txt /etc/round/backup-recipients.txt
```

`round-backup-identity.txt`는 운영 host에 상시 두지 않고 별도 비밀 저장소에 보관합니다.

먼저 restic을 설치하고 백업 전용 R2 버킷과 객체 읽기·쓰기 키를 만듭니다. 환경 설정 파일과
저장소 비밀번호 파일은 root만 접근할 수 있도록 설치합니다. 비밀번호를 잃으면 백업을 복구할 수
없으므로 운영 서버 밖의 비밀 저장소에도 보관합니다.

```bash
install -m 0600 ops/restic-r2.env.example /etc/round/restic-r2.env
install -m 0600 /dev/null /etc/round/restic-password
openssl rand -base64 48 | tee /etc/round/restic-password >/dev/null
systemd-run --wait --pipe \
  --unit=round-restic-init \
  --property=EnvironmentFile=/etc/round/restic-r2.env \
  /usr/bin/restic init
```

`restic-r2.env`의 `ACCOUNT_ID`, `BUCKET_NAME`, access key ID와 secret access key를 실제 값으로
교체한 뒤 초기화합니다. bucket 생성 권한은 필요하지 않으며 해당 bucket의 object 읽기·쓰기
범위만 부여합니다.

systemd 단위를 설치하고 매일 백업과 매주 보존·무결성 검사를 켭니다.

```bash
install -m 0644 \
  ops/linux/systemd/round-offsite-* \
  ops/linux/systemd/round-ops-failure@.service \
  /etc/systemd/system/
install -m 0644 ops/linux/tmpfiles.d/round-backups.conf /etc/tmpfiles.d/round-backups.conf
systemd-tmpfiles --create /etc/tmpfiles.d/round-backups.conf
systemctl daemon-reload
systemctl enable --now round-offsite-backup.timer round-offsite-maintenance.timer
```

일일 작업은 로컬 age 백업을 만든 뒤 `restic backup`을 실행합니다. 주간 작업은 일별 14개,
주별 8개, 월별 12개 스냅샷을 보존하며 `forget --prune`과 `restic check`를 실행합니다.
불필요한 백업 데이터를 정리하는 동안 저장소가 잠기므로 일일 백업과 실행 시간을 나눴습니다.
로컬 age 백업은 systemd-tmpfiles가 30일 뒤 정리하고, 장기 백업은 R2 스냅샷으로 보관합니다.

필수 실행 파일이나 설정 파일이 없으면 서비스를 실패 처리하고 `OnFailure`로 `round-ops` 태그의
치명적인 운영 오류를 기록합니다. `Condition`·`Assert` 사전 검사는 실패 처리 전에 실행을
건너뛰므로 사용하지 않습니다. 실패 요약과 실제 원인은 다음 로그에서 확인합니다.

```bash
journalctl -t round-ops -p crit --since today
journalctl -u round-offsite-backup.service -u round-offsite-maintenance.service --since today
```

일일 백업은 서버 시간 기준 03:15에 무작위 지연 없이 시작하며, timer의 허용 오차는 1초로 설정합니다.
Caddy 볼륨을 백업하는 동안 데이터가 바뀌지 않도록 Caddy를 잠시 중지하고 완료 또는 실패 시 다시
시작합니다. 활성 WebSocket이 종료될 수 있으므로 03:15~03:45를 유지보수 창으로 운영합니다.
이 시간대에 중단을 허용할 수 없으면 timer의 `OnCalendar`와 유지보수 창을 함께 옮깁니다.

로컬 백업 명령은 GNU `timeout`으로 20분 뒤 종료 신호를 보내고, 정리·재기동에 최대 5분을 더
허용합니다. edge 재기동의 상태 확인은 한 번에 120초로 제한합니다. 정상 예약 시각에 시작하면
03:40 무렵까지 명령을 종료하도록 제한해 유지보수 종료 전 여유를 확보합니다. R2 전송은 edge가
다시 시작된 뒤 별도로 실행하므로 로컬 백업의 20분 제한을 적용하지 않습니다.

시간 제한은 복구 성공을 보장하지 않습니다. 추가 5분이 지나도 끝나지 않으면 프로세스를 강제
종료하며, Docker 장애 등으로 edge를 다시 켜지 못할 수 있습니다. 예약 백업의 제한 시간 초과나
재기동 실패는 위 운영 오류 로그에서 확인하고 edge 복구 여부를 점검합니다.

일일 timer는 `Persistent=false`로 설정해 서버가 꺼져 있는 동안 놓친 백업을 재부팅 뒤에 자동으로
실행하지 않습니다. 누락된 백업은 다음 정기 실행을 기다리거나 승인된 유지보수 창에서 수동으로
실행합니다. 최초 설치 후 시험 백업도 같은 시간 제한을 지킵니다. edge를 중지하지 않는 주간
보존·무결성 검사는 `Persistent=true`를 유지합니다.

```bash
systemctl start round-offsite-backup.service
systemctl status round-offsite-backup.service
```

R2 전송 없이 로컬 백업만 만들 때도 유지보수 창에서 실행합니다.

```bash
timeout --verbose --kill-after=5m 20m ops/linux/backup-caddy.sh \
  --output-dir /var/backups/round \
  --recipient-file /etc/round/backup-recipients.txt \
  /etc/round/production.env
```

R2 snapshot 확인과 테스트 복원:

```bash
systemd-run --wait --pipe \
  --unit=round-restic-snapshots \
  --property=EnvironmentFile=/etc/round/restic-r2.env \
  /usr/bin/restic snapshots --host round-production --tag round-caddy

install -d -m 0700 /var/lib/round/restore-test
systemd-run --wait --pipe \
  --unit=round-restic-restore-test \
  --property=EnvironmentFile=/etc/round/restic-r2.env \
  /usr/bin/restic restore latest --host round-production --tag round-caddy \
    --target /var/lib/round/restore-test
```

복원할 때만 개인 키를 메모리 기반 `/run` 아래에 설치합니다. 복원 명령이 성공하거나 실패하면
shell trap이 개인 키를 제거합니다.

```bash
sudo install -d -m 0700 /run/round-restore
restore_identity=/run/round-restore/backup-identity.txt
sudo install -m 0600 <비밀 저장소에서 가져온 identity 파일> "$restore_identity"
trap 'sudo rm -f -- "$restore_identity"' EXIT
sudo /opt/round/ops/linux/restore-caddy.sh \
  --identity-file "$restore_identity" \
  --confirm RESTORE_CADDY_VOLUMES \
  /var/backups/round/round-caddy-<시각>.tar.age \
  /etc/round/production.env
sudo rm -f -- "$restore_identity"
trap - EXIT
```

백업과 복원은 Cloudflare TURN key, R2 key, restic password를 포함하지 않습니다. 운영 환경
파일과 세 비밀은 별도의 비밀 관리 절차로 복구해야 합니다. 실제 재해 복구 가능성을 확인하려면
최소 분기마다 R2에서 별도 디렉터리로 복원하고 checksum과 `restore-caddy.sh` 입력 검사를
통과시킵니다.

## BATON 배포 구성

기본 Compose는 독립 실행 모드로 고정되어 있습니다. BATON은 별도의 외부 프록시 설정에서
방별 경로를 ROUND로 전달하고 참여권 갱신 API는 직접 처리해야 합니다. 기본 Compose를 환경
변수로 BATON 모드로 전환하지 않습니다.

BATON 참여권, JWK 교체, 방별 TURN API와 배포 순서는
[ADR 0001](adr/0001-round-independent-service.md)과
[파일럿 체크리스트](pilot-checklist.md)를 따릅니다.

## 장애 대응 기준

- Cloudflare 자격 증명 API 장애: 새 TURN 자격 증명은 503, 기존 WebSocket과 직접 연결은 유지
- 시그널링 장애: Caddy 상태 검사 실패, 새 WebSocket 연결·자격 증명 발급 불가
- edge 장애: 공개 웹·WSS 전체 불가
- Cloudflare 중계 장애: 직접 연결 가능한 사용자는 유지될 수 있으나 제한망 사용자는 미디어 불가

로그나 지표 태그에 방 ID, 참가자 식별자, SDP, ICE 후보, 자격 증명, API 토큰을 넣지
않습니다. 공급자 장애를 조사할 때도 고정된 오류 횟수와 상태 코드만 사용합니다.
