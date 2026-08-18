# 멀티모델 오케스트레이션 코딩 에이전트 개발 계획서

> v0.1 · Node.js 24 LTS + TypeScript 기반 오픈소스 Agent Runtime

## 1. 문서 목적

본 계획서는 OpenCode, Pi, Hermes Agent와 같은 오픈소스 코딩 에이전트의 장점을 참고하되, **자연어로 오케스트레이션 정책을 정의하고 이를 구조화된 정책으로 컴파일하여 deterministic scheduler가 강제하는 멀티모델 코딩 에이전트**를 구현하기 위한 v0.1 개발 기준을 정의한다.

핵심 제품 문장은 다음과 같다.

> **강한 모델은 계획하고, 저렴하거나 특화된 모델은 실행한다. 사용자는 그 팀 운영 방식을 자연어로 정의한다.**

---

## 2. 제품 목표

### 2.1 핵심 목표

- Sol/Fable/Opus급 모델을 오케스트레이터 또는 고난도 판단 모델로 사용할 수 있다.
- Terra/Luna/Sonnet 등 비용·속도·전문성이 다른 모델을 워커로 혼합할 수 있다.
- 사용자가 `orchestration.md`에 자연어로 작업 분해, 라우팅, 병렬성, 리뷰, 재시도, 승격 정책을 정의할 수 있다.
- 자연어 정책은 Policy IR로 컴파일하며 실제 실행은 deterministic runtime이 강제한다.
- 병렬 워커는 Git worktree 또는 sandbox로 격리한다.
- 각 작업이 왜 특정 에이전트에 배정되고 왜 병렬/직렬 처리되었는지 설명할 수 있다.
- CLI/TUI뿐 아니라 JSONL/JSON-RPC를 통해 IDE, CI, 외부 앱에서 재사용할 수 있는 runtime으로 설계한다.

### 2.2 비목표(v0.1)

- Desktop/Web 완성형 앱
- Cloud sync 및 사용자 계정
- 원격 분산 워커 클러스터
- Marketplace
- 수십 개 LLM provider 지원
- 완전한 IDE/LSP 대체
- 자율적으로 무제한 subagent를 생성하는 swarm

---

## 3. 설계 원칙

1. **LLM은 판단하고 Runtime은 강제한다.** Planner는 계획을 제안하지만 concurrency, dependency, retry, budget, permission은 코드가 강제한다.
2. **자연어는 정책 입력이고 Policy IR이 실행 계약이다.** `orchestration.md`를 매번 즉흥적으로 해석하지 않는다.
3. **Provider 종속성을 core 밖으로 밀어낸다.** OpenAI/Anthropic의 고유 기능은 adapter capability로 노출한다.
4. **Worker는 task-local context와 격리 workspace를 사용한다.** 부모 대화를 통째로 복사하지 않는다.
5. **모든 핵심 의사결정은 설명 가능해야 한다.** routing, review injection, escalation, 병렬화 이유를 기록한다.
6. **작은 core와 확장 가능한 경계를 유지한다.** Pi의 package layering, OpenCode의 productization, Hermes의 isolation/sandbox 철학을 참고한다.
7. **LLM이 개발하는 코드베이스를 고려한다.** TypeScript strict, Zod, contract tests, deterministic fixtures로 구조적 오류를 빠르게 검출한다.

---

