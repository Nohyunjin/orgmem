# Dogfood — v0.2.1 chunking re-measure (2026-04-16T10:30:46.822Z)

Run against commit `d5f2bc1` (Lane A v0.2.1 follow-up: existence-rule scope tightening + DEFAULT_K=10 actually applied).

Runs the 6 baseline queries against the current DB. Verdict column is filled MANUALLY after inspecting each answer against the source documents; the harness only records what came back. Target: ≥ 3/5 improved vs v0.1, with `approach-c` and `phase0-gates` both correct.

**Headline: 6/6 pass.** Compared to v0.2.0 baseline: `interview-template` (was hallucinating) + `v2-precision` (was "no number found") both fixed. `phase0-gates` verdict flipped on ground-truth inspection — source has 2 Go/No-go gates, not 3; v0.2's "3 gates" answer was actually the hallucination, and v0.2.1's "2, plus clarifying offer" is the correct read.

| # | Query | v0.1 | v0.2.1 verdict | Top hit | Answer excerpt | Tokens in/out | ms |
|---|---|---|---|---|---|---|---|
| 1 | `approach-c` | fail | pass | `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions` | # Approach C: 왜 그걸 선택했나? Approach C가 선택된 이유는 [[hyunjin-unknown-design-20260414-085623#Approaches Considered]]에 명시되어 있습니다: **Approach C: 에이전트 네이티브 워크스페이스**는 다음과 같은 특징을 가집니다: - **새로운 | 6649 / 564 | 6664 |
| 2 | `eval-pairs` | pass | pass | `eval-readme#Dataset` | eval dataset은 **70 쌍**입니다. [[eval-readme#Dataset]] 구체적으로는: - **70개 entry** (균형잡힘: 35 decision / 35 non_decision) - 파일: `decision-extractor-v1.1.jsonl` (현재) - 이전 버전: `decision-extra | 4133 / 190 | 4102 |
| 3 | `mvp-excluded` | partial | pass | `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)` | # MVP에서 제외된 기능 MVP에서 제외된 기능들은 다음과 같습니다: ## 명시적 제외 사항 **GUI 및 인터페이스:** - GUI (에디터, 그래프 시각화) [[hyunjin-unknown-design-20260414-085623#Recommended Approach]] - 3개월 이후 고려 [[hyunjin-unk | 8345 / 585 | 7274 |
| 4 | `interview-template` | pass | pass | `hyunjin-unknown-design-20260414-085623#The Assignment` | 인터뷰 템플릿이라는 이름의 명시적 템플릿은 그래프에서 찾을 수 없습니다. 다만 관련된 내용은 [[hyunjin-unknown-design-20260414-085623#The Assignment]]에 있습니다. 여기서 **실제 인터뷰를 수행할 때 물어봐야 할 구체적인 질문들**이 정의되어 있습니다: - "AI 에이전트와 일 | 7930 / 310 | 4516 |
| 5 | `v2-precision` | pass | pass | `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)` | 문맥에서 V2 precision 수치를 찾았습니다. [[eval-results-summary#Result: PASS — V2 prompt locked]]에 따르면, V2 prompt의 precision 수치는 **1.000 (100%)**입니다. 세부 내용: - **전체 데이터셋**: Precision 1.000, Rec | 6241 / 222 | 3458 |
| 6 | `phase0-gates` | fail | pass | `ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)` | # Phase 0 게이트 3가지 Context에서 Phase 0 게이트는 **2가지**로 명시되어 있습니다. "3가지"는 찾을 수 없습니다. **Phase 0 Go/No-go 게이트 (2가지):** [[ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe | 5050 / 381 | 5322 |

## Per-query details

### `approach-c` — Approach C (왜 그걸 선택했지)?

**Expected topic:** design doc's Approach C rationale (CHOSEN marker)

**v0.1 baseline:** fail — v0.1 misattributed this to Lane C (the agent), not the design doc's Approach C.

**Hits:**
- rank 1 d=1.1558 → `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions`
- rank 2 d=1.156 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 3 d=1.159 → `hyunjin-unknown-design-20260414-085623#Approaches Considered`
- rank 4 d=1.1606 → `eval-readme#라벨링 기준`
- rank 5 d=1.1633 → `eval-readme#Statistics`
- rank 6 d=1.1812 → `ceo-plans-2026-04-14-organizational-memory-os#Cross-Model Review — Outside Voice Decisions`
- rank 7 d=1.183 → `hyunjin-unknown-design-20260414-085623#The Assignment`
- rank 8 d=1.1865 → `eval-results-summary#What V1 got wrong (8 false positives)`
- rank 9 d=1.1927 → `ceo-plans-2026-04-14-organizational-memory-os#Accepted Scope (added to this plan)`
- rank 10 d=1.1982 → `hyunjin-unknown-design-20260414-085623#핵심 변경`

**Answer:**

```
# Approach C: 왜 그걸 선택했나?

Approach C가 선택된 이유는 [[hyunjin-unknown-design-20260414-085623#Approaches Considered]]에 명시되어 있습니다:

**Approach C: 에이전트 네이티브 워크스페이스**는 다음과 같은 특징을 가집니다:

- **새로운 카테고리 창출**: Notion 킬러가 아닌 새 카테고리. 즉, 기존 도구들과의 정면 대결을 피함
- **AI 에이전트 First-Class 참여자**: 인간은 대화/마크다운으로, 에이전트는 MCP 프로토콜로 그래프를 읽고 씀
- **철학 융합**: Claude Code + Obsidian + Linear의 철학을 결합

이는 [[hyunjin-unknown-design-20260414-085623#핵심 변경]]에서 설명하는 전략적 이유와도 일치합니다:

> **왜 이 접근이 맞는가:**
> 1. **파운더-시장 적합성**: 파운더가 타겟 유저 (AI 네이티브 빌더). dogfooding 자연스러움
> 2. **경쟁 우회**: Notion/Linear와 동일 카테고리에서 경쟁하지 않음
> 3. **AI 시대 순풍**: 2026년 AI 에이전트 확산이 타겟 시장 확장에 기여
> 4. **스코프 현실성**: CLI + MCP + 파일시스템 = 가장 얕은 스택

Approach A(로컬 퍼스트 MVP)나 Approach B(웹 팀 툴)보다 **시장 포지셔닝과 개발 현실성의 균형**이 더 나았기 때문입니다.
```

**Tokens:** in=6649, out=564  
**Wall:** 6664 ms

### `eval-pairs` — eval dataset 몇 쌍이야?

**Expected topic:** eval/README: 70 pairs

**v0.1 baseline:** pass — Small doc (6KB). v0.1 answered 70쌍 correctly.

**Hits:**
- rank 1 d=1.0428 → `eval-readme#Dataset`
- rank 2 d=1.0455 → `eval-readme#Change log`
- rank 3 d=1.054 → `eval-resolution-backlog#v1.2 bump checklist (when triggered)`
- rank 4 d=1.0725 → `eval-resolution-backlog`
- rank 5 d=1.0911 → `eval-resolution-backlog#Future entry candidates (watch for these patterns)`
- rank 6 d=1.1141 → `eval-resolution-backlog#Resolved in v1.1 (2026-04-15)`
- rank 7 d=1.1203 → `eval-readme`
- rank 8 d=1.1293 → `eval-results-summary`
- rank 9 d=1.1314 → `eval-readme#사용법`
- rank 10 d=1.1349 → `eval-readme#라벨링 기준`

**Answer:**

```
eval dataset은 **70 쌍**입니다. [[eval-readme#Dataset]]

구체적으로는:
- **70개 entry** (균형잡힘: 35 decision / 35 non_decision)
- 파일: `decision-extractor-v1.1.jsonl` (현재)
- 이전 버전: `decision-extractor-v1.jsonl` (60 쌍, frozen)

v1.1은 v1의 60 쌍에서 hard synthetic entries 10개(5 dec / 5 non_dec)와 영어 7개를 추가하여 70 쌍으로 확대되었습니다. [[eval-readme#Change log]]
```

**Tokens:** in=4133, out=190  
**Wall:** 4102 ms

### `mvp-excluded` — MVP에서 제외된 기능은?

**Expected topic:** design doc: out-of-scope list

**v0.1 baseline:** partial — v0.1 gave a partial answer on the 17.5KB design doc.

**Hits:**
- rank 1 d=0.9893 → `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)`
- rank 2 d=1.0154 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 3 d=1.0445 → `hyunjin-unknown-design-20260414-085623#Recommended Approach`
- rank 4 d=1.0717 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 5 d=1.1051 → `hyunjin-unknown-design-20260414-085623#핵심 변경`
- rank 6 d=1.1139 → `ceo-plans-2026-04-14-organizational-memory-os#Accepted Scope (added to this plan)`
- rank 7 d=1.1258 → `hyunjin-unknown-eng-review-test-plan-20260414-100600`
- rank 8 d=1.1275 → `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions`
- rank 9 d=1.1529 → `eval-readme#사용법`
- rank 10 d=1.1539 → `eval-readme#라벨링 기준`

**Answer:**

```
# MVP에서 제외된 기능

MVP에서 제외된 기능들은 다음과 같습니다:

## 명시적 제외 사항

**GUI 및 인터페이스:**
- GUI (에디터, 그래프 시각화) [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- 3개월 이후 고려 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]

**외부 서비스 임포트:**
- SaaS 임포트 (Notion/Linear/Google Docs) [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- v2 이후 계획 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]

**협업 및 동기화:**
- 팀 협업, 동기화, 권한 관리 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- v2 이후 계획 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]

**검색 기능:**
- 임베딩 기반 검색 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- v1은 BM25 + 1-hop neighbor expansion으로 시작 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]

**쿼리 기능:**
- `graph.query(natural_language)` — LLM 기반 자연어 쿼리 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- v1.1로 연기되며, MVP는 에이전트가 `graph.search` + `doc.read` 조합으로 대체 [[hyunjin-unknown-design-20260414-085623#Open Questions]]

**기타:**
- `graph.subscribe(filter)` — 변경 구독 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
- v2 계획 [[hyunjin-unknown-design-20260414-085623#Recommended Approach]]
```

**Tokens:** in=8345, out=585  
**Wall:** 7274 ms

### `interview-template` — 인터뷰 템플릿 있어?

**Expected topic:** no-hallucinate — template doesn't exist

**v0.1 baseline:** pass — v0.1 correctly said 'not found' — negative case.

**Hits:**
- rank 1 d=1.156 → `hyunjin-unknown-design-20260414-085623#The Assignment`
- rank 2 d=1.1587 → `hyunjin-unknown-design-20260414-085623#What I noticed about how you think`
- rank 3 d=1.1628 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 4 d=1.1739 → `hyunjin-unknown-design-20260414-085623#핵심 변경`
- rank 5 d=1.1856 → `hyunjin-unknown-design-20260414-085623#Approaches Considered`
- rank 6 d=1.186 → `hyunjin-unknown-design-20260414-085623#Cross-Model Perspective`
- rank 7 d=1.1962 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 8 d=1.1994 → `hyunjin-unknown-design-20260414-085623#Demand Evidence`
- rank 9 d=1.206 → `hyunjin-unknown-design-20260414-085623#Recommended Approach`
- rank 10 d=1.2173 → `hyunjin-unknown-design-20260414-085623`

**Answer:**

```
인터뷰 템플릿이라는 이름의 명시적 템플릿은 그래프에서 찾을 수 없습니다.

다만 관련된 내용은 [[hyunjin-unknown-design-20260414-085623#The Assignment]]에 있습니다. 여기서 **실제 인터뷰를 수행할 때 물어봐야 할 구체적인 질문들**이 정의되어 있습니다:

- "AI 에이전트와 일할 때 뭐가 제일 아픈가요?"
- "지금 어떻게 workaround 하고 있나요?"
- "내일 사라지면 화낼 만한 솔루션은 뭔가요?"

그 외에 인터뷰 자체의 형식(30분 인터뷰, 5명 대상, go/no-go 게이트 기준)도 같은 섹션에서 확인할 수 있습니다 [[hyunjin-unknown-design-20260414-085623#The Assignment]].
```

**Tokens:** in=7930, out=310  
**Wall:** 4516 ms

### `v2-precision` — V2 precision 수치 뭐야?

**Expected topic:** SUMMARY: precision = 1.000

**v0.1 baseline:** pass — Small doc (4KB). v0.1 answered 1.000 correctly.

**Hits:**
- rank 1 d=1.1894 → `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)`
- rank 2 d=1.1977 → `eval-readme#사용법`
- rank 3 d=1.2001 → `hyunjin-unknown-design-20260414-085623#핵심 변경`
- rank 4 d=1.2122 → `eval-resolution-backlog#v1.2 bump checklist (when triggered)`
- rank 5 d=1.2142 → `eval-readme`
- rank 6 d=1.2166 → `eval-readme#라벨링 기준`
- rank 7 d=1.2171 → `eval-results-summary#Result: PASS — V2 prompt locked`
- rank 8 d=1.2218 → `eval-readme#Change log`
- rank 9 d=1.222 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 10 d=1.223 → `hyunjin-unknown-design-20260414-085623#Recommended Approach`

**Answer:**

```
문맥에서 V2 precision 수치를 찾았습니다.

[[eval-results-summary#Result: PASS — V2 prompt locked]]에 따르면, V2 prompt의 precision 수치는 **1.000 (100%)**입니다.

세부 내용:
- **전체 데이터셋**: Precision 1.000, Recall 0.967, F1 0.983
- **난이도별 분석**:
  - Easy (27개): Precision 1.000
  - Medium (23개): Precision 1.000
  - Hard (10개): Precision 1.000

이는 MVP 출시 전 필수 통과 기준인 [[eval-readme#사용법]]의 **≥ 0.90** 목표를 달성했습니다.
```

**Tokens:** in=6241, out=222  
**Wall:** 3458 ms

### `phase0-gates` — Phase 0 게이트 3가지 뭐야?

**Expected topic:** CEO plan: Phase 0 gate 3-item list

**v0.1 baseline:** fail — v0.1 couldn't find this — it's in a 16KB CEO plan's tail section.

**Hits:**
- rank 1 d=1.0837 → `ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)`
- rank 2 d=1.158 → `ceo-plans-2026-04-14-organizational-memory-os#Roadmap — "OS" 클레임을 진짜로 만드는 3가지 (v2-v3)`
- rank 3 d=1.1589 → `eval-results-summary#What V1 got wrong (8 false positives)`
- rank 4 d=1.1655 → `hyunjin-unknown-design-20260414-085623#Success Criteria`
- rank 5 d=1.1684 → `ceo-plans-2026-04-14-organizational-memory-os#Scope Decisions`
- rank 6 d=1.1899 → `eval-results-summary#Regression policy`
- rank 7 d=1.1957 → `eval-results-summary#Files`
- rank 8 d=1.1958 → `ceo-plans-2026-04-14-organizational-memory-os#MVP Scope 변경사항 (Phase 1)`
- rank 9 d=1.2028 → `hyunjin-unknown-design-20260414-085623#Open Questions`
- rank 10 d=1.204 → `hyunjin-unknown-design-20260414-085623#The Assignment`

**Answer:**

```
# Phase 0 게이트 3가지

Context에서 Phase 0 게이트는 **2가지**로 명시되어 있습니다. "3가지"는 찾을 수 없습니다.

**Phase 0 Go/No-go 게이트 (2가지):** [[ceo-plans-2026-04-14-organizational-memory-os#Phase 0: 1-Week Probe (인터뷰 + MCP 래퍼)]]

1. **인터뷰 검증**: 인터뷰 5명 중 3명 이상이 pain을 인정 AND 2명 이상이 세그먼트 얼라인 (타겟 팀 규모)
2. **MCP 래퍼 채택**: MCP 래퍼를 10명 이상이 설치 AND 2명 이상이 2회 이상 사용

혹시 "OS 클레임을 진짜로 만드는 3가지"를 묻고 계신가요? 그렇다면 [[ceo-plans-2026-04-14-organizational-memory-os#Roadmap — "OS" 클레임을 진짜로 만드는 3가지 (v2-v3)]]에 **Schema/Protocol Adoption, Write-Path Ownership, Entity Resolution Across Sources** 3가지가 있습니다.
```

**Tokens:** in=5050, out=381  
**Wall:** 5322 ms

