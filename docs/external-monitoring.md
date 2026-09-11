# 외부 접속·백업 알림 설정

이 문서는 선택 설치 절차입니다. 저장소의 설정만으로 외부 계정이나 알림이 활성화되지 않습니다.
Grafana Cloud 스택, Healthchecks.io 검사 두 개, 운영 연락처가 필요합니다. 계정의 사용 한도와
과금 조건을 확인한 뒤 운영자가 활성화합니다. 비밀 URL·토큰은 채팅이나 Git에 남기지 않습니다.

## 외부 HTTPS와 인증서

내부 Alloy 지표만으로는 공인 DNS·인증서·방화벽·Caddy 장애를 확인할 수 없습니다.
Grafana Cloud의 **Testing & synthetics → Synthetics**에서 HTTP 검사를 만듭니다.

| 설정                                   | 값                                  |
| -------------------------------------- | ----------------------------------- |
| 작업 이름                              | `round-public-https`                |
| 검사 주소                              | `https://실제-ROUND-도메인/healthz` |
| 검사 위치                              | 서로 다른 공개 검사 위치 두 곳      |
| 주기 / 제한 시간                       | 60초 / 10초                         |
| 요청 방식 / 정상 상태 코드             | GET / 200                           |
| 인증·요청 본문                         | 없음                                |
| 인증서 검증 비활성화 / 리다이렉트 추적 | 모두 끔                             |

시험 실행으로 두 위치의 성공을 확인한 뒤 활성 상태로 저장합니다. `/healthz`는 공개 경로이므로
공유 접근 비밀번호나 BATON 참여권을 제공하지 않습니다. 이 검사는 HTTPS 접속 가능 여부만 확인하며
로그인·WebSocket·실제 TURN 통화 검사를 대신하지 않습니다.

검사를 켠 뒤 `ops/observability/round-external-alerts.yml`을 Grafana Alerting에서 Prometheus
규칙으로 가져오고 Synthetic Monitoring 지표가 저장되는 데이터 소스를 선택합니다. 모든 위치의
3분 연속 실패, 10분간 검사 결과 누락, 14일 이내 인증서 만료를 감지합니다. 데이터 소스 조회 실패나
데이터가 없어도 알림을 보내도록 설정하고 운영 연락처에 연결해 시험합니다.

서버 시간 기준 03:15~03:45 유지보수 창에는 `RoundPublicHttpsUnavailable` 알림만 음소거 일정으로
제외합니다. 백업 실패·누락 알림까지 끄면 복구 실패를 놓칠 수 있습니다. Grafana의 음소거 일정
시간대는 서버의 `timedatectl` 출력과 맞춥니다. 별도 수동 유지보수는 종료 시간이 있는 일시 음소거로
처리하고 종료 후 외부 검사 성공을 확인합니다.

## 백업 성공·실패·예약 누락

Healthchecks.io에 일일 백업과 주간 무결성 검사를 각각 만듭니다. 두 검사의 Cron 시간대를
서버 시간대와 동일하게 설정합니다. 서버가 `Asia/Seoul`이면 검사도 `Asia/Seoul`을 사용합니다.

| 검사                  | Cron         | Grace Time |
| --------------------- | ------------ | ---------- |
| 일일 R2 백업          | `15 3 * * *` | 40분       |
| 주간 보존·무결성 검사 | `15 4 * * 0` | 3시간      |

Grace Time은 일일 작업 종료·정리 제한, 주간 최대 30분 무작위 지연과 2시간 작업 제한을
포함합니다. timer 시각이나 제한 시간을 바꾸면 이 값도 함께 바꿉니다. 성공 ping만으로
예약 누락을 감지하므로 `/start` 신호나 별도 스케줄러는 필요하지 않습니다.

각 검사에 운영 알림 채널을 연결합니다. 요청 방식은 POST만 허용하고 본문 기반 판정은 끕니다.
성공 URL은 검사 기본 ping URL, 실패 URL은 그 뒤에 `/fail`을 붙인 값입니다.

서버에 curl을 설치한 뒤 저장소 루트에서 다음 파일을 준비합니다. systemd 추가 설정(drop-in)을
설치하기 전이므로 이 단계에서는 백업 동작이 바뀌지 않습니다.