## 4. 확정 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| Runtime | Node.js 24 LTS | 장기 지원, npm 생태계, 플러그인 호환성 |
| Language | TypeScript 5.9+ / strict / ESM | LLM 리팩터링 안정성, 타입 기반 명세 |
| Monorepo | npm workspaces | 표준 Node 도구 체계, 외부 기여 진입장벽 최소화 |
| Runtime schema | Zod | LLM structured output와 내부 타입 동기화 |
| DB | SQLite + Drizzle | 로컬 우선 세션/이벤트 저장, 마이그레이션 용이 |
| LLM | 자체 Provider abstraction | 멀티모델/멀티프로바이더 라우팅 지원 |
| 초기 Provider | OpenAI, Anthropic, OpenAI-compatible | 핵심 사용 사례 우선 |
| CLI | Commander | 안정적인 Node CLI 생태계 |
| TUI | Ink + React | v0.1 구현 속도와 기여 난이도 균형 |
| 검색 | ripgrep | 빠른 코드 검색 |
| 파싱 | Tree-sitter | AST/심볼 단위 이해 확장 기반 |
| Process | child_process + node-pty | 워커 격리, 취소, 터미널 프로세스 |
| Workspace | Git worktree | 병렬 코드 수정 충돌 최소화 |
| Sandbox | Local + Docker | v0.1의 로컬/격리 실행 범위 |
| Protocol | JSONL events + JSON-RPC 2.0 | TUI/IDE/CI/외부 클라이언트 공용 |
| Test | Vitest | TypeScript 친화적 단위/통합 테스트 |
| Lint/Format | Biome | 빠른 정적 검사와 포맷 통일 |
| Build | tsup 또는 esbuild | CLI/패키지 번들링 단순화 |
| CI | GitHub Actions | 오픈소스 표준 워크플로 |

---

## 5. 시스템 아키텍처

```text
User / CLI / TUI / RPC
          │
          ▼
   Coding Agent Runtime
          │
          ├────────────── Session / Event Store
          │
          ▼
     Policy Resolver
          │
          ├─ Global Policy
          ├─ Project Policy
          ├─ Session Policy
          └─ Task Override
          │
          ▼
      Lead Planner
          │
          ▼
  Proposed ExecutionPlan
          │
          ▼
 Policy Validator / Rewriter
          │
          ▼
        Task DAG
          │
          ▼
 Router → Deterministic Scheduler
          │
   ┌──────┼────────┐
   ▼      ▼        ▼
 Worker Worker   Worker
   │      │        │
 Worktree / Sandbox
   │      │        │
   └──────┼────────┘
          ▼
 Validation / Review
          │
          ├─ retry / escalation
          └─ merge / finalize
```

### 5.1 책임 분리

- **Planner:** 목표를 구조화된 Task DAG 후보로 분해한다.
- **Policy Engine:** 사용자 정책과 runtime 안전 규칙을 적용해 계획을 수정/거부한다.
- **Router:** task 특성, 정책, 비용/성능 선호에 따라 agent/model 후보를 선택한다.
- **Scheduler:** dependency, concurrency, lock, retry를 deterministic하게 처리한다.
- **Worker:** 자신에게 할당된 좁은 task만 수행한다.
- **Validator/Reviewer:** 테스트·정적 검사·리뷰 규칙을 실행한다.
- **Session/Event Store:** 재개, explain, 비용 추적, 디버깅을 위한 기록을 보존한다.

---

## 6. Monorepo 구조

```text
agent/
├─ apps/
│  └─ cli/
├─ packages/
│  ├─ ai/
│  ├─ core/
│  ├─ policy/
│  ├─ orchestration/
│  ├─ coding-tools/
│  ├─ workspace/
│  ├─ session/
│  ├─ protocol/
│  ├─ plugin/
│  ├─ tui/
│  └─ coding-agent/
├─ examples/
├─ docs/
├─ fixtures/
└─ package.json
```

### 6.1 패키지 책임

| 패키지 | 주요 책임 |
|---|---|
| `@agent/ai` | Provider/Model/Event abstraction, usage/cost |
| `@agent/core` | agent loop, tool registry, permissions, 공통 타입 |
| `@agent/policy` | 자연어 compiler, Policy IR, resolver, validator |
| `@agent/orchestration` | planner, task graph, router, scheduler, escalation |
| `@agent/coding-tools` | read/edit/write/grep/glob/bash/git/tree-sitter |
| `@agent/workspace` | local/worktree/docker 실행 환경 |
| `@agent/session` | SQLite/Drizzle 저장, compaction, usage |
| `@agent/protocol` | typed events, JSONL, JSON-RPC 계약 |
| `@agent/plugin` | provider/tool/agent/policy/router/validator 확장 API |
| `@agent/tui` | Ink 기반 UI |
| `@agent/coding-agent` | 사용자-facing runtime facade |

