---
name: round-finish
description: ROUND 작업을 마치기 직전에 사용한다. 기준 커밋부터 전체 변경 확인, 남은 검사 판단, output/agent-validation.md 검증 기록 갱신, 요청 시 변경 종류별 커밋과 결과 보고를 처리한다.
argument-hint: '[기준 커밋]'
---

# ROUND 작업 마무리

`docs/agent-validation.md`의 "작업 종료 직전"과 "다음 작업에 남길 기록"을 실행하는 절차다.
기준 커밋은 인자(`$ARGUMENTS`)나 작업 시작 때 기록한 `git rev-parse HEAD` 값을 쓴다. 둘 다 없으면 추측하지 말고 사용자에게 확인한다.

## 1. 전체 변경 확인

1. `git status --short`로 누락한 새 파일과 예상하지 않은 변경을 확인한다. 미추적 파일은 내용을 직접 읽거나 `git add -N <경로>`로 차이에 포함한다. 커밋하지 않으면 확인 후 `git reset -q -- <경로>`로 되돌린다.
2. `git diff --check <기준 커밋> --`로 공백 오류를 확인한다.
3. `git diff --stat <기준 커밋> --` 뒤에 `git diff <기준 커밋> --`를 읽는다.
4. 다음 누락을 확인한다.
   - 패키지 경계: `rtc-core`의 React 의존, Java 계층 규칙
   - 책임 배치: WebSocket 핸들러의 서비스 규칙, 화면 컴포넌트의 세션 로직
   - 공개 계약: `packages/protocol`과 Java `ProtocolParser`의 형식·오류 코드 일치
   - 문서·테스트: 바뀐 동작에 해당하는 기존 테스트와 문서(`README.md`, `docs/`, `apps/signaling/README.md`)
5. Java 소스나 빌드 설정을 바꿨으면 `npm run check:architecture`를 실행한다. 같은 리비전에서 `npm run check:java`가 통과했다면 생략한다.

이 단계에서 새 실패나 우려가 없으면 검사를 넓히거나 반복하지 않는다.

## 2. 검증 기록

`output/agent-validation.md`(Git 제외)는 최신 항목이 위에 있고 크기가 크다. 전체를 읽지 않고 `head -40`이나 `grep -n '^#'`로 필요한 항목만 본다.
새 항목을 파일 맨 위에 추가한다. 원본 세션 출력이나 비밀값은 넣지 않는다.

```markdown
## YYYY-MM-DD <작업 제목>

- 기준 커밋: `<sha>`. 검증 완료 커밋: `<sha 또는 미커밋>`
- 변경 파일: `<경로>` (핵심 변경 한 줄)
- 실행: `<명령>` — 통과·실패 개수, 로그 `output/<이름>.log`
- 환경 실패: <원인과 해결한 조건, 없으면 생략>
- 미실행: <검사와 이유>
- 재사용 조건: 관련 소스·테스트·의존성·설정·환경이 같으면 재사용한다. CI는 별도.
```

맨 위에 추가할 때는 스크래치 파일에 항목을 쓰고 `cat <항목> output/agent-validation.md > <임시> && mv <임시> output/agent-validation.md`로 합친다.

## 3. 커밋

사용자가 커밋을 요청한 경우에만 수행한다.

- 변경 종류별로 나눠 커밋한다. 메시지는 최근 기록처럼 `<타입>: <한국어 요약>` 형식이다(`feat`, `fix`, `refactor`, `docs`, `test` 등).
- 커밋 후 코드가 같으면 검사를 다시 실행하지 않는다. 기록의 "검증 완료 커밋"만 갱신한다.

## 4. 보고

간결한 한국어로 다음만 보고한다.

- 바뀐 동작과 주요 파일
- 실행한 검사와 결과(실패가 있으면 출력 요지)
- 실행하지 않은 검사와 이유, 남은 확인 조건(외부망 TURN, 실기기, CI 등)
