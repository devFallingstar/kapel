# Multi-Model Orchestration Coding Agent — Development Plan

> v0.1 · Open-source Agent Runtime on Node.js 24 LTS + TypeScript

## 1. Purpose of this document

This plan defines the v0.1 development baseline for a **multi-model coding
agent that lets orchestration policy be defined in natural language, compiles
that policy into a structured form, and has a deterministic scheduler enforce
it** — drawing on the strengths of open-source coding agents such as
OpenCode, Pi, and Hermes Agent without copying any of them wholesale.

The core product statement is:

> **A strong model plans; cheaper or specialized models execute. The user
> defines how that team operates, in natural language.**

---

## 2. Product goals

### 2.1 Core goals

- Use Sol/Fable/Opus-class models as the orchestrator or for high-difficulty
  judgment calls.
- Mix in Terra/Luna/Sonnet-class models — differing in cost, speed, and
  specialization — as workers.
- Let the user define task decomposition, routing, parallelism, review,
  retry, and escalation policy in natural language in `orchestration.md`.
- Compile that natural-language policy into a Policy IR; the deterministic
  runtime enforces actual execution.
- Isolate parallel workers with Git worktrees or a sandbox.
- Be able to explain why each task was assigned to a particular agent and why
  it ran in parallel or serially.
- Design the runtime to be reusable from IDEs, CI, and external apps via
  JSONL/JSON-RPC, not just the CLI/TUI.

### 2.2 Non-goals (v0.1)

- A finished desktop/web app
- Cloud sync and user accounts
- A remote distributed worker cluster
- A marketplace
- Support for dozens of LLM providers
- A full IDE/LSP replacement
- A swarm that autonomously spawns unlimited subagents

---

## 3. Design principles

1. **The LLM judges; the runtime enforces.** The planner proposes a plan, but
   concurrency, dependencies, retries, budget, and permissions are enforced by
   code.
2. **Natural language is the policy input; the Policy IR is the execution
   contract.** `orchestration.md` is not reinterpreted ad hoc on every run.
3. **Push provider coupling out of the core.** OpenAI/Anthropic-specific
   features are exposed as adapter capabilities.
4. **Workers use task-local context and an isolated workspace.** The parent
   conversation is never copied wholesale.
5. **Every core decision must be explainable.** Routing, review injection,
   escalation, and parallelization rationale are all recorded.
6. **Keep a small core with extensible boundaries.** Draw on Pi's package
   layering, OpenCode's productization, and Hermes's isolation/sandbox
   philosophy.
7. **Design for a codebase an LLM will be developing.** TypeScript strict
   mode, Zod, contract tests, and deterministic fixtures catch structural
   errors quickly.

---

## 4. Committed technology stack

| Area | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24 LTS | Long-term support, npm ecosystem, plugin compatibility |
| Language | TypeScript 5.9+ / strict / ESM | Stability under LLM-driven refactoring, type-based specification |
| Monorepo | npm workspaces | Standard Node tooling, low barrier to external contribution |
| Runtime schema | Zod | Keeps LLM structured output in sync with internal types |
| DB | SQLite + Drizzle | Local-first session/event storage, easy migrations |
| LLM | In-house provider abstraction | Supports multi-model, multi-provider routing |
| Initial providers | OpenAI, Anthropic, OpenAI-compatible | Prioritizes core use cases |
| CLI | Commander | Mature, stable Node CLI ecosystem |
| TUI | Ink + React | Balances v0.1 implementation speed against contribution difficulty |
| Search | ripgrep | Fast code search |
| Parsing | Tree-sitter | Foundation for AST/symbol-level understanding, extensible |
| Process | child_process + node-pty | Worker isolation, cancellation, terminal processes |
| Workspace | Git worktree | Minimizes conflicts from parallel code changes |
| Sandbox | Local + Docker | v0.1's local/isolated execution scope |
| Protocol | JSONL events + JSON-RPC 2.0 | Shared contract for TUI/IDE/CI/external clients |
| Test | Vitest | TypeScript-friendly unit/integration testing |
| Lint/Format | Biome | Fast static checks and uniform formatting |
| Build | tsup or esbuild | Simplifies CLI/package bundling |
| CI | GitHub Actions | Standard open-source workflow |

---

## 5. System architecture

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

### 5.1 Separation of responsibilities

- **Planner:** decomposes the objective into a candidate structured Task DAG.
- **Policy Engine:** applies user policy and runtime safety rules, rewriting
  or rejecting the plan as needed.