---

## 7. 자연어 오케스트레이션 정책

### 7.1 사용자 입력 예시

```markdown
Sol은 메인 오케스트레이터다.
간단한 탐색은 Luna에게 맡긴다.
일반 구현은 Terra를 우선한다.
독립적인 작업은 최대 4개까지 병렬 실행한다.
인증과 DB migration 변경은 반드시 별도 reviewer를 거친다.
같은 worker가 두 번 실패하면 더 강한 모델로 승격한다.
```

### 7.2 컴파일 파이프라인

```text
orchestration.md
      ↓
LLM Policy Compiler
      ↓
Zod Schema Validation
      ↓
Semantic Validation
      ↓
orchestration.lock.json
```

### 7.3 정책 종류

- **Hard constraint:** max concurrency, 필수 review, 금지 tool, main branch 직접 수정 금지 등 Runtime이 반드시 강제한다.
- **Preference:** 특정 task에 선호 모델, 비용 우선/품질 우선, 탐색 선행 등 Router/Planner score에 반영한다.
- **Escalation:** 실패 횟수·confidence·validation failure에 따른 모델 승격을 정의한다.
- **Review rule:** risk category, 변경 파일 범위, change size 등을 기준으로 reviewer를 주입한다.

### 7.4 정책 우선순위

```text
Runtime Safety
    > Explicit Task Override
    > Project Policy
    > User Global Policy
    > Default Policy
```

---

## 8. 핵심 데이터 계약

### 8.1 PlannedTask

```ts
interface PlannedTask {
  id: string
  title: string
  goal: string
  type: 'exploration' | 'architecture' | 'implementation' | 'testing' | 'review' | 'documentation'
  complexity: 'trivial' | 'normal' | 'complex' | 'architectural'
  dependencies: string[]
  suggestedAgent?: string
  affectedAreas?: string[]
  risk: { level: 'low' | 'medium' | 'high'; categories: string[] }
}
```

### 8.2 TaskResult

```ts
interface TaskResult {
  taskId: string
  status: 'success' | 'partial' | 'failed'
  summary: string
  decisions: string[]
  changedFiles: string[]
  commit?: string
  tests: { passed: number; failed: number; commands: string[] }
  unresolvedIssues: string[]
  confidence: number
}
```

원칙상 부모 agent에는 worker의 전체 transcript를 넘기지 않고 `TaskResult + 필요 시 diff`만 전달한다.

---

## 9. 모델 라우팅 전략

Router는 다음 순서로 후보를 결정한다.

1. Hard routing rule 적용
2. Agent capability / tool permission 필터링
3. Task type/complexity/risk 일치도 계산
4. 자연어 policy preference 반영
5. 비용·속도·품질 weight 적용
6. 현재 concurrency·budget·provider availability 반영

예시 기본 역할:

| 역할 | 기본 모델 계층 |
|---|---|
| Lead/Planner | Sol/Fable/Opus급 |
| Architecture/고난도 debug | Sol/Fable/Opus급 |
| 일반 구현 | Terra/Sonnet급 |
| 테스트 구현 | Terra/Sonnet급 |
| 코드 검색/탐색/문서 조사 | Luna/저비용 모델 |
| 보안·고위험 최종 리뷰 | Opus/Sol급 |

모델명 자체는 설정 alias로 감추고 runtime은 `lead`, `worker`, `cheap`, `reviewer`와 capability만 참조하도록 한다.

---

## 10. Worker 및 Workspace 모델

