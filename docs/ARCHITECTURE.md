# Architecture

## Design principle

LLMs decide *what should be done*. Deterministic runtime code decides *what is allowed, when it runs, how much can run concurrently, and how failures are handled*.

## Control plane

```text
User objective
   ↓
Orchestrator / Planner
   ↓ proposed ExecutionPlan
Policy Engine
   ↓ validated Task DAG
Router
   ↓ agent choice
Deterministic Scheduler
   ↓
Worker processes
```

## Policy plane

Natural language is configuration source code, not the runtime format.

```text
orchestration.md
      ↓
LLM Policy Compiler
      ↓
Zod parse
      ↓
Semantic validation
      ↓
orchestration.lock.json
```

Hard rules are enforced by runtime code. Preferences become router/planner weights.

## Execution plane

Each implementation worker should eventually run in a separate child process and Git worktree. Worker conversations are task-local. Parent agents receive a normalized `TaskResult`, not the raw model transcript.

## Provider boundary

Provider-specific features stay behind adapters. The common abstraction should remain deliberately small so OpenAI/Anthropic-specific reasoning, caching, and tool semantics can still be exposed as optional capabilities instead of being flattened away.

## Event boundary

All meaningful state transitions emit typed events. TUI, JSONL output, persistence, telemetry, plugins, and future IDE integrations should consume the same event stream.
