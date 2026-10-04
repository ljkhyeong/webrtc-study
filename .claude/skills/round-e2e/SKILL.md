---
name: round-e2e
description: ROUND의 입장·협상·채팅·미디어·화면 공유·재연결·모바일 배치·BATON 입장을 실제 브라우저(Playwright, headless)로 확인할 때 사용한다. 두 참가자 흐름 검증, e2e 실패 분석, e2e 테스트 추가에 사용한다.
argument-hint: '[e2e 파일 또는 확인할 동작]'
---

# ROUND 브라우저 검증

`AGENTS.md`의 검증 선택을 따른다. 바뀐 동작에 해당하는 파일과 프로젝트만 실행한다.
사용자가 화면 확인을 요청하지 않으면 headless로 실행하고 창·포커스·OS 클립보드를 사용하지 않는다.

## 대상 선택

`playwright.config.ts`의 `projects[].testMatch`가 기준이다. 현재 구성은 다음과 같다.

- 입장 준비·미디어 전달·화면 공유·장치 교체: `e2e/standalone-room-media.spec.ts`
- 한글 입력·채팅 전송 상태: `e2e/standalone-room-chat.spec.ts`
- 방장 제어·퇴장·장치 종료 복구: `e2e/standalone-room-recovery.spec.ts`
- 위 세 파일은 `chromium-full-media`, 모바일 배치는 `chromium-mobile-layout`·`webkit-mobile-layout`, WebKit 호환은 `webkit-smoke` 프로젝트다.
- BATON 입장(인증 전 장치 차단, 401 안내): `e2e/baton-entry.spec.ts`를 BATON 설정으로 실행한다.
- BATON 운영 edge 이미지(`npm run test:e2e:baton-edge`)는 Docker 이미지를 빌드하므로 edge·Caddy 설정을 바꿨을 때만 실행한다.

## 실행

이 스킬 폴더의 설정은 저장소 설정을 상속하고 headless·`--mute-audio`·캐시된 Chromium 경로·Faro 비활성만 바꾼다.
`output/`에 일회용 설정을 새로 만들지 않는다.

1. `lsof -nP -iTCP:5173 -iTCP:8787 -sTCP:LISTEN`으로 포트를 확인한다. 다른 작업의 서버는 종료하지 않고, 인증 모드가 다른 서버를 재사용하지 않는다.
2. 표준 흐름은 Bash 백그라운드로 실행하고 로그만 남긴다.

   ```bash
   ROUND_E2E_OUTPUT=<작업명> npx playwright test --config .claude/skills/round-e2e/standalone.playwright.config.ts <e2e 파일> > output/<작업명>-e2e.log 2>&1
   ```

   다른 프로젝트는 `ROUND_E2E_PROJECTS=webkit-smoke,chromium-mobile-layout`처럼 쉼표로 지정한다.

3. BATON 입장은 외부 주소 없이 로컬 개발 서버로 실행한다.

   ```bash
   ROUND_BATON_E2E_BASE_URL= ROUND_BATON_E2E_EDGE=false ROUND_E2E_OUTPUT=<작업명> npx playwright test --config .claude/skills/round-e2e/baton.playwright.config.ts > output/<작업명>-baton-e2e.log 2>&1
   ```

4. 결과는 로그 끝부분과 실패 항목만 읽는다. 실패 자료는 `output/playwright/<작업명>/`의 `error-context.md`와 스크린샷을 본다. trace 뷰어처럼 창을 여는 도구는 사용하지 않는다.
5. 종료 후 5173·8787 포트가 해제됐는지 확인한다.

설정을 고치지 않고도 실행 대상을 바꿀 수 있다. 실행 설정이 부족할 때만 이 폴더의 설정을 수정한다.

### 다른 포트의 미리보기 서버

5173·8787을 다른 작업이 쓰거나 화면 점검용 서버를 오래 띄워 둘 때 사용한다. 웹 포트를 바꾸면 서버의 `ALLOWED_ORIGINS`도 같은 주소로 맞춰야 한다.
두 명령은 각각 Bash 백그라운드로 실행하고, 작업이 끝나면 직접 종료한다.

```bash
HOST=127.0.0.1 PORT=8788 ROUND_AUTH_MODE=standalone ROUND_STANDALONE_HOST_TOKEN_SHA256=<playwright.config.ts의 값> ROUND_E2E_MODE=true TURN_PROVIDER=disabled ALLOWED_ORIGINS=http://127.0.0.1:5180 node scripts/run-gradle.mjs :apps:signaling:bootRun > output/preview-signaling.log 2>&1
```

```bash
cd apps/web && PORT=8788 VITE_ROUND_AUTH_MODE=standalone VITE_SIGNALING_URL= VITE_STUN_URLS= VITE_TURN_CREDENTIALS_URL= VITE_FARO_COLLECTOR_URL= npx vite --host 127.0.0.1 --port 5180 --strictPort > ../../output/preview-web.log 2>&1
```

`ROUND_E2E_BASE_URL=http://127.0.0.1:5180`을 지정하면 설정이 서버를 새로 띄우지 않고 이 서버로 실행한다. 패키지 변경이 있으면 서버를 띄우기 전에 `npm run build:packages`를 실행한다.

## 실패 처리

- `5173/healthz is already used`는 다른 서버가 포트를 쓰는 상태다. 점유 프로세스를 `ps`·`lsof`로 확인하고 종료하지 않는다. 아래 "다른 포트의 미리보기 서버"로 실행하거나, 실행하지 못하면 미실행으로 남긴다.
- 서버 시작 실패는 로그의 해당 부분만 한 번 확인한다. 원인을 찾은 뒤 같은 환경에서 전체 검사를 다시 시작하지 않는다.
- `EPERM`·포트 바인딩·브라우저 실행 거부는 환경 문제다. 권한 승인을 받아 실행하고 조건을 바꾸기 전에는 반복하지 않는다.
- 반복 실행으로 IP별 발급 제한(429)에 걸리면 이 작업의 서버만 재시작해 상태를 초기화한다. 테스트를 위해 제품의 제한값을 늘리지 않는다.
- Chromium이 없으면 `npx playwright install chromium`을 승인받아 실행한다.

## 테스트 작성

새 동작이나 재발할 오류를 확인할 때만 추가한다.

- 두 참가자 흐름은 `e2e/standalone-room.fixture.ts`의 `runConnectedRoom`·`expectRemoteMedia`를 사용한다. fixture는 콘솔 오류와 페이지 오류를 실패로 모으고, `getDisplayMedia`를 캔버스 스트림으로 대체한다.
- 미리보기의 active 표시만으로 입장·피어 연결을 판단하지 않는다. 참가자 수나 `getStats` 결과를 기다린다.
- 비동기 `getStats` 조건은 `expect.poll(() => page.evaluate(async () => ...))`로 확인한다. async 함수를 `waitForFunction`에 넘기지 않는다.
- 로컬 STUN·가상 장치 결과를 외부망 TURN이나 실제 기기 검증으로 보고하지 않는다.