- 각 worker는 child process로 실행한다.
- 구현 task는 기본적으로 task별 Git worktree를 생성한다.
- read-only 탐색 task는 별도 worktree를 생략할 수 있다.
- Worker context는 task-local이며 필요한 dependency result만 주입한다.
- Worker 종료 시 structured result를 반환하고 transcript는 session store에만 보관한다.
- 예상 수정 범위(`affectedAreas`)가 겹치는 task는 기본적으로 직렬화한다.
- 실제 diff가 충돌하면 merge 전 conflict task를 생성한다.

---

## 11. 검증·리뷰·재시도

### 11.1 기본 validation pipeline

```text
Worker 완료
   ↓
Git diff validation
   ↓
Typecheck / Lint / Test
   ↓
Policy validation
   ↓
Optional Reviewer
   ↓
Accept / Fix Task / Escalate
```

기본 validator:

- GitDiffValidator
- TypeCheckValidator
- LintValidator
- TestValidator
- PolicyValidator
- ReviewerValidator

Retry와 escalation은 Runtime이 처리한다. 동일 task를 무한 재시도하지 않으며 정책에 정의된 횟수 이후 더 강한 agent 또는 lead에게 승격한다.

---

## 12. Session, Event, Explainability

### 12.1 저장 대상

- runs
- tasks / dependencies
- workers
- agent sessions / messages
- tool calls
- events
- reviews
- model usage / estimated cost
- policy snapshots

### 12.2 주요 이벤트

`run.started`, `plan.completed`, `policy.compiled`, `task.started`, `worker.spawned`, `tool.completed`, `review.completed`, `task.failed`, `run.completed` 등을 typed event로 통일한다.

### 12.3 Explain 기능

```bash
agent explain T04
```

결과에는 다음을 표시한다.

- 왜 해당 agent/model이 선택되었는지
- 어떤 policy rule이 적용되었는지
- 왜 병렬 또는 직렬 실행되었는지
- review가 왜 추가되었는지
- retry/escalation이 발생한 이유

---

## 13. 개발 마일스톤

### M0. Repository Foundation

**목표:** 이후 모든 작업이 안정적으로 확장 가능한 monorepo 기반을 확정한다.

**주요 작업**
- npm workspaces 구성
- TypeScript strict/ESM 공통 설정
- package export 규칙
- Biome/Vitest/빌드 스크립트
- CI 기본 workflow
- 공통 error/result/event 타입

**완료 조건**
- clean clone에서 install/build/typecheck/test가 성공한다.
- 패키지 간 dependency cycle이 없다.

### M1. Single-Agent Coding Loop

**목표:** 하나의 모델로 실제 repository 작업을 수행하는 최소 코딩 에이전트를 완성한다.

**주요 작업**
- ModelProvider 인터페이스
- OpenAI 또는 Anthropic 첫 adapter
- streaming/tool-call agent loop
- ToolRegistry / PermissionEngine
- read/write/edit/grep/glob/bash/git 도구
- `agent exec "..."` CLI

**완료 조건**
- fixture repository에서 파일 탐색 → 수정 → 테스트 → 결과 요약이 한 명령으로 동작한다.

### M2. Multi-Provider & Model Registry

**목표:** orchestration과 provider를 분리한다.

**주요 작업**
- OpenAI adapter
- Anthropic adapter
- OpenAI-compatible adapter
- model alias/capability registry
- token usage / cost estimator
- provider contract test

**완료 조건**
- 동일한 Agent interface로 두 provider 모델을 교체할 수 있다.

### M3. Natural-Language Policy Compiler

**목표:** 프로젝트의 핵심 차별점인 자연어 오케스트레이션 설정을 구현한다.

**주요 작업**
- Policy IR Zod schema
- `orchestration.md` parser
- LLM compiler
- semantic validator
- hard/preference/escalation/review 규칙
- `orchestration.lock.json` 생성
- policy lint/explain CLI

**완료 조건**
- 자연어 정책 변경만으로 concurrency 및 모델 라우팅 규칙이 달라진다.
- 동일 lock file은 동일 runtime constraint를 만든다.

