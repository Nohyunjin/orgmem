# orgmem — worker rules

이 프로젝트는 여러 Claude Code 에이전트(Lane A/B/C)가 cmux 워크스페이스에서 동시에 일하는 구조. 아래 규칙은 워커 누구든 적용.

## cmux 리포팅 규칙 (필수)

다른 surface로 메시지 보낼 때 반드시 **두 단계**로 분리:

```bash
cmux send --surface surface:<N> "메시지 내용"
cmux send-key --surface surface:<N> enter
```

### 절대 하지 말 것

- `cmux send "text\n"` 한 번만 쓰기 — `\n`은 literal newline이고 실제 Enter 키 이벤트가 아님. TUI 앱(Claude Code 등)은 입력창에 텍스트만 남겨두고 submit 안 함. 수신자가 메시지 못 받음.
- `cmux send-key ... enter` 만 먼저 쓰기 — 빈 입력창에 Enter만 보내면 아무 동작 안 함.

### 올바른 순서

1. `cmux send --surface surface:<N> "..."` — 텍스트 입력창 채움
2. `cmux send-key --surface surface:<N> enter` — submit 이벤트 발화
3. (선택) `cmux read-screen --surface surface:<N> --lines 5` — 수신 확인

### 자주 실수하는 패턴

- 두 명령을 `&&`로 묶어 한 줄에 쓰기 → 첫 번째가 조용히 실패해도 모름. 매번 **2개 별도 bash call**.
- `enter` 대신 `return` / `newline` 쓰기 → 공식 키 이름은 `enter` 소문자.
- 긴 메시지에 내부 큰따옴표 섞기 → shell escape 꼬임. `'single quotes'` 바깥 + `\"` 내부 이스케이프.

## 마일스톤 보고 규칙 (필수)

**모든 commit+push 직후 즉시** `surface:8`(메인 제어 세션)에 한 줄 요약:

```bash
cmux send --surface surface:8 "<Lane>: <마일스톤> (commit <sha>, <X> tests)"
cmux send-key --surface surface:8 enter
```

recap만 찍고 넘어가지 말 것. 메인 세션은 recap을 안 보며, 당신이 surface:8로 명시적으로 보낸 메시지만 읽음.

## Lane / surface 명명 (현재 워크스페이스)

| surface | 역할 |
|---|---|
| surface:8 | 메인 제어 (유저 + 관제 에이전트). 보고 수신처. |
| surface:7 | Lane A — graph engine trunk |
| surface:10 | Lane B — MCP server |
| surface:9 | Lane C — Decision Extractor + eval |

다른 Lane에 cross-lane 요청 있을 때도 위 규칙 그대로.

## 기타

- 큰 결정(아키텍처 변경, 스코프 확장)은 surface:8로 질문 먼저, 답 받고 실행.
- 작은 결정(파일명, 내부 헬퍼 구조)은 자율 판단.
- 테스트 실패 상태로 commit 금지. 항상 `bun test` green + `tsc --noEmit` clean 후 push.
