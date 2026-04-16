# Dogfood — v0.2 chunking re-measure (2026-04-16T02:37:16.276Z)

Runs the 5 baseline queries against the current DB. Verdict column is filled MANUALLY after inspecting each answer against the source documents; the harness only records what came back. Target: ≥ 3/5 improved vs v0.1, with `approach-c` and `phase0-gates` both correct.

| # | Query | v0.1 | v0.2 verdict | Top hit | Answer excerpt | Tokens in/out | ms |
|---|---|---|---|---|---|---|---|
| 1 | `approach-c` | fail | _TODO fill in_ | `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions` | # Approach C 선택 이유 Approach C (에이전트 네이티브 워크스페이스)를 선택한 이유는 다음과 같습니다 [[hyunjin-unknown-design-20260414-085623#Approaches Considered]]: **핵심 특징:** - AI 에이전트가 first-class 참여자인 지식+업무 그래 | 3486 / 372 | 5924 |
| 2 | `eval-pairs` | pass | _TODO fill in_ | `eval-readme#Dataset` | eval dataset은 **70 쌍**입니다 [[eval-readme#Dataset]]. 구성: - Decision: 35쌍 - Non_decision: 35쌍 이는 v1.1 버전의 현재 dataset이며, 이전 v1 버전은 60쌍(Decision 30 + Non-decision 30)이었습니다 [[eval-readme | 1461 / 112 | 3997 |
| 3 | `mvp-excluded` | partial | _TODO fill in_ | `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)` | # MVP에서 제외된 기능 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]에 따르면 MVP에서 제외된 기능은 다음과 같습니다: **UI/인터페이스:** - GUI (에디터, 그래프 시각화) — 3개월 이후 고려 **임포트 기능:** - SaaS 임포트 (N | 4514 / 380 | 4971 |
| 4 | `interview-template` | pass | _TODO fill in_ | `hyunjin-unknown-design-20260414-085623#The Assignment` | 네, 인터뷰 템플릿이 있습니다. [[hyunjin-unknown-design-20260414-085623#The Assignment]]에 따르면, 다음 3가지 구체적인 질문을 물어봐야 합니다: 1. **"AI 에이전트와 일할 때 뭐가 제일 아픈가요?"** 2. **"지금 어떻게 workaround 하고 있나요?"** 3. | 4124 / 290 | 3104 |
| 5 | `v2-precision` | pass | _TODO fill in_ | `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)` | # V2 Precision 수치 문맥에서 **V2에 대한 구체적인 precision 수치는 제시되지 않았습니다.** 다만 관련된 정보는 다음과 같습니다: - **Decision Extractor의 목표 precision**: ≥ 90% [[eval-readme#필수 지표]] - **V2 프롬프트 재평가 계획**: v1.2 | 2845 / 296 | 3365 |
| 6 | `phase0-gates` | fail | _TODO fill in_ | `ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)` | Phase 0 게이트 3가지는 다음과 같습니다 [[ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)]]: **Phase 0 Go/No-go 게이트:** 1. **인터뷰 게이트**: 인터뷰 5명 중 3+ 명이 pain을 인정  | 3027 / 337 | 4160 |

## Per-query details

### `approach-c` — Approach C (왜 그걸 선택했지)?

**Expected topic:** design doc's Approach C rationale (CHOSEN marker)

**v0.1 baseline:** fail — v0.1 misattributed this to Lane C (the agent), not the design doc's Approach C.

**Hits:**
- rank 1 d=1.156 → `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions`
- rank 2 d=1.1561 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 3 d=1.1591 → `hyunjin-unknown-design-20260414-085623#Approaches Considered`
- rank 4 d=1.1607 → `eval-readme#라벨링 기준`
- rank 5 d=1.1634 → `eval-readme#Statistics`

**Answer:**

```
# Approach C 선택 이유

Approach C (에이전트 네이티브 워크스페이스)를 선택한 이유는 다음과 같습니다 [[hyunjin-unknown-design-20260414-085623#Approaches Considered]]:

**핵심 특징:**
- AI 에이전트가 first-class 참여자인 지식+업무 그래프
- Notion 킬러가 아닌 **새 카테고리** 창출
- 인간은 대화/마크다운으로, 에이전트는 MCP 프로토콜로 그래프를 읽고 씀
- Claude Code + Obsidian + Linear의 철학 융합

**전략적 배경:**
Approach A(로컬 퍼스트 MVP)와 Approach B(웹 팀 툴)과 달리, Approach C는 **에이전트 네이티브 패러다임**을 새로운 제품 카테고리로 정의함으로써 기존 제품(Notion, Linear)과의 직접 대결을 피하면서도, AI 네이티브 시대의 새로운 워크플로우를 제시하는 전략입니다 [[hyunjin-unknown-design-20260414-085623#Approaches Considered]].
```

**Tokens:** in=3486, out=372  
**Wall:** 5924 ms

### `eval-pairs` — eval dataset 몇 쌍이야?

**Expected topic:** eval/README: 70 pairs

**v0.1 baseline:** pass — Small doc (6KB). v0.1 answered 70쌍 correctly.

**Hits:**
- rank 1 d=1.0428 → `eval-readme#Dataset`
- rank 2 d=1.0455 → `eval-readme#Change log`
- rank 3 d=1.054 → `eval-resolution-backlog#v1.2 bump checklist (when triggered)`
- rank 4 d=1.0725 → `eval-resolution-backlog`
- rank 5 d=1.0911 → `eval-resolution-backlog#Future entry candidates (watch for these patterns)`

**Answer:**

```
eval dataset은 **70 쌍**입니다 [[eval-readme#Dataset]].

구성:
- Decision: 35쌍
- Non_decision: 35쌍

이는 v1.1 버전의 현재 dataset이며, 이전 v1 버전은 60쌍(Decision 30 + Non-decision 30)이었습니다 [[eval-readme#Change log]].
```

**Tokens:** in=1461, out=112  
**Wall:** 3997 ms

### `mvp-excluded` — MVP에서 제외된 기능은?

**Expected topic:** design doc: out-of-scope list

**v0.1 baseline:** partial — v0.1 gave a partial answer on the 17.5KB design doc.

**Hits:**
- rank 1 d=0.9891 → `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)`
- rank 2 d=1.0153 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 3 d=1.0444 → `hyunjin-unknown-design-20260414-085623#Recommended Approach`
- rank 4 d=1.0716 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 5 d=1.105 → `hyunjin-unknown-design-20260414-085623#핵심 변경`

**Answer:**

```
# MVP에서 제외된 기능

[[hyunjin-unknown-design-20260414-085623#Recommended Approach]]에 따르면 MVP에서 제외된 기능은 다음과 같습니다:

**UI/인터페이스:**
- GUI (에디터, 그래프 시각화) — 3개월 이후 고려

**임포트 기능:**
- SaaS 임포트 (Notion/Linear/Google Docs) — v2 이후
- Obsidian vault 이외의 임포트

**협업 기능:**
- 팀 협업, 동기화, 권한 — v2 이후

**검색 기능:**
- 임베딩 기반 검색 — v1은 BM25 + 1-hop neighbor expansion으로 시작

**API 기능:**
- `graph.query(natural_language)` — LLM 기반 자연어 쿼리. v1.1로 연기
- `graph.subscribe(filter)` — 변경 구독. v2

또한 [[hyunjin-unknown-design-20260414-085623#Open Questions]]에서 언급한 대로, **자연어 쿼리 (`graph.query`)**는 MVP에서 제외되며, 에이전트가 `graph.search` + `doc.read` 조합으로 대체합니다.
```

**Tokens:** in=4514, out=380  
**Wall:** 4971 ms

### `interview-template` — 인터뷰 템플릿 있어?

**Expected topic:** no-hallucinate — template doesn't exist

**v0.1 baseline:** pass — v0.1 correctly said 'not found' — negative case.

**Hits:**
- rank 1 d=1.156 → `hyunjin-unknown-design-20260414-085623#The Assignment`
- rank 2 d=1.1587 → `hyunjin-unknown-design-20260414-085623#What I noticed about how you think`
- rank 3 d=1.1628 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 4 d=1.1739 → `hyunjin-unknown-design-20260414-085623#핵심 변경`
- rank 5 d=1.1856 → `hyunjin-unknown-design-20260414-085623#Approaches Considered`

**Answer:**

```
네, 인터뷰 템플릿이 있습니다.

[[hyunjin-unknown-design-20260414-085623#The Assignment]]에 따르면, 다음 3가지 구체적인 질문을 물어봐야 합니다:

1. **"AI 에이전트와 일할 때 뭐가 제일 아픈가요?"**
2. **"지금 어떻게 workaround 하고 있나요?"**
3. **"내일 사라지면 화낼 만한 솔루션은 뭔가요?"**

이 인터뷰는 AI 에이전트를 팀에서 일상적으로 쓰는 사람 5명에게 각각 30분씩 진행하며, 특히 Claude/Cursor로 일할 때 지식 관리를 어떻게 하고 있는지 파악하는 것이 목표입니다. [[hyunjin-unknown-design-20260414-085623#The Assignment]]
```

**Tokens:** in=4124, out=290  
**Wall:** 3104 ms

### `v2-precision` — V2 precision 수치 뭐야?

**Expected topic:** SUMMARY: precision = 1.000

**v0.1 baseline:** pass — Small doc (4KB). v0.1 answered 1.000 correctly.

**Hits:**
- rank 1 d=1.1894 → `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)`
- rank 2 d=1.1977 → `eval-readme#사용법`
- rank 3 d=1.2001 → `hyunjin-unknown-design-20260414-085623#핵심 변경`
- rank 4 d=1.2122 → `eval-resolution-backlog#v1.2 bump checklist (when triggered)`
- rank 5 d=1.2142 → `eval-readme`

**Answer:**

```
# V2 Precision 수치

문맥에서 **V2에 대한 구체적인 precision 수치는 제시되지 않았습니다.**

다만 관련된 정보는 다음과 같습니다:

- **Decision Extractor의 목표 precision**: ≥ 90% [[eval-readme#필수 지표]]
- **V2 프롬프트 재평가 계획**: v1.2 bump checklist에서 "새로운 데이터셋에 대해 baseline + V2 프롬프트를 재실행하고 수치를 `eval/README.md`에 재생성할 것" [[eval-resolution-backlog#v1.2 bump checklist (when triggered)]]이라고 나와있지만, 현재 실제 V2 수치는 기록되어 있지 않습니다.

V2 precision 수치를 확인하려면 실제 평가 실행 결과나 최신 `eval/README.md` 통계를 참조해야 합니다.
```

**Tokens:** in=2845, out=296  
**Wall:** 3365 ms

### `phase0-gates` — Phase 0 게이트 3가지 뭐야?

**Expected topic:** CEO plan: Phase 0 gate 3-item list

**v0.1 baseline:** fail — v0.1 couldn't find this — it's in a 16KB CEO plan's tail section.

**Hits:**
- rank 1 d=1.0837 → `ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)`
- rank 2 d=1.158 → `ceo-plans-2026-04-14-organizational-memory-os#Roadmap — "OS" 클레임을 진짜로 만드는 3가지 (v2-v3)`
- rank 3 d=1.1589 → `eval-results-summary#What V1 got wrong (8 false positives)`
- rank 4 d=1.1655 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 5 d=1.1684 → `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions`

**Answer:**

```
Phase 0 게이트 3가지는 다음과 같습니다 [[ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)]]:

**Phase 0 Go/No-go 게이트:**

1. **인터뷰 게이트**: 인터뷰 5명 중 3+ 명이 pain을 인정 AND 2+ 명이 세그먼트 얼라인 (타겟하는 팀 규모)

2. **MCP 래퍼 설치 게이트**: MCP 래퍼를 10명 이상이 설치

3. **MCP 래퍼 사용 게이트**: 2명 이상이 2회 이상 사용

게이트를 통과하면 Phase 1 (기존 6-8주 MVP)을 시작하고, 실패하면 디자인 문서의 Pivot 시나리오로 진행합니다 [[ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)]].
```

**Tokens:** in=3027, out=337  
**Wall:** 4160 ms