```bash
install -d -m 0700 /etc/round/healthchecks
for job in backup maintenance; do
  install -m 0600 ops/linux/healthchecks/success.curl.example \
    "/etc/round/healthchecks/round-offsite-$job.service-success.curl"
  install -m 0600 ops/linux/healthchecks/fail.curl.example \
    "/etc/round/healthchecks/round-offsite-$job.service-fail.curl"
done
```

네 파일의 `CHECK_UUID`를 해당 작업의 실제 검사 UUID로 교체합니다. 성공·실패 파일은 같은
작업끼리 같은 UUID를 써야 합니다. root 소유 0600을 유지하고 편집기 임시 파일도 보호합니다.
URL은 curl 설정 파일에서만 읽으므로 systemd 명령행 인수에 노출하지 않습니다. 로그 본문은
외부로 보내지 않습니다. 기존 파일이 있으면 위 설치 명령으로 덮어쓰지 말고 내용을 확인합니다.

```bash
install -m 0644 ops/linux/healthchecks/round-healthchecks-failure@.service /etc/systemd/system/
for job in backup maintenance; do
  install -d -m 0755 "/etc/systemd/system/round-offsite-$job.service.d"
  install -m 0644 ops/linux/healthchecks/10-healthchecks.conf \
    "/etc/systemd/system/round-offsite-$job.service.d/10-healthchecks.conf"
done
systemctl daemon-reload
```

설치 시 서비스를 재시작하거나 백업을 즉시 실행하지 않습니다. 다음 예약부터 성공·실패를
전달합니다. `ExecStartPost`는 로컬 백업 파일 생성과 R2 전송이 모두 성공한 뒤 실행됩니다.
주간 작업도 보존 정리와 `restic check`가 모두 성공해야 성공 ping을 보냅니다. 기본
`round-ops` 오류 기록은 유지하고 실패 알림 서비스를 추가합니다.

각 ping은 연결 대기 5초·전체 10초로 제한합니다. 알림 전송 장애 때문에 성공한 백업을
실패로 바꾸지 않습니다. 전송 실패나 서버 종료로 신호가 없으면 외부 검사에서 예약 누락으로
알립니다. Healthchecks 화면의 최근 ping과 systemd 로그를 함께 확인해 작업 실패와 알림 전송
장애를 구분합니다. 성공 신호는 명령의 정상 종료만 뜻하며 실제 복원 검사를 대신하지 않습니다.

## 활성화 확인과 해제

- Grafana 연락처 테스트가 도착하고 공개 HTTPS 두 위치의 실제 성공을 확인합니다.
- 운영 검사와 다른 시험용 Healthchecks 검사에서 `/fail`·성공·기한 초과 알림을 확인합니다.
  시험 ping으로 운영 백업 성공 이력을 만들지 않습니다.
- 다음 예약 실행 뒤 R2 백업 스냅샷과 Healthchecks 성공 시각을 함께 확인합니다. 지금 백업을
  실행해야 한다면 Caddy를 중단할 수 있는 유지보수 시간을 먼저 확보합니다.
- 서버 중단으로 일일 백업이 누락되면 알림을 받고, 재부팅 뒤 자동 보충 실행하지 않는 기존
  정책은 유지합니다. 복구 확인 없이 성공 ping을 수동으로 보내지 않습니다.
- 알림만 해제할 때는 두 서비스의 `10-healthchecks.conf`를 `.disabled` 확장자로 옮기고
  `systemctl daemon-reload`를 실행합니다. 백업 timer는 그대로 두며 외부 검사도 의도에 맞게
  중지합니다. 비밀이 유출되면 해당 Healthchecks UUID를 회전하고 네 파일을 갱신합니다.

공식 참고: [Grafana HTTP 검사](https://grafana.com/docs/grafana-cloud/observe-and-act/testing/synthetic-monitoring/create-checks/checks/http/),
[Healthchecks 예약 설정](https://healthchecks.io/docs/configuring_checks/),
[Healthchecks ping API](https://healthchecks.io/docs/http_api/).
