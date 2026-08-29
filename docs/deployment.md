# ROUND 배포 가이드

운영 토폴로지는 Caddy edge와 단일 Spring signaling 인스턴스로 구성합니다. TURN relay와
credential 생성은 Cloudflare TURN을 사용합니다. 운영 host에서 자체 TURN 서버, TURN 인증서,
relay 포트 범위를 직접 관리하지 않습니다.

```text
브라우저 ── HTTPS/WSS ── Caddy ── HTTP/WS ── signaling
   │                                      │
   └──── WebRTC media ── Cloudflare TURN ─┘ credential API(HTTPS)
```

## 운영 전제

- Linux host와 Docker Engine
- Docker Compose 2.24.4 이상
- 80/TCP, 443/TCP, 443/UDP를 수신할 수 있는 공개 주소
- ROUND 도메인의 DNS와 Caddy가 발급할 HTTPS 인증서
- Cloudflare Realtime TURN key ID와 해당 key의 API token
- GHCR에서 발행한 `round-edge`, `round-signaling` 불변 digest
- NTP가 동기화된 host 시계와 5GiB 이상의 여유 공간

TURN key를 만들 때는 ROUND 전용 key와 token을 사용합니다. token은 signaling runtime에만
주입하고 Git, 컨테이너 이미지, 브라우저 bundle, 명령행, 로그에 넣지 않습니다.

## 환경 파일 준비

```bash
install -d -m 0700 /etc/round
install -m 0600 ops/production.env.example /etc/round/production.env
```

다음 값은 반드시 운영 값으로 교체합니다.

- `ROUND_EDGE_IMAGE`, `ROUND_SIGNALING_IMAGE`: 릴리스 workflow가 출력한 digest 참조
- `ROUND_DOMAIN`, `ACME_EMAIL`, `ALLOWED_ORIGINS`
- `ROUND_ACCESS_USER`, `ROUND_ACCESS_PASSWORD_HASH`
- `TURN_PROVIDER=cloudflare`
- `TURN_CLOUDFLARE_KEY_ID`, `TURN_CLOUDFLARE_API_TOKEN`
- `VITE_STUN_URLS=stun:stun.cloudflare.com:3478`

공유 접근 비밀번호 hash는 Caddy의 bcrypt cost 12로 생성합니다. 평문 비밀번호는 환경
파일에 저장하지 않습니다.

```bash
docker run --rm -it caddy:2.11.4-alpine \
  caddy hash-password --algorithm bcrypt --bcrypt-cost 12
```

Cloudflare API token과 Caddy hash 때문에 환경 파일은 일반 파일, 소유자 전용 mode 0600으로
유지해야 합니다. symlink는 배포 도구가 거부합니다.

## Cloudflare TURN 계약

signaling은 인증, Origin, Fetch Metadata와 발급 quota를 통과한 요청에 대해서만 Cloudflare의
`generate-ice-servers` API를 호출합니다. 응답 중 TURN/TURNS route만 브라우저에 전달하고 STUN
항목과 브라우저에서 불안정한 53번 포트 route는 제외합니다.

기본 credential TTL은 600초입니다. BATON 모드에서는 참여권 만료 시각보다 길게 발급하지
않습니다. 브라우저는 서버가 반환한 `refreshAfterSeconds`에 따라 갱신하며 Cloudflare API
token을 알 수 없습니다.

공급자 호출 실패나 사용할 수 없는 응답은 credential endpoint의 빈 HTTP 503으로 변환하고
`round.turn.credentials.provider.errors`를 증가시킵니다. 다음 항목을 운영 경보에 포함합니다.

- `round.turn.credentials.provider.errors` 증가
- credential endpoint 503 비율
- Cloudflare TURN 사용량과 예산 한도
- relay-only 실제 브라우저 점검 실패

## 방화벽과 네트워크

운영 host의 inbound는 Caddy용 80/TCP, 443/TCP, 443/UDP만 허용합니다. signaling 8787은
Compose 내부 network에만 노출합니다. 자체 TURN용 3478, 5349, UDP relay 범위는 열지 않습니다.

signaling container는 Cloudflare credential API에 대한 outbound HTTPS가 필요합니다. 실제
WebRTC relay 트래픽은 브라우저와 Cloudflare 사이를 이동합니다.

## 배포

Linux 배포 도구는 깨끗한 checkout, 불변 이미지, 서명된 provenance, 환경·Compose snapshot,
단일 signaling replica와 host 준비 상태를 검사합니다.

```bash
sudo install -d -m 0700 /var/lib/round /var/lib/round/releases
ops/linux/preflight.sh /etc/round/production.env
ops/linux/deploy.sh /etc/round/production.env
```

배포는 `edge`, `signaling` 이미지만 pull하고 health check가 통과한 뒤 현재 release 상태를
`/var/lib/round/releases/current.env`에 기록합니다. 중단된 배포 marker가 있으면 새 배포를
시도하기 전에 rollback으로 복구합니다.

```bash
ops/linux/rollback.sh \
  --confirm ROLLBACK_ROUND \
  /etc/round/production.env
```

롤백하면 활성 WebSocket이 닫힐 수 있으므로 사용자가 다시 입장할 수 있는 시간에 수행합니다.

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