### M4. Planner & Task DAG

**목표:** 복잡한 요청을 구조화된 실행 계획으로 만든다.

**주요 작업**
- ExecutionPlan schema
- structured Planner
- DAG cycle validation
- risk/category/affectedAreas 추론
- Policy Rewriter
- mandatory review task injection

**완료 조건**
- 한 요청을 dependency가 있는 복수 task로 안정적으로 변환하고 invalid DAG를 거부한다.

### M5. Deterministic Scheduler & Parallel Workers

**목표:** 실제 멀티에이전트 병렬 실행을 완성한다.

**주요 작업**
- ready queue
- concurrency limit
- task locks
- child process Worker
- Git worktree manager
- cancellation/timeout
- retry/escalation
- structured TaskResult

**완료 조건**
- 독립 task 2개 이상이 서로 다른 worktree에서 병렬 실행된다.
- 최대 worker 수와 dependency가 항상 정책대로 강제된다.

### M6. Validation, Review & Merge

**목표:** worker의 '완료' 선언을 신뢰하지 않고 결과 품질을 runtime에서 검증한다.

**주요 작업**
- validation pipeline
- test/typecheck/lint validator
- reviewer agent
- approve/changes_requested protocol
- fix task 생성
- merge ordering/conflict detection

**완료 조건**
- 필수 review policy를 우회할 수 없다.
- blocking review issue가 존재하면 merge되지 않는다.

### M7. Durable Session & Observability

**목표:** 긴 작업을 재개하고 모든 의사결정을 추적 가능하게 한다.

**주요 작업**
- SQLite + Drizzle schema
- event persistence
- session resume
- context compaction
- usage/cost tracking
- `agent explain`

**완료 조건**
- 프로세스 종료 후 동일 run을 재개할 수 있다.
- task routing과 escalation의 원인을 기록에서 재현할 수 있다.

### M8. TUI, Protocol & Plugin Foundation

**목표:** runtime을 실제 제품과 생태계가 사용할 수 있게 한다.

**주요 작업**
- Ink TUI
- task/worker/cost/test 상태 UI
- JSONL event mode
- JSON-RPC server/stdio mode
- `definePlugin()` API
- tool/provider/agent/validator/policy/router 확장점

**완료 조건**
- CLI와 TUI가 동일 runtime/event stream을 사용한다.
- 외부 plugin이 core 수정 없이 tool 하나를 추가할 수 있다.

### M9. v0.1 Release Hardening

**목표:** 공개 저장소에서 타인이 설치하고 재현할 수 있는 첫 릴리스를 만든다.

**주요 작업**
- macOS/Linux/Windows 기본 검증
- crash cleanup/worktree recovery
- API key 및 secret redaction
- shell permission 기본 정책
- example policies
- README/Architecture/Plugin guide
- MIT LICENSE, CONTRIBUTING, SECURITY

**완료 조건**
- 새 사용자가 문서만 보고 init → policy 작성 → multi-agent run을 수행할 수 있다.

---

## 14. v0.1 Acceptance Criteria

아래 시나리오가 모두 동작하면 v0.1의 핵심 범위를 충족한 것으로 본다.

1. `agent init`이 프로젝트 설정과 기본 agent/policy 파일을 생성한다.
2. 사용자가 자연어로 worker 수, 역할, review, escalation을 변경할 수 있다.
3. lead model이 요청을 structured Task DAG로 분해한다.
4. 독립적인 구현 작업 두 개 이상이 격리된 Git worktree에서 병렬 실행된다.
5. 단순 탐색은 저비용 agent, 일반 구현은 worker agent로 자동 routing된다.
6. 인증/DB migration 등 정책상 고위험 작업은 자동 reviewer가 추가된다.
7. worker 실패가 정책에 따라 retry 및 상위 모델 escalation으로 연결된다.
8. validator/reviewer 실패 시 merge를 차단한다.
9. 실행 중단 이후 session resume가 가능하다.
10. `agent explain <task>`로 배정·병렬화·리뷰·승격 이유를 확인할 수 있다.
11. JSONL 이벤트로 외부 프로그램이 진행 상황을 구독할 수 있다.
12. 최소 하나의 외부 plugin이 core 변경 없이 tool을 등록할 수 있다.

