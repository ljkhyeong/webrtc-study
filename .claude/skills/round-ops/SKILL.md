---
name: round-ops
description: ROUND의 배포·운영 설정(compose, Dockerfile, ops/의 Caddy·coturn·관측·DNS·Linux·macOS 파일럿·백업, .github/workflows, 환경 파일 예시)을 바꾸거나 배포·TURN·모니터링 연동을 검토할 때 사용한다.
---

# ROUND 배포·운영

`AGENTS.md`의 범위를 따른다. 필요한 절만 읽는다.

- 배포 절차·환경 파일·TURN 계약·장애 기준: `docs/deployment.md`
- 홈서버 연동·로컬 지표·중계 상태 검사: `docs/home-server-integrations.md`
- 외부 HTTPS·백업 알림: `docs/external-monitoring.md`
- 공개 주소·환경변수·웹훅 인계: `docs/integration-readiness.md`
- 릴리스 전 수동 확인: `docs/pilot-checklist.md`의 해당 항목

## 원칙

- 추가 요금 없는 구성을 유지한다. 유료 서비스·요금제 전환이 필요하면 근거와 비용을 먼저 보고한다(`docs/external-api-review.md`의 기존 결정).
- 외부 계정 변경, DNS API 호출, 실제 키 교체, 운영 서버 접속은 사용자가 요청한 경우에만 수행한다.
- 환경 예시 파일은 실제 설정과 함께 맞춘다. 새 변수는 `.env.example`·`ops/*.env.example`과 문서에 반영한다.

## 비밀값 취급

- `ops/*.env`, `ops/*.credentials`, `ops/certs/`, `.env.*.local`처럼 예시가 아닌 파일은 내용을 출력하지 않는다. 필요하면 변수 이름이나 존재 여부만 확인한다.
- 비밀값을 명령 인자·로그·문서·테스트 기대값에 남기지 않는다. 새 비밀 파일은 Git 제외 목록(`ops/.gitignore` 등)과 `.dockerignore`에 모두 넣는다. 배포 검증이 `.dockerignore` 항목을 확인한다.

## 검증

Docker가 필요하다. 검사는 변경한 계층에 맞춰 선택한다.

- Compose·Dockerfile·Caddy·Linux·백업·릴리스 워크플로: `bash ops/ci/validate-deployment.sh --check-only`. 옵션을 빼면 Compose 이미지 전체를 빌드하므로 이미지 빌드 경로를 바꿨을 때만 사용한다.
- Prometheus·Alertmanager·Blackbox 설정: `bash ops/ci/validate-observability.sh`. 배포 검증에 포함되므로 둘 다 실행하지 않는다.
- BATON edge·Caddy 라우팅: `npm run test:e2e:baton-edge`(이미지 빌드 포함).
- 웹 빌드 환경변수: `npm run build:web:baton` 또는 `npm run build -w @round/web`.
- Python `yaml` 모듈이 없으면 다른 Python으로 반복하지 않고 저장소에 설치된 Node `yaml` 패키지를 사용한다.

## TURN 검증 한계

- 자격 증명 API의 HTTP 200만으로 중계 성공을 판정하지 않는다. 선택된 ICE 후보 쌍이 `relay`인지 확인해야 한다.
- 로컬 coturn 컨테이너로 중계를 시험할 때는 `relay-ip`에 `docker inspect`로 확인한 컨테이너 주소를 쓴다. `127.0.0.1`을 relay 주소로 광고하면 실패한다. 주소를 다음 실행에 재사용하지 않는다.
- 로컬 중계 성공을 서로 다른 외부망 검증으로 보고하지 않는다. 외부망·실기기 확인은 미실행으로 남긴다.