- **Router:** selects an agent/model candidate based on task characteristics,
  policy, and cost/performance preference.
- **Scheduler:** handles dependencies, concurrency, locking, and retries
  deterministically.
- **Worker:** performs only the narrow task assigned to it.
- **Validator/Reviewer:** runs tests, static checks, and review rules.
- **Session/Event Store:** preserves the record needed for resume, explain,
  cost tracking, and debugging.

---

## 6. Monorepo layout

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

### 6.1 Package responsibilities

| Package | Primary responsibility |
|---|---|
| `@agent/ai` | Provider/model/event abstraction, usage/cost |
| `@agent/core` | Agent loop, tool registry, permissions, shared types |
| `@agent/policy` | Natural-language compiler, Policy IR, resolver, validator |
| `@agent/orchestration` | Planner, task graph, router, scheduler, escalation |
| `@agent/coding-tools` | read/edit/write/grep/glob/bash/git/tree-sitter |
| `@agent/workspace` | Local/worktree/Docker execution environment |
| `@agent/session` | SQLite/Drizzle storage, compaction, usage |
| `@agent/protocol` | Typed events, JSONL, JSON-RPC contract |
| `@agent/plugin` | Extension API for provider/tool/agent/policy/router/validator |
| `@agent/tui` | Ink-based UI |
| `@agent/coding-agent` | User-facing runtime facade |

---

## 7. Natural-language orchestration policy

### 7.1 Example user input

```markdown
Sol is the main orchestrator.
Delegate simple exploration to Luna.
Prefer Terra for general implementation.
Run up to 4 independent tasks in parallel.
Authentication and DB migration changes must always go through a separate reviewer.
If the same worker fails twice, escalate to a stronger model.
```

### 7.2 Compile pipeline

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

### 7.3 Policy kinds

- **Hard constraint:** things the runtime must always enforce — max
  concurrency, mandatory review, forbidden tools, no direct edits to the main
  branch, and so on.
- **Preference:** a preferred model for a given task, cost-first vs.
  quality-first, explore-before-implement, etc. — reflected in
  Router/Planner scoring.
- **Escalation:** defines model promotion driven by failure count,
  confidence, or validation failure.
- **Review rule:** injects a reviewer based on risk category, the set of
  changed files, change size, and similar criteria.

### 7.4 Policy precedence

```text
Runtime Safety
    > Explicit Task Override
    > Project Policy
    > User Global Policy
    > Default Policy
```

---

## 8. Core data contracts

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

As a matter of principle, the parent agent is never handed the worker's full
transcript — only the `TaskResult` (plus a diff, when needed).

---

## 9. Model routing strategy

The router determines candidates in the following order:

1. Apply hard routing rules.
2. Filter by agent capability / tool permission.
3. Compute a match score for task type/complexity/risk.
4. Apply natural-language policy preferences.
5. Apply cost/speed/quality weights.
6. Account for current concurrency, budget, and provider availability.

Example default roles:

| Role | Default model tier |
|---|---|
| Lead/Planner | Sol/Fable/Opus class |
| Architecture / hard debugging | Sol/Fable/Opus class |
| General implementation | Terra/Sonnet class |
| Test implementation | Terra/Sonnet class |
| Code search / exploration / doc research | Luna / low-cost models |
| Security / high-risk final review | Opus/Sol class |

Model names themselves are hidden behind configuration aliases; the runtime
refers only to `lead`, `complex`, `worker`, `cheap`, `reviewer`, and
capability — never a concrete model name.

---

## 10. Worker and workspace model

- Each worker runs as a child process.
- An implementation task creates a per-task Git worktree by default.
- A read-only exploration task can skip the separate worktree.
- Worker context is task-local; only the needed dependency results are
  injected.
- On exit, a worker returns a structured result; the transcript is kept only
  in the session store.
- Tasks whose expected modification scope (`affectedAreas`) overlaps are
  serialized by default.
- If the actual diffs conflict, a conflict task is created before merge.

---

## 11. Validation, review, and retry

### 11.1 Default validation pipeline

