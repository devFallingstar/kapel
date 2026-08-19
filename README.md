# Kapel

An orchestration-first open-source coding agent runtime.

The strongest model plans and delegates work; cheaper or specialized workers execute isolated tasks. Users define routing, concurrency, review, retry, and escalation behavior in natural language. That policy is compiled to a typed Policy IR and enforced by a deterministic scheduler.

## Quickstart

Like other terminal coding agents, `kapel` runs inside the repository you want it to work on. Install it globally from the packed tarball in this repo (identical on Windows cmd, macOS, and Linux — no build step):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/kapel-0.1.0.tgz

cd /path/to/your/repo
export ANTHROPIC_API_KEY=...          # see Authentication below for other options
kapel "fix the failing test"
```

Once published to the npm registry this becomes simply `npm install -g kapel`.
If the tarball URL is unreachable from your network, the equivalent two-step
form is `git clone
https://github.com/devFallingstar/kapel.git kapel-src && npm install -g
./kapel-src/release/kapel-0.1.0.tgz`.

> Do not use `npm install -g github:...` — npm's git-dependency preparation
> mishandles workspace monorepos and produces a broken install.

For development, clone and run `npm install && npm run build`, then use `node apps/cli/dist/index.js` or `npm install -g .` from the repo root.

Useful commands and flags:

- `kapel init` — copy the default `.agent/` configuration template into the current repo
- `kapel models` — list available model aliases and their credential status
- `kapel plan "<objective>"` / `kapel orchestrate "<objective>"` — multi-agent planning and routed parallel execution; see [Orchestrate](#orchestrate)
- `kapel runs` / `kapel explain <taskId>` / `kapel resume <runId>` — inspect and continue recorded runs; see [Sessions](#sessions)
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
3. An OAuth profile from the Anthropic CLI — run `ant auth login` once, and `kapel` picks up a short-lived access token from it automatically. No env var needed.

`ANTHROPIC_BASE_URL` overrides the API endpoint (for gateways/proxies) under any of the three.

**OpenAI** — `OPENAI_API_KEY` only. OpenAI does not offer third-party OAuth for direct API access; if your organization fronts OpenAI with its own OAuth-authenticated gateway, point `OPENAI_BASE_URL` at it and keep using `OPENAI_API_KEY` for whatever credential that gateway expects.

### Codex backend

Want OpenAI models without an `OPENAI_API_KEY`? Pass `--backend codex` (or set `AGENT_BACKEND=codex`) to delegate the objective to OpenAI's own Codex CLI instead of the native provider loop:

```bash
npm install -g @openai/codex
codex login          # ChatGPT OAuth — no API key
kapel --backend codex "fix the failing test"
```

`kapel` never handles OpenAI credentials itself on this path — it just spawns `codex exec --json` in the workspace and lets Codex authenticate and run its own agent loop. `-m/--model` is forwarded to Codex only when you pass it explicitly; otherwise Codex picks its own default. `--sandbox <read-only|workspace-write|danger-full-access>` (default `workspace-write`) controls how much Codex is allowed to touch — anything other than `read-only` runs `--full-auto` so it doesn't stall on approval prompts. `--max-iterations` and the native permission prompts don't apply here; Codex enforces its own approvals via the sandbox mode.

### Policy

`.agent/orchestration.md` is your routing/concurrency/review/retry/escalation policy, written in plain English. The CLI compiles it to a typed, deterministic IR:

- `kapel policy compile` — uses an LLM (same model/credential resolution as a run; `-m/--model` selects it) to compile `orchestration.md` into `.agent/orchestration.lock.json`, reporting any warnings (judgement calls) or ambiguities (source phrases it couldn't map).
- `kapel policy check` — a fast, offline gate: confirms the lock still matches `orchestration.md` and the current agents, without calling an LLM. Good for CI.
- `kapel policy explain` — prints a human-readable summary of the locked policy from the lock file, also without calling an LLM.

All three accept `--cwd` and `--json`.

### Orchestrate

`kapel "<objective>"` runs one model in one loop. `kapel orchestrate "<objective>"` runs the full M3 pipeline instead: the objective is **planned** into a task DAG, the plan is **rewritten by your compiled policy** (unknown agents dropped, mandated reviews injected, unrunnable plans rejected), and the resulting tasks are **routed to different workers and executed in parallel** by the deterministic scheduler.

```bash
kapel policy compile                        # once, and after every orchestration.md edit
kapel plan "add a health endpoint"          # preview the task graph — no work is done
kapel orchestrate "add a health endpoint"   # plan, then execute it
```

Both commands require a fresh `.agent/orchestration.lock.json` and refuse to guess: a missing or stale lock is an error telling you to run `kapel policy compile`. The planner itself runs on the model your policy's orchestrator agent is configured with (`-m/--model` overrides it; if that agent or its credential is unavailable, the CLI falls back to the normal default model and says so).

`kapel plan` prints one row per task — id, type, complexity, the agent the router would pick, dependencies, title — plus any reviews the policy injected and any notes from the rewrite. `--json` emits a single `{plan, injectedReviews, notes, routes}` object. `kapel orchestrate --dry-run` prints exactly the same thing.

During a run, task lifecycle lines are interleaved with the workers' own output:

```text
▶ T01 → explorer (attempt 1)
⎇ T02 worktree created (agent-task/8f3a.../T02)
▶ T02 → coder (attempt 1)
✔ T02 — Added the /healthz route.
⇡ T02 merged → 4b1c9de0
↑ T03 rerouted coder → lead
⊘ T04 (dependency-failed)
```

The run ends with a per-task status table and token/cost totals, and exits `0` only if every task completed.

Execution options:

- `--worker-mode in-process` (default) — every task runs in this process through the native agent loop, using the model each agent declares in `.agent/agents/*.md` (resolved via the `models:` aliases in `.agent/config.yaml`). **Independent tasks fan out to different configured workers**: with a policy that routes `exploration` to your explorer agent and `implementation` to your coder agent, those two tasks run concurrently on two different models.
- `--worker-mode child` — each task runs in a separate `kapel worker` process, isolated from the orchestrator and killable on timeout or Ctrl-C. This re-executes the *built* CLI (`apps/cli/dist/index.js`), so run `npm run build` first; the child inherits the current environment, so credentials carry over.
- `--backend codex` — delegate every task to the Codex CLI instead of the native loop (see [Codex backend](#codex-backend)).
- `--isolation worktree` (default) / `--isolation none` — see [Worktree isolation](#worktree-isolation) below.
- `--tui` — replace the streaming event lines with a live dashboard (task table, worker log, elapsed time). Text mode only: combining it with `--json` is an error, since the dashboard owns the terminal. The final status table and token totals are printed as usual once it comes down.
- `--no-save` — don't record this run in `.agent/sessions.db`; see [Sessions](#sessions).
- `--timeout <seconds>` applies **per task**, not to the run as a whole; `--max-iterations <n>` bounds each in-process worker's tool loop. `--json` turns the whole run into JSONL (worker events, task events, then a final `run.summary` line).

#### Worktree isolation

Parallel workers editing one checkout would see each other's half-finished edits, so by default **every mutating task gets its own git worktree**: a private checkout of the current `HEAD` on an `agent-task/<runId>/<taskId>` branch, under `.agent/worktrees/`. The worker only ever sees that directory. When the task succeeds, its changes are committed on the task branch and merged back into your checked-out branch — merges are serialized, so concurrent tasks land one after another rather than racing. The checkout and the branch are then deleted, and the task's reported `changedFiles`/`commit` describe what actually landed.

This applies to every worker mode and to `--backend codex` alike; isolation is about how tasks share the repository, not about what runs them.

- **Read-only tasks run in place.** `exploration` and `review` tasks never write, so they run directly in your workspace with no checkout and no branch.
- **Conflicts are reported, not resolved.** If a task's branch cannot be merged (two tasks touched the same lines, or the base checkout was dirty), the task comes back `partial` with the conflicting files and the branch name in its unresolved issues, and **the branch is preserved** so you can merge or inspect it by hand. Your working tree is left clean — no merge in progress, no conflict markers.
- **Failed tasks keep their evidence.** A task that fails after making edits still has them committed on its branch, which is kept for inspection; nothing is merged.
- `--isolation none` opts out entirely: every task runs directly in the workspace, exactly as before. Use it when the workspace is not a git repository, or when you want a single shared tree.

Worktree isolation needs the workspace to be a git repository with at least one commit; if it isn't, `kapel orchestrate` says so and exits before planning work, suggesting `--isolation none`. Should a run be killed mid-flight, leftover checkouts and `agent-task/*` branches can be cleaned up with `git worktree prune` plus `git branch -D`.

#### Validation and review

`.agent/config.yaml` can gate every mutating task on a `validation:` list:

```yaml
validation:
  - name: typecheck
    command: npm run typecheck
  - name: test
    command: npm test        # timeoutSeconds: 300  (optional, default 600)
```

Each command runs via `bash -lc` **inside the task's own worktree, before it is merged back**; a failing command fails the task (and cancels its dependents) instead of merging broken work, and its output streams as `validation.started`/`validation.completed` events. Failed and low-confidence results are retried per the policy's `escalation`/`defaultMaxAttempts` rules, rerouting to another agent when configured. `--no-validate` skips validators for one run; they're skipped under `--backend codex` regardless, since Codex reports one result per task with no hook to run a separate suite against. Separately, a policy's `review:` rules inject **blocking** review tasks for matching risk categories — a rejected verdict fails the task (and the run) the same way a failed validator does.

#### Sessions

Every `kapel orchestrate` run records itself in a SQLite database at **`.agent/sessions.db`**: the objective, the policy snapshot it executed under, the post-rewrite plan, every event it emitted, and a rolling per-task summary. The run id is printed as the run starts (`Run 0f3c… — 3 tasks, up to 4 at a time`) — that is what the three commands below take.

```bash
kapel runs                     # what has been run here, newest first
kapel explain T03              # why T03 ran where it ran, and what happened to it
kapel explain T03 --run 0f3c…  # …in a specific run (default: the most recent)
kapel resume 0f3c…             # finish the tasks that never succeeded
```

- **`kapel runs`** lists id, status, start time, task counts and objective for the last `--limit` runs (default 20). `--json` emits the same as an array. A workspace with no database yet just says so.
- **`kapel explain <taskId>`** reads one task's history back: the agent it ended on and how many attempts it took, the routing decision re-derived by running the router over the run's own policy snapshot (naming the rule that matched, or the `suggestedAgent`/orchestrator fallback when none did), and a chronological digest of the decisions made about it — held behind a conflicting task, started, escalated, low confidence, failed validators, merged or conflicted worktree, completed, cancelled. `--json` gives `{task, agent, attempts, events, route}`.
- **`kapel resume <runId>`** rebuilds the run's task graph, marks everything that already succeeded as done, and re-executes the rest into the *same* run — events keep accruing and the final status is updated in place. It runs under the **policy snapshot recorded with the run**, not the current lock: the remaining tasks were planned and routed under the original constraints, and swapping the rules half way through would produce a run that never existed under any one policy. If the project's lock has moved on since, it says so and carries on; to plan under the new policy, start a fresh `kapel orchestrate`. `--worker-mode`, `--backend`, `--isolation`, `--no-validate` and `--tui` all work exactly as they do on `orchestrate`.

`--no-save` skips persistence for a run entirely — nothing is written and the run cannot be listed, explained or resumed afterwards. Persistence is also skipped silently in a workspace with no `.agent` directory, and a store that cannot be written to never fails a run: recording a run is an observer of it, not a participant. If you'd rather not commit the database, add `.agent/sessions.db*` to your `.gitignore`.

`kapel worker` is the child endpoint of that protocol — it reads one JSON task request on stdin and writes events plus one result line to stdout. It exists for `--worker-mode child` to call; you don't run it by hand.

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
- SQLite + Drizzle for durable sessions (`.agent/sessions.db`)
- Ink/React for the terminal dashboard (`--tui`)
- Git worktrees for parallel worker isolation
- JSONL events / JSON-RPC for integrations

## Packages

- `@agent/ai` — model/provider abstraction
- `@agent/core` — shared agent and tool primitives
- `@agent/policy` — natural-language policy IR and validation
- `@agent/orchestration` — task DAG, router and deterministic scheduler
- `@agent/workspace` — local/worktree execution isolation
- `@agent/protocol` — typed runtime events
- `@agent/session` — session persistence contracts and the SQLite/Drizzle store
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
