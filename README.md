<div align="center">

# Kapel

**A multi-model orchestration coding agent for your terminal.**

The strongest model plans; cheaper or specialized workers execute — under a natural-language policy compiled to a deterministic runtime.

[![npm version](https://img.shields.io/npm/v/@devfallingstar/kapel)](https://www.npmjs.com/package/@devfallingstar/kapel)
[![CI](https://github.com/devFallingstar/kapel/actions/workflows/ci.yml/badge.svg)](https://github.com/devFallingstar/kapel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[Installation](#installation) •
[Quick Start](#quick-start) •
[Usage](#usage) •
[Backends](#backends) •
[Orchestration](#orchestration) •
[Configuration](#configuration) •
[Architecture](#architecture)

</div>

---

Kapel is an orchestration-first open-source coding agent runtime. You describe routing, concurrency, review, retry, and escalation behavior in natural language; Kapel compiles that policy to a typed Policy IR and enforces it with a deterministic scheduler. A single run can drive Claude Code workers, Codex workers, and direct-API workers side by side — each task in its own git worktree, each billed and reported under its own model.

```text
$ kapel
╭─ kapel v0.16.0 ─────────────────────────────────────────────╮
│ orchestrator claude-code:opus     today  1 run · 1 chat     │
│ complex      claude-code:sonnet          2 tasks ok         │
│ middle       codex:gpt-5.1-codex         412k in · 38k out  │
│ low          native:claude-haiku-5                          │
╰─────────────────────────────────────────────────────────────╯
> /orchestrate add a health endpoint
▶ T01 → explorer (attempt 1)
⎇ T02 worktree created (agent-task/8f3a…/T02)
▶ T02 → coder (attempt 1)
✔ T02 — Added the /healthz route.
⇡ T02 merged → 4b1c9de0
```

## Features

- **🎯 Policy-driven orchestration** — Write your routing, review, and escalation rules in `.agent/orchestration.md`. Kapel compiles them into a typed, deterministic IR; the scheduler enforces them exactly. Canonical-form policies compile with **zero model calls**.
- **🤝 Multi-model, multi-backend** — One orchestrator plus three worker tiers (complex / routine / small-task), each independently mapped to Claude Code, Codex, or a direct API key. A Claude Code lead with a Codex middle tier is a normal setup.
- **🔑 No API key required** — Run entirely on your Claude Code subscription or ChatGPT login (via the Codex CLI). The whole pipeline — compile, plan, orchestrate — works without an API key anywhere.
- **🌲 Worktree isolation** — Every mutating task runs in its own git worktree on its own branch, merged back serially on success. Conflicts are reported and preserved for inspection, never half-resolved.
- **✅ Validation gates & blocking reviews** — Project validators (`typecheck`, `test`, …) run inside each task's worktree before merge; policy-injected review tasks can block risky changes.
- **💬 A real terminal REPL** — Streaming output, a persistent input band, slash commands, `@` file mentions, multiline editing, per-directory sessions that survive restarts, `/undo` checkpoints before every prompt.
- **📊 Honest observability** — Runs, sessions, and token usage recorded in a local SQLite database. `kapel explain <taskId>` tells you exactly why a task was routed where it was and what happened to it.
- **🔒 Permission prompts by design** — Read-only tools run freely; anything that writes or shells out asks first. Answer with a sentence instead of `y/n` and the agent hears you and adjusts.

## Installation

Requires Node.js ≥ 20. No build step — identical on Windows, macOS, and Linux:

```bash
npm install -g @devfallingstar/kapel
```

<details>
<summary>Registry unreachable? Install from the committed tarball</summary>

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.16.0.tgz
```

> Do not use `npm install -g github:...` — npm's git-dependency preparation mishandles workspace monorepos and produces a broken install.

</details>

## Quick Start

```bash
cd /path/to/your/repo
kapel
```

That's it. On the first run, a short wizard asks which backends you have (Claude Code, Codex, an API key — tick as many as apply) and which model each orchestration role should use, then stores the answers in `~/.kapel/config.json`. In a fresh repository, Kapel sets the project up itself — creating `.agent/` and compiling the shipped orchestration policy, with **no model call and no credential needed**.

Then just talk:

```text
> calc.test.js is failing — find out why and fix it
→ read_file {"path":"calc.test.js"}
→ grep {"pattern":"function add"}
  calc.js
  - return a - b;
  + return a + b;
allow edit_file? [y/n/a, or say what to do instead] y
`add` subtracted instead of adding. Fixed and `node calc.test.js` now prints PASS.
```

When one model in one loop isn't enough, orchestrate:

```text
> /plan add rate limiting to the API          ← preview the task graph — nothing runs
> /orchestrate add rate limiting to the API   ← plan it, then execute across routed workers
```

## Usage

All agent work happens in the REPL — talking, planning, orchestrating, resuming. The shell commands set Kapel up and inspect what it did.

### Slash commands

| Command | Description |
|---|---|
| `/help` | List commands (including custom ones from `.agent/commands/`) |
| `/new`, `/sessions`, `/resume <id\|name>` | Start, list, or switch conversations in this directory |
| `/name [name]`, `/fork [name]` | Name this conversation, or branch it into a new one |
| `/model [alias]`, `/config`, `/login` | Switch model, re-run setup, check backend logins |
| `/undo` | Restore files to the checkpoint taken before the last prompt |
| `/policy` | Edit this project's orchestration policy — no model call |
| `/plan "<objective>"` | Plan an objective into a task graph with routing rationale — nothing executes |
| `/orchestrate "<objective>"` | Plan **and** run it across routed workers |
| `/runs`, `/resume-run <runId>` | List recorded runs; finish one that stopped part-way |
| `/usage`, `/stats`, `/compact` | Token spend, dashboard refresh, context compaction |

Type `@` plus part of a path (Tab to fuzzy-complete) to mention a file — the agent reads what it needs with its own tools rather than pasting bytes into context. Images attach the same way (`@screenshot.png`). Drop Markdown files in `.agent/commands/` to define your own `/<name>` commands.

### Shell commands

```bash
kapel                    # open the REPL — this is where the work happens
kapel chat               # the same, spelled out (--continue, --session, --no-save)
kapel init               # copy the default .agent/ configuration into this repo
kapel config             # re-run setup (--show, --path, --project)
kapel models             # model aliases and their credential status
kapel runs               # orchestration runs recorded here (--limit, --json)
kapel sessions           # chat sessions recorded here; `sessions fork <id|name>` copies one
kapel explain <taskId>   # how one task was routed and what happened (--run, --json)
kapel policy edit | compile | check | explain | diff
```

Global flags on every command: `--cwd <dir>`, `-m/--model <alias>`, `--backend <native|codex|claude-code>`, `--timeout <seconds>`, `--no-setup`, `--no-altscreen`.

## Backends

| Backend | Auth | How it runs |
|---|---|---|
| **Claude Code** | Your Claude subscription login — no API key | Spawns `claude -p` in the workspace; conversations resume by session id; per-agent `tools:` lists become `--allowedTools` |
| **Codex** | Your ChatGPT login via `codex login` — no API key | Spawns `codex exec --json` under its `workspace-write` sandbox |
| **Native (API key)** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (or Anthropic OAuth via `ant auth login`) | Kapel's own agent loop, tools, and permission prompts |

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code && claude   # log in once
kapel --backend claude-code

# Codex
npm install -g @openai/codex && codex login
kapel --backend codex
```

Pick backends once in `kapel config` and the flags stop being necessary. With nothing configured, Kapel auto-detects a logged-in CLI (Claude Code first, then Codex, then an environment credential) and announces the choice on stderr. **Mixed execution is per task**: each agent alias in `.agent/config.yaml` can name its own `backend:`, so a single orchestration run drives Claude Code, Codex, and native workers side by side.

`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` point the native backend at gateways or proxies; any credential can live in a workspace `.env` file instead of the shell.

## Orchestration

`/orchestrate` plans the objective into a task DAG, rewrites the plan under your compiled policy (unknown agents dropped, mandated reviews injected, unrunnable plans rejected), then routes tasks to workers and executes them in parallel under the deterministic scheduler.

### Policy

`.agent/orchestration.md` is your policy; the lock file beside it is what the scheduler enforces. In **canonical form** (what `kapel init` ships and `kapel policy edit` maintains), it compiles with no model call and no credential:

```markdown
<!-- kapel:policy v1 -->

## Execution
- Run at most 4 agents at a time.
- Give each task 2 attempts before giving up.

## Routing
- `architectural-work`: always route tasks of complex and architectural complexity to `senior`.

## Review
- `sensitive-change-review`: `reviewer` reviews tasks touching `auth`, `payments` and `migrations`; blocking, required.

## Escalation
- `junior-to-coder`: hand off from `junior` to `coder` after 2 failed attempts.
```

Prefer prose? Delete the marker and write plain English — Kapel compiles it with one LLM call instead. `kapel policy check` verifies the lock offline (good for CI), `policy explain` summarizes it, and `policy diff` previews a recompile against the current lock without writing it.

### Execution guarantees

- **Worktree isolation, always on** — each mutating task gets a private checkout on an `agent-task/<runId>/<taskId>` branch; merges back are serialized. Read-only tasks (exploration, review) run in place. Conflicted or failed branches are preserved for inspection.
- **Validators gate merges** — commands from `.agent/config.yaml`'s `validation:` list run inside the task's worktree before merge; a failure fails the task and cancels its dependents.
- **Retry and escalation per policy** — failed or low-confidence results retry and reroute exactly as your rules say, and `/plan` prints the routing rationale for every task: which rule matched, or what it fell back to.
- **Everything is recorded** — runs, events, and per-task history land in `.agent/sessions.db`. `/resume-run` finishes an interrupted run under the *policy snapshot recorded with it*, and `kapel explain <taskId>` replays any routing decision after the fact.

## Configuration

Everything resolves in one order, everywhere:

```text
CLI flag > environment variable > .agent/config.local.json > ~/.kapel/config.json > detected > default
```

| File | Scope | Purpose |
|---|---|---|
| `~/.kapel/config.json` | Machine | Backends, role→model mapping, `permission`, `notify` |
| `.agent/config.local.json` | Checkout (gitignored) | Partial overrides of the machine config |
| `.agent/config.yaml` | Project (committed) | Agent aliases, per-agent backend/model, `validation:`, `permission` |
| `.agent/orchestration.md` | Project (committed) | The orchestration policy |
| `AGENTS.md` | Project (committed) | Project instructions — the same file Codex and opencode read |

**Permissions.** Read-only tools never ask; `write_file`/`edit_file`/`bash` prompt with `[y/n/a]`, where `a` remembers the answer for this session only. A `permission` block (opencode's syntax) changes the defaults:

```yaml
# .agent/config.yaml
permission:
  edit_file: allow
  bash:
    "*": ask
    "git *": allow
    "rm *": deny
```

**Project instructions.** Kapel merges up to three `AGENTS.md` files into the system prompt — `~/.kapel/AGENTS.md`, the repo root's `AGENTS.md`, then `.agent/AGENTS.md` — so a repository writes its rules once and shares them with other agents. `.agent/handoff.md` customizes the standing guidance workers and reviewers receive at hand-off.

**Notifications.** Kapel rings the terminal (`BEL` + `OSC 9`) when a permission prompt starts waiting, a long turn finishes, or a run completes; tune with `notify: "off" | "bell" | "osc9" | "auto"` or `KAPEL_NO_NOTIFY=1`.

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
Isolated workers (git worktrees / sandbox)
        ↓
Validation / review / merge
```

Built with TypeScript (strict, ESM) on Node.js, npm workspaces, Zod for runtime schemas, SQLite + Drizzle for durable sessions, Ink/React for the terminal dashboard, and git worktrees for parallel worker isolation.

| Package | Purpose |
|---|---|
| `@agent/ai` | Model/provider abstraction |
| `@agent/core` | Shared agent and tool primitives |
| `@agent/policy` | Natural-language policy IR and validation |
| `@agent/orchestration` | Task DAG, router, and deterministic scheduler |
| `@agent/workspace` | Local/worktree execution isolation |
| `@agent/protocol` | Typed runtime events |
| `@agent/session` | Session persistence (SQLite/Drizzle) |
| `@agent/plugin` | Extension API contracts |
| `@agent/coding-agent` | Top-level runtime facade |
| `@agent/tui` | Terminal UI shell |
| `apps/cli` | The `kapel` executable |

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) — source-of-truth development plan
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — implementation roadmap
- [`docs/UX_ROADMAP.md`](docs/UX_ROADMAP.md) — terminal UX roadmap
- [`docs/FUTURE_WORK.md`](docs/FUTURE_WORK.md) — planned work

## Development

```bash
git clone https://github.com/devFallingstar/kapel.git
cd kapel
npm install
npm run build        # tsc -b
npm test             # vitest
npm run lint         # biome
node apps/cli/dist/index.js   # run from source (or `npm install -g .`)
```

## Contributing

Issues and pull requests are welcome — see [open issues](https://github.com/devFallingstar/kapel/issues). Before submitting, please run `npm run typecheck && npm test && npm run lint`.

## License

[MIT](LICENSE) © devFallingstar