---

## 15. 테스트 전략

| 구분 | 검증 범위 |
|---|---|
| Unit | Policy IR schema/resolver/conflict detection, DAG, Router scoring, Scheduler, Permission, Provider normalization |
| Contract | 각 LLM provider의 ModelProvider 계약 검증, Fake deterministic provider를 사용한 CI 테스트 |
| Integration | 임시 Git repo/worktree, 병렬 isolation, validator/reviewer 흐름, SQLite session resume |
| E2E Fixture | TypeScript/Python/Go 작은 repo에서 버그 수정, endpoint 추가, 병렬 수정, conflict, review blocking 재현 |

---

## 16. 주요 리스크 및 대응

| 리스크 | 대응 |
|---|---|
| LLM의 비결정적 계획 | Structured Output + Policy IR + DAG validator + golden tests |
| 자연어 정책의 모호성 | compile warning, lock file, `policy explain`, hard/preference 분리 |
| runaway worker/비용 | max concurrency, token/cost budget, retry ceiling, cancellation |
| 병렬 수정 충돌 | worktree, affected-area lock, merge conflict task |
| repository prompt injection | repo content를 untrusted data로 취급, tool permission과 system policy 분리 |
| shell 위험 명령 | allow/ask/deny, sandbox, command pattern denylist |
| Provider API 변화 | provider adapter + contract test로 격리 |
| 부모 context 폭증 | task-local context, structured TaskResult, compaction |
| Windows 차이 | path/process/git integration을 workspace adapter에 격리 |
| TUI 복잡도 | runtime/event protocol을 UI와 분리, TUI는 후순위 |

---

## 17. 오픈소스 운영 기준

- 라이선스는 **MIT**를 기본안으로 사용한다.
- core API 변경은 ADR(Architecture Decision Record)로 기록한다.
- public package는 semantic versioning을 따른다.
- plugin API는 v0.x 동안 experimental namespace로 두고 변경 가능성을 명시한다.
- GitHub Issue는 `core`, `provider`, `policy`, `scheduler`, `workspace`, `tui`, `plugin` label로 분류한다.
- PR은 typecheck/test/contract test 통과를 필수로 한다.
- 모델별 품질 비교는 재현 가능한 fixture와 결과 JSON을 저장해 benchmark화한다.

---

## 18. v0.1 이후 로드맵

### 18.1 v0.2 후보

- LSP integration
- SSH/remote sandbox
- Docker image caching
- 더 많은 provider
- policy preset/package 공유
- task-level model benchmark 및 자동 routing tuning
- VS Code extension

### 18.2 v1.0 후보

- 안정화된 Plugin/Policy API
- durable long-running execution
- 조직 단위 공유 policy
- remote worker backend
- reproducible execution report
- CI/GitHub PR automation

---

## 19. 구현 우선순위 요약

```text
1. Type-safe single agent runtime
2. Provider abstraction
3. Natural-language Policy Compiler
4. Structured Planner + Task DAG
5. Deterministic Scheduler
6. Worktree parallel workers
7. Validation / Review / Escalation
8. Durable session / Explain
9. TUI / Plugin / RPC
```

**TUI를 먼저 만들지 않는다.** v0.1의 기술적 가치와 차별점은 UI가 아니라 `Policy IR + deterministic orchestration + isolated multi-model workers`에 있다.

---

## 20. 최종 정의

> **강한 LLM이 structured task plan을 만들고, 사용자가 자연어로 정의한 운영 정책을 Policy Engine이 강제하며, deterministic scheduler가 여러 모델의 격리된 coding worker를 병렬 실행·검증·승격하는 오픈소스 TypeScript coding-agent runtime.**