`release-images.yml`은 다음 이미지를 multi-architecture digest로 발행하고 provenance를
첨부합니다.

- `round-edge`: standalone 웹과 Caddy
- `round-edge` relay flavor: `VITE_ICE_TRANSPORT_POLICY=relay` 검증용
- `round-baton-web`: BATON 소유 edge에 넣는 웹 runtime
- `round-signaling`: Spring signaling runtime

TURN 이미지는 발행하지 않습니다. Cloudflare가 relay runtime을 운영합니다.

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

credential endpoint의 HTTP 200만으로 TURN relay 성공을 판정하지 않습니다. 별도 네트워크의
브라우저 두 개에서 relay 전용 edge를 사용해 양방향 오디오·비디오가 흐르고 선택된 candidate
pair가 relay인지 확인합니다. UDP가 제한된 네트워크에서는 Cloudflare가 제공한 TCP/TLS route도
확인합니다.

## Cloudflare key 회전

1. Cloudflare에서 새 TURN key와 API token을 만듭니다.
2. `/etc/round/production.env`의 key ID와 token을 교체합니다.
3. preflight를 통과한 뒤 signaling만 다시 생성하거나 정식 배포를 실행합니다.
4. 새 credential 발급과 relay-only 통화를 확인합니다.
5. 이전 key와 token을 폐기합니다.

이미 발급된 credential은 짧은 TTL 동안 남을 수 있습니다. 즉시 폐기가 필요한 사고 대응에서는
현재 통화 재입장과 최대 10분의 credential 수명을 고려합니다.

## Caddy 상태 백업과 복원

Caddy의 ACME 상태는 named volume에 저장됩니다. 기존 도구가 age로 암호화한 로컬 백업과
checksum을 만들고, restic이 이를 Cloudflare R2의 암호화 repository에 다시 보관합니다.
R2는 S3 호환 endpoint인 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`을 사용합니다.

먼저 restic을 설치하고 백업 전용 R2 bucket과 object read/write key를 만듭니다. 환경 예시와
repository password를 root 전용 파일로 설치합니다. repository password를 잃으면 복구할 수
없으므로 host 밖의 비밀 저장소에도 보관합니다.

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
install -m 0644 ops/linux/systemd/round-offsite-* /etc/systemd/system/
install -m 0644 ops/linux/tmpfiles.d/round-backups.conf /etc/tmpfiles.d/round-backups.conf
systemd-tmpfiles --create /etc/tmpfiles.d/round-backups.conf
systemctl daemon-reload
systemctl enable --now round-offsite-backup.timer round-offsite-maintenance.timer
systemctl start round-offsite-backup.service
systemctl status round-offsite-backup.service
```

매일 작업은 로컬 age 백업을 만든 뒤 `restic backup`을 실행합니다. 매주 작업은 최근 14개 일별,
8개 주별, 12개 월별 snapshot을 보존하면서 `forget --prune`과 `restic check`를 실행합니다.
prune 중에는 repository가 잠기므로 일일 백업과 겹치지 않게 시간을 분리했습니다.
로컬 age 백업은 systemd-tmpfiles가 30일 뒤 정리하고 장기 보존은 R2 snapshot이 담당합니다.

```bash
ops/linux/backup-caddy.sh \
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

복원은 모든 ROUND Compose 컨테이너를 내린 뒤 명시적 확인 문자열과 age identity를 요구합니다.

```bash
ops/linux/restore-caddy.sh \
  --identity-file /etc/round/backup-identity.txt \
  --confirm RESTORE_CADDY_VOLUMES \
  /var/backups/round/round-caddy-<시각>.tar.age \
  /etc/round/production.env
```

백업과 복원은 Cloudflare TURN key, R2 key, restic password를 포함하지 않습니다. 운영 환경
파일과 세 비밀은 별도의 비밀 관리 절차로 복구해야 합니다. 실제 재해 복구 가능성을 확인하려면
최소 분기마다 R2에서 별도 디렉터리로 복원하고 checksum과 `restore-caddy.sh` 입력 검사를
통과시킵니다.

## BATON 배포 경계

기본 Compose는 standalone 계약을 고정합니다. BATON은 별도 edge manifest에서 방 범위 경로를
proxy하고, 참여권 갱신 endpoint는 BATON에 남겨야 합니다. 환경 변수로 기본 Compose를 BATON
모드로 조용히 바꾸지 않습니다.

BATON 참여권, JWK 회전, 방 범위 TURN endpoint와 배포 순서는
[ADR 0001](adr/0001-round-independent-service.md)과
[파일럿 체크리스트](pilot-checklist.md)를 따릅니다.

## 장애 대응 기준

- Cloudflare credential API 장애: 신규 TURN credential은 503, 기존 WebSocket과 직접 연결은 유지
- signaling 장애: Caddy health check 실패, 새 WebSocket·credential 발급 불가
- edge 장애: 공개 웹·WSS 전체 불가
- Cloudflare relay 장애: 직접 연결 가능한 사용자는 유지될 수 있으나 제한망 사용자는 미디어 불가

로그나 metric tag에 방 ID, 참가자 식별자, SDP, ICE candidate, credential, API token을 넣지
않습니다. 공급자 장애를 조사할 때도 고정된 오류 counter와 상태 코드만 사용합니다.
