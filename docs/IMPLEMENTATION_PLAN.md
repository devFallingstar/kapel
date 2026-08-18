# v0.1 Implementation Plan

## M0 — Repository foundation

- [x] Node 24 + TypeScript strict + ESM
- [x] npm workspaces
- [x] package boundaries and core interfaces
- [x] typed policy IR
- [x] task DAG and deterministic scheduler skeleton
- [x] worktree workspace abstraction
- [x] event bus and session contracts

## M1 — Single-agent coding loop

- [x] OpenAI provider adapter
- [x] Anthropic provider adapter
- [x] tool-call loop
- [x] read / grep / glob / edit / write / bash / git diff tools
- [x] permission engine (`allow | ask | deny`)
- [x] cancellation and timeout propagation
- [x] usage and cost accounting
- [x] CLI wiring: `agent [objective]` runs the loop in the current directory
      (`agent init`, `agent models`, `.env` loading, interactive permission
      prompts, `--json` JSONL output)

Acceptance: one configured model can inspect and modify a repository safely.

## M2 — Policy compiler

- [ ] load `.agent/orchestration.md`
- [ ] compile natural language to Policy IR using structured output
- [ ] semantic validation
- [ ] ambiguity report
- [ ] write/read `orchestration.lock.json`
- [ ] `agent policy compile|check|explain`

Acceptance: changing only natural-language policy changes the validated runtime policy.

## M3 — Planner + multi-agent

- [ ] structured ExecutionPlan planner
- [ ] policy rewrite/validation of proposed plans
- [ ] model/agent router
- [ ] child-process worker executor
- [ ] normalized TaskResult
- [ ] dependency-aware parallel scheduling

Acceptance: orchestrator delegates independent tasks to different configured workers.

## M4 — Isolated coding workers

- [ ] per-task Git worktree
- [ ] affected-area conflict detection
- [ ] task-local context
- [ ] commit/diff collection
- [ ] cleanup/recovery after crashes

Acceptance: two workers can safely modify independent areas in parallel.

## M5 — Validation, review, retry, escalation

- [ ] test/typecheck/lint validators
- [ ] mandatory policy-driven review
- [ ] retry rules
- [ ] model escalation rules
- [ ] blocking review verdicts

Acceptance: a risky task cannot complete without required review, and failed workers escalate deterministically.

## M6 — Persistence and TUI

- [ ] SQLite + Drizzle session store
- [ ] resume
- [ ] context compaction
- [ ] Ink task/worker/event UI
- [ ] JSONL output mode
- [ ] explain routing/scheduling decisions

Acceptance: a run can be resumed and its orchestration decisions can be inspected after completion.