```text
Worker completes
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

Default validators:

- GitDiffValidator
- TypeCheckValidator
- LintValidator
- TestValidator
- PolicyValidator
- ReviewerValidator

Retry and escalation are handled by the runtime. The same task is never
retried indefinitely; after the number of attempts defined in policy, it is
promoted to a stronger agent or to the lead.

---

## 12. Session, event, and explainability

### 12.1 What is stored

- runs
- tasks / dependencies
- workers
- agent sessions / messages
- tool calls
- events
- reviews
- model usage / estimated cost
- policy snapshots

### 12.2 Key events

`run.started`, `plan.completed`, `policy.compiled`, `task.started`,
`worker.spawned`, `tool.completed`, `review.completed`, `task.failed`,
`run.completed`, and so on are unified as typed events.

### 12.3 Explain feature

```bash
agent explain T04
```

The result shows:

- Why that agent/model was chosen
- Which policy rule applied
- Why the task ran in parallel or serially
- Why a review was added
- Why a retry/escalation occurred

---

## 13. Development milestones

### M0. Repository Foundation

**Goal:** Establish a stably extensible monorepo foundation for all
subsequent work.

**Key work**
- Set up npm workspaces
- Shared TypeScript strict/ESM configuration
- Package export conventions
- Biome/Vitest/build scripts
- Baseline CI workflow
- Common error/result/event types

**Done when**
- Install/build/typecheck/test all succeed from a clean clone.
- There are no dependency cycles between packages.

### M1. Single-Agent Coding Loop

**Goal:** Complete a minimal coding agent that performs real repository work
with a single model.

**Key work**
- `ModelProvider` interface
- First OpenAI or Anthropic adapter
- Streaming/tool-call agent loop
- ToolRegistry / PermissionEngine
- read/write/edit/grep/glob/bash/git tools
- `agent exec "..."` CLI

**Done when**
- On a fixture repository, explore → edit → test → summarize the result runs
  as a single command.

### M2. Multi-Provider & Model Registry

**Goal:** Separate orchestration from providers.

**Key work**
- OpenAI adapter
- Anthropic adapter
- OpenAI-compatible adapter
- Model alias/capability registry
- Token usage / cost estimator
- Provider contract test

**Done when**
- Models from two providers can be swapped in through the same Agent
  interface.

### M3. Natural-Language Policy Compiler

**Goal:** Implement the project's core differentiator — natural-language
orchestration configuration.

**Key work**
- Policy IR Zod schema
- `orchestration.md` parser
- LLM compiler
- Semantic validator
- Hard/preference/escalation/review rules
- `orchestration.lock.json` generation
- Policy lint/explain CLI

**Done when**
- Changing only the natural-language policy changes concurrency and
  model-routing rules.
- The same lock file always produces the same runtime constraints.

### M4. Planner & Task DAG

**Goal:** Turn a complex request into a structured execution plan.

**Key work**
- ExecutionPlan schema
- Structured planner
- DAG cycle validation
- Risk/category/affectedAreas inference
- Policy Rewriter
- Mandatory review-task injection

**Done when**
- A single request is reliably converted into multiple tasks with
  dependencies, and an invalid DAG is rejected.

### M5. Deterministic Scheduler & Parallel Workers

**Goal:** Complete real multi-agent parallel execution.

**Key work**
- Ready queue
- Concurrency limit
- Task locks
- Child-process worker
- Git worktree manager
- Cancellation/timeout
- Retry/escalation
- Structured TaskResult

**Done when**
- Two or more independent tasks run in parallel in separate worktrees.
- Max worker count and dependencies are always enforced per policy.

### M6. Validation, Review & Merge

**Goal:** Don't trust a worker's "done" claim — verify result quality in the
runtime.

**Key work**
- Validation pipeline
- Test/typecheck/lint validator
- Reviewer agent
- Approve/changes_requested protocol
- Fix-task generation
- Merge ordering / conflict detection

**Done when**
- A mandatory review policy cannot be bypassed.
- A merge is blocked whenever a blocking review issue exists.

### M7. Durable Session & Observability

**Goal:** Make long-running work resumable and every decision traceable.

**Key work**
- SQLite + Drizzle schema
- Event persistence
- Session resume
- Context compaction
- Usage/cost tracking
- `agent explain`

**Done when**
- The same run can be resumed after the process exits.
- The reasons behind task routing and escalation can be reproduced from the
  record.

### M8. TUI, Protocol & Plugin Foundation

**Goal:** Make the runtime usable by real products and an ecosystem.

**Key work**
- Ink TUI
- Task/worker/cost/test status UI
- JSONL event mode
- JSON-RPC server/stdio mode
- `definePlugin()` API
- Extension points for tool/provider/agent/validator/policy/router

**Done when**
- The CLI and the TUI use the same runtime/event stream.
- An external plugin can add one tool without modifying the core.

### M9. v0.1 Release Hardening

**Goal:** Produce a first release that others can install and reproduce from
the public repository.

**Key work**
- Baseline verification on macOS/Linux/Windows
- Crash cleanup / worktree recovery
- API key and secret redaction
- Default shell permission policy
- Example policies
- README/Architecture/Plugin guide
- MIT LICENSE, CONTRIBUTING, SECURITY

**Done when**
- A new user can, from the docs alone, run init → write a policy → run a
  multi-agent task.

---

## 14. v0.1 Acceptance Criteria

The v0.1 core scope is considered satisfied once all of the scenarios below
work:

1. `agent init` generates the project configuration and default agent/policy
   files.
2. The user can change worker count, roles, review, and escalation in
   natural language.
3. The lead model decomposes a request into a structured Task DAG.
4. Two or more independent implementation tasks run in parallel, each in an
   isolated Git worktree.
5. Simple exploration is automatically routed to a low-cost agent; general
   implementation to a worker agent.
6. High-risk work under policy — auth, DB migrations, etc. — automatically
   gets a reviewer added.
7. A worker failure leads to a retry, and then to escalation to a
   higher-tier model, per policy.
8. A validator/reviewer failure blocks the merge.
9. A session can be resumed after an interrupted run.
10. `agent explain <task>` shows the reason for assignment, parallelization,
    review, and escalation.
11. An external program can subscribe to progress via JSONL events.
12. At least one external plugin can register a tool with no changes to the
    core.

---

## 15. Test strategy

| Category | Coverage |
|---|---|
| Unit | Policy IR schema/resolver/conflict detection, DAG, router scoring, scheduler, permissions, provider normalization |
| Contract | Verifies each LLM provider's ModelProvider contract; CI tests use a fake deterministic provider |
| Integration | Temporary Git repo/worktree, parallel isolation, validator/reviewer flow, SQLite session resume |
| E2E Fixture | Small TypeScript/Python/Go repos reproducing bug fixes, endpoint addition, parallel edits, conflicts, and review blocking |

---

## 16. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Non-deterministic LLM planning | Structured Output + Policy IR + DAG validator + golden tests |
| Ambiguity in natural-language policy | Compile warnings, lock file, `policy explain`, separation of hard rules from preferences |
| Runaway workers / cost | Max concurrency, token/cost budget, retry ceiling, cancellation |
| Parallel-edit conflicts | Worktrees, affected-area locking, merge conflict task |
| Repository prompt injection | Treat repo content as untrusted data; separate tool permissions from system policy |
| Dangerous shell commands | allow/ask/deny, sandbox, command-pattern denylist |
| Provider API churn | Isolated behind provider adapters + contract tests |
| Parent context blowup | Task-local context, structured TaskResult, compaction |
| Windows differences | Isolate path/process/git integration behind the workspace adapter |
| TUI complexity | Separate the runtime/event protocol from the UI; TUI is lower priority |

---

## 17. Open-source operating standards

- **MIT** is the default license.
- Core API changes are recorded as an ADR (Architecture Decision Record).
- Public packages follow semantic versioning.
- The plugin API stays in an experimental namespace throughout v0.x, with
  the possibility of change explicitly noted.
- GitHub Issues are categorized with `core`, `provider`, `policy`,
  `scheduler`, `workspace`, `tui`, `plugin` labels.
- A PR must pass typecheck/test/contract tests.
- Per-model quality comparisons are turned into benchmarks by saving
  reproducible fixtures and result JSON.

---

## 18. Roadmap beyond v0.1

### 18.1 v0.2 candidates

- LSP integration
- SSH/remote sandbox
- Docker image caching
- More providers
- Shared policy presets/packages
- Task-level model benchmarking and automatic routing tuning
- VS Code extension

### 18.2 v1.0 candidates

- A stabilized Plugin/Policy API
- Durable long-running execution
- Organization-wide shared policy
- Remote worker backend
- Reproducible execution report
- CI/GitHub PR automation

---

## 19. Implementation priority summary

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

**The TUI is not built first.** v0.1's technical value and differentiation
lie not in the UI but in `Policy IR + deterministic orchestration + isolated
multi-model workers`.

---

## 20. Final definition

> **An open-source TypeScript coding-agent runtime in which a strong LLM
> produces a structured task plan, the Policy Engine enforces the operating
> policy the user defined in natural language, and a deterministic scheduler
> runs, verifies, and escalates isolated coding workers across multiple
> models in parallel.**
