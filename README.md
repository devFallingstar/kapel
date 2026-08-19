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
- `-m, --model <alias>` — pick the model (default `claude-sonnet-5`, or `AGENT_MODEL`)
- `-y, --yes` — auto-approve permission prompts; without it, write/edit/bash ask on the terminal
- `--json` — newline-delimited JSON events for scripting/CI
- `--timeout <seconds>`, `--max-iterations <n>` — run limits

### Authentication

Any of these can also go in a `.env` file in the workspace instead of the shell environment.

**Anthropic** — checked in this order, first match wins:

1. `ANTHROPIC_API_KEY` — a standard API key.
2. `ANTHROPIC_AUTH_TOKEN` — a pre-issued bearer token, e.g. from an org that fronts Anthropic with its own auth.
3. An OAuth profile from the Anthropic CLI — run `ant auth login` once, and `agent` picks up a short-lived access token from it automatically. No env var needed.

`ANTHROPIC_BASE_URL` overrides the API endpoint (for gateways/proxies) under any of the three.

**OpenAI** — `OPENAI_API_KEY` only. OpenAI does not offer third-party OAuth for direct API access; if your organization fronts OpenAI with its own OAuth-authenticated gateway, point `OPENAI_BASE_URL` at it and keep using `OPENAI_API_KEY` for whatever credential that gateway expects.

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
