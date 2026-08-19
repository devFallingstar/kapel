# Orchestration Agent

An orchestration-first open-source coding agent runtime.

The strongest model plans and delegates work; cheaper or specialized workers execute isolated tasks. Users define routing, concurrency, review, retry, and escalation behavior in natural language. That policy is compiled to a typed Policy IR and enforced by a deterministic scheduler.

## Quickstart

Like other terminal coding agents, `agent` runs inside the repository you want it to work on:

```bash
npm install && npm run build

cd /path/to/your/repo
export ANTHROPIC_API_KEY=...          # see Authentication below for other options
node /path/to/orchestration-agent/apps/cli/dist/index.js "fix the failing test"
```

Useful commands and flags:

- `agent init` — copy the default `.agent/` configuration template into the current repo
- `agent models` — list available model aliases and their credential status
- `agent plan "<objective>"` / `agent orchestrate "<objective>"` — multi-agent planning and routed parallel execution; see [Orchestrate](#orchestrate)
- `-m, --model <alias>` — pick the model (default `claude-sonnet-5`, or `AGENT_MODEL`)
- `-y, --yes` — auto-approve permission prompts; without it, write/edit/bash ask on the terminal
- `--json` — newline-delimited JSON events for scripting/CI
- `--timeout <seconds>`, `--max-iterations <n>` — run limits
- `--backend <native|codex>` — execution backend (default `native`, or `AGENT_BACKEND`); see [Codex backend](#codex-backend)
- `--sandbox <read-only|workspace-write|danger-full-access>` — Codex sandbox mode (default `workspace-write`)

### Authentication

Any of these can also go in a `.env` file in the workspace instead of the shell environment.

**Anthropic** — checked in this order, first match wins:

1. `ANTHROPIC_API_KEY` — a standard API key.
2. `ANTHROPIC_AUTH_TOKEN` — a pre-issued bearer token, e.g. from an org that fronts Anthropic with its own auth.
3. An OAuth profile from the Anthropic CLI — run `ant auth login` once, and `agent` picks up a short-lived access token from it automatically. No env var needed.

`ANTHROPIC_BASE_URL` overrides the API endpoint (for gateways/proxies) under any of the three.

**OpenAI** — `OPENAI_API_KEY` only. OpenAI does not offer third-party OAuth for direct API access; if your organization fronts OpenAI with its own OAuth-authenticated gateway, point `OPENAI_BASE_URL` at it and keep using `OPENAI_API_KEY` for whatever credential that gateway expects.

### Codex backend

Want OpenAI models without an `OPENAI_API_KEY`? Pass `--backend codex` (or set `AGENT_BACKEND=codex`) to delegate the objective to OpenAI's own Codex CLI instead of the native provider loop:

```bash
npm install -g @openai/codex
codex login          # ChatGPT OAuth — no API key
agent --backend codex "fix the failing test"
```

`agent` never handles OpenAI credentials itself on this path — it just spawns `codex exec --json` in the workspace and lets Codex authenticate and run its own agent loop. `-m/--model` is forwarded to Codex only when you pass it explicitly; otherwise Codex picks its own default. `--sandbox <read-only|workspace-write|danger-full-access>` (default `workspace-write`) controls how much Codex is allowed to touch — anything other than `read-only` runs `--full-auto` so it doesn't stall on approval prompts. `--max-iterations` and the native permission prompts don't apply here; Codex enforces its own approvals via the sandbox mode.

### Policy

`.agent/orchestration.md` is your routing/concurrency/review/retry/escalation policy, written in plain English. The CLI compiles it to a typed, deterministic IR:

- `agent policy compile` — uses an LLM (same model/credential resolution as a run; `-m/--model` selects it) to compile `orchestration.md` into `.agent/orchestration.lock.json`, reporting any warnings (judgement calls) or ambiguities (source phrases it couldn't map).
- `agent policy check` — a fast, offline gate: confirms the lock still matches `orchestration.md` and the current agents, without calling an LLM. Good for CI.
- `agent policy explain` — prints a human-readable summary of the locked policy from the lock file, also without calling an LLM.

All three accept `--cwd` and `--json`.

### Orchestrate

`agent "<objective>"` runs one model in one loop. `agent orchestrate "<objective>"` runs the full M3 pipeline instead: the objective is **planned** into a task DAG, the plan is **rewritten by your compiled policy** (unknown agents dropped, mandated reviews injected, unrunnable plans rejected), and the resulting tasks are **routed to different workers and executed in parallel** by the deterministic scheduler.

```bash
agent policy compile                        # once, and after every orchestration.md edit
agent plan "add a health endpoint"          # preview the task graph — no work is done
agent orchestrate "add a health endpoint"   # plan, then execute it
```

Both commands require a fresh `.agent/orchestration.lock.json` and refuse to guess: a missing or stale lock is an error telling you to run `agent policy compile`. The planner itself runs on the model your policy's orchestrator agent is configured with (`-m/--model` overrides it; if that agent or its credential is unavailable, the CLI falls back to the normal default model and says so).

`agent plan` prints one row per task — id, type, complexity, the agent the router would pick, dependencies, title — plus any reviews the policy injected and any notes from the rewrite. `--json` emits a single `{plan, injectedReviews, notes, routes}` object. `agent orchestrate --dry-run` prints exactly the same thing.

During a run, task lifecycle lines are interleaved with the workers' own output:

```text
▶ T01 → explorer (attempt 1)
▶ T02 → coder (attempt 1)
✔ T02 — Added the /healthz route.
↑ T03 rerouted coder → lead
⊘ T04 (dependency-failed)
```

The run ends with a per-task status table and token/cost totals, and exits `0` only if every task completed.

Execution options:

- `--worker-mode in-process` (default) — every task runs in this process through the native agent loop, using the model each agent declares in `.agent/agents/*.md` (resolved via the `models:` aliases in `.agent/config.yaml`). **Independent tasks fan out to different configured workers**: with a policy that routes `exploration` to your explorer agent and `implementation` to your coder agent, those two tasks run concurrently on two different models.
- `--worker-mode child` — each task runs in a separate `agent worker` process, isolated from the orchestrator and killable on timeout or Ctrl-C. This re-executes the *built* CLI (`apps/cli/dist/index.js`), so run `npm run build` first; the child inherits the current environment, so credentials carry over.
- `--backend codex` — delegate every task to the Codex CLI instead of the native loop (see [Codex backend](#codex-backend)).
- `--timeout <seconds>` applies **per task**, not to the run as a whole; `--max-iterations <n>` bounds each in-process worker's tool loop. `--json` turns the whole run into JSONL (worker events, task events, then a final `run.summary` line).

`agent worker` is the child endpoint of that protocol — it reads one JSON task request on stdin and writes events plus one result line to stdout. It exists for `--worker-mode child` to call; you don't run it by hand.

## Project plan

The current v0.1 development plan is available in:

- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) — source-of-truth development plan
- [`docs/PROJECT_PLAN.docx`](docs/PROJECT_PLAN.docx) — formatted document version


## Architecture

```text
Natural-language policy
        ↓
Policy compiler → Policy IR
        ↓
Planner → proposed task DAG
        ↓
Policy validator/router
        ↓
Deterministic scheduler
        ↓
Isolated workers (Git worktrees / sandbox)
        ↓
Validation / review / merge
```

## Stack

- Node.js 24 LTS
- TypeScript, strict mode, ESM
- npm workspaces
- Zod for runtime schemas
- SQLite + Drizzle planned for durable sessions
- Ink/React planned for the TUI
- Git worktrees for parallel worker isolation
- JSONL events / JSON-RPC for integrations

## Packages

- `@agent/ai` — model/provider abstraction
- `@agent/core` — shared agent and tool primitives
- `@agent/policy` — natural-language policy IR and validation
- `@agent/orchestration` — task DAG, router and deterministic scheduler
- `@agent/workspace` — local/worktree execution isolation
- `@agent/protocol` — typed runtime events
- `@agent/session` — session persistence contracts
- `@agent/plugin` — extension API contracts
- `@agent/coding-agent` — top-level runtime facade
- `@agent/tui` — terminal UI shell
- `apps/cli` — executable CLI

## First milestone

The first usable milestone should support:

1. one provider and a single-agent tool loop;
2. typed task planning;
3. natural-language policy compilation;
4. DAG scheduling and model routing;
5. isolated Git-worktree workers;
6. review/retry/escalation;
7. JSONL events and a basic terminal UI.

See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_PLAN.md`.
