# Kapel

An orchestration-first open-source coding agent runtime.

The strongest model plans and delegates work; cheaper or specialized workers execute isolated tasks. Users define routing, concurrency, review, retry, and escalation behavior in natural language. That policy is compiled to a typed Policy IR and enforced by a deterministic scheduler.

## Quickstart

Like other terminal coding agents, `kapel` runs inside the repository you want it to work on. Install it globally from the packed tarball in this repo (identical on Windows cmd, macOS, and Linux — no build step):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.4.0.tgz

cd /path/to/your/repo
kapel                                 # first run asks which backend and models to use
```

The first time you run `kapel` on a terminal it asks four questions — which
coding backend (Claude Code, Codex, or a plain API key) and which model to use
for the orchestrator and for each class of worker — and stores the answers in
`~/.kapel/config.json`. See [First-run setup](#first-run-setup). Piped,
redirected or `--no-setup` runs skip it and fall back to environment variables
and defaults, so nothing in CI ever blocks on a prompt.

Once published to the npm registry this becomes simply `npm install -g @devfallingstar/kapel`.
If the tarball URL is unreachable from your network, the equivalent two-step
form is `git clone
https://github.com/devFallingstar/kapel.git kapel-src && npm install -g
./kapel-src/release/devfallingstar-kapel-0.4.0.tgz`.

> Do not use `npm install -g github:...` — npm's git-dependency preparation
> mishandles workspace monorepos and produces a broken install.

For development, clone and run `npm install && npm run build`, then use `node apps/cli/dist/index.js` or `npm install -g .` from the repo root.

### Interactive mode

`kapel` with no objective opens a conversation with the agent, in the directory you ran it from — the same way `claude`, `codex` or `opencode` do. Type, the agent works with its tools, and the conversation keeps going:

```text
$ kapel
kapel v0.4.0  claude-sonnet-5  session 0f3c9a2b
/path/to/your/repo
type /help for commands, /exit to quit
\ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands

kapel> calc.test.js is failing — find out why and fix it
→ read_file {"path":"calc.test.js"}
  ✓
→ grep {"pattern":"function add"}
  ✓
allow edit_file? {"path":"calc.js","old":"a - b","new":"a + b"} [y/N] y
  ✓
`add` subtracted instead of adding. Fixed and `node calc.test.js` now prints PASS.
tokens +4210 in, +318 out  (~$0.0138)

kapel> now add a `sub` function next to it, with a test
…
kapel> /exit
```

Read-only tools (`read_file`, `glob`, `grep`, `git_diff`) run without asking; anything that writes or shells out asks first, and Ctrl-C at a question answers "no". (Under `--backend codex` or `--backend claude-code` the external CLI runs the tools and enforces its own approvals, so kapel does not prompt at all — the banner says so.) Ctrl-C during a turn cancels that turn without ending the conversation; at the prompt, twice in a row exits (so does `/exit` and Ctrl-D).

The agent's reply appears as it is generated, a token at a time, rather than landing whole when the turn finishes. While it is thinking, or a tool is running, a single self-updating line at the bottom shows a spinner, how long the current wait has been, and the conversation's token count so far. That line is a terminal courtesy and nothing else: piping or redirecting `kapel` gets plain text with no spinner and no control characters in it.

The prompt is a real input editor, not a one-shot readline: end a line with `\` (or paste a multi-line block) to keep composing before you send it — a blank line or a line with no trailing `\` ends it. ↑/↓ recall earlier messages, persisted across sessions in `~/.kapel/history` (last 1000, machine-wide). Typing `/` and pressing Tab completes the slash command.

Commands available at the prompt:

| command | what it does |
|---|---|
| `/help` | list these commands |
| `/exit`, `/quit` | leave the session |
| `/new` | start a fresh conversation in this directory |
| `/sessions` | list this directory's conversations (id, last touched, messages, title) |
| `/resume <id>` | switch to a stored conversation — a unique id prefix is enough |
| `/model` / `/model <alias>` | show, or switch, the model used for the turns that follow |
| `/config` | re-run setup and apply it to this conversation — switches backend and/or model without losing the thread |
| `/usage` | tokens and cost so far |
| `/compact` | compact the conversation history now (native backend only) |
| `/orchestrate "<objective>"` | run the multi-agent pipeline without leaving the prompt; see [Orchestrate](#orchestrate) |

Anything else you type is a message to the agent.

On the native backend, a long conversation compacts itself automatically once it passes 60 messages — old tool results get elided (kept ones are marked, nothing is dropped from the transcript), leaving one dim `≈ context compacted: …` line — so it keeps going instead of eventually blowing the model's context window. `/compact` does the same thing on demand, useful right before a turn you want as much context budget for as possible. Under `--backend codex` or `--backend claude-code` the external CLI manages its own context, so `/compact` there just says it isn't supported.

**Sessions are per directory and survive restarts.** Every conversation is recorded in `.agent/sessions.db` beside the repo (the directory is created on first use — no `kapel init` needed), titled from your first message. Pick one back up with:

```bash
kapel chat --continue           # the most recent conversation here
kapel chat --session 0f3c9a2b   # a specific one (id or unique prefix)
kapel chat --no-save            # …or don't record this one at all
```

`kapel chat` is the explicit spelling of the default: use it when you want those flags, or in a script. The globals below (`-m/--model`, `--cwd`, `-y`, `--timeout`, `--max-iterations`) work the same here. `--json` does not — there is no event stream to script against until you say something, so use the one-shot form for that.

### One-shot mode

Give `kapel` an objective on the command line and it runs a single agent loop to completion and exits — the shape to reach for in CI, in a script, or when you already know exactly what you want done:

```bash
kapel "fix the failing test"
kapel --json "fix the failing test"    # newline-delimited JSON events
kapel -y "fix the failing test"        # no permission prompts
```

`kapel exec "<objective>"` is the same thing spelled out.

Useful commands and flags:

- `kapel chat` — the interactive agent (also `kapel` with no objective); `--continue`, `--session <id>`, `--no-save`
- `kapel init` — copy the default `.agent/` configuration template into the current repo
- `kapel models` — list available model aliases and their credential status
- `kapel plan "<objective>"` / `kapel orchestrate "<objective>"` — multi-agent planning and routed parallel execution; see [Orchestrate](#orchestrate)
- `kapel runs` / `kapel explain <taskId>` / `kapel resume <runId>` — inspect and continue recorded runs; see [Sessions](#sessions)
- `-m, --model <alias>` — pick the model (default: `AGENT_MODEL`, then your stored config, then `claude-sonnet-5`)
- `-y, --yes` — auto-approve permission prompts; without it, write/edit/bash ask on the terminal
- `--json` — newline-delimited JSON events for scripting/CI (one-shot and orchestrate only). Assistant text arrives twice over: as `model.text.delta` lines while it streams, and once whole in the turn's `model.turn.completed` line — a consumer that only knows the latter can ignore the deltas and read exactly what it always did
- `--timeout <seconds>`, `--max-iterations <n>` — run limits
- `--backend <native|codex|claude-code>` — execution backend (default `native`, or `AGENT_BACKEND`, or your stored config); see [Codex backend](#codex-backend) and [Claude Code backend](#claude-code-backend)
- `--sandbox <read-only|workspace-write|danger-full-access>` — Codex sandbox mode (default `workspace-write`)
- `--no-setup` — never run the first-run wizard; use environment variables and defaults instead
- `kapel config` — re-run setup; `--show` prints the current configuration and its path, `--path` prints just the path

### First-run setup

`kapel` needs to know two things before it can do anything: how to talk to a
model, and which models to use. On a terminal it asks once, on the first run of
any command that needs an answer, and stores what you say in
`~/.kapel/config.json` (`$KAPEL_CONFIG_DIR` overrides the directory):

```text
Which coding backend should kapel use?
❯ ◉ Claude Code (use your Claude Code subscription login — no API key)
    ◯ Codex (use your ChatGPT login via the OpenAI Codex CLI — no API key)
    ◯ API key (Anthropic/OpenAI) (call model APIs directly with a key or token)
```

…followed by the orchestrator model and the two worker models (normal and low
complexity). The chosen backend is probed as you pick it, so a missing or
logged-out CLI is reported there and then rather than on your first objective.

```bash
kapel config            # re-run the wizard at any time
kapel config --show     # what is configured, and where the file lives
kapel config --path     # just the path
kapel --no-setup "…"    # never ask; use environment variables and defaults
```

Inside the interactive agent, `/config` runs the same wizard and applies the
answers to the conversation you are already in — the thread is kept, only the
turns that follow change backend or model.

**Everything resolves in one order**, wherever a backend or a model is chosen
(one-shot, chat, `plan`, `orchestrate`, `policy compile`):

```text
explicit CLI flag  >  environment variable  >  ~/.kapel/config.json  >  built-in default
     --backend            AGENT_BACKEND              backend                 native
     -m/--model           AGENT_MODEL                models.orchestrator     claude-sonnet-5
```

`.agent/config.yaml` is a separate, per-project thing: it says which model each
*agent* of an orchestration run uses. `kapel init` seeds it from your global
config when you have one (`lead` and `reviewer` from the orchestrator model,
`worker` and `cheap` from the two worker models), and copies the template
unchanged when you don't.

### Project instructions (AGENTS.md)

Drop an `AGENTS.md` in your repo and kapel follows it from the first turn — the same file Codex and opencode already read, and that Claude Code picks up via `@AGENTS.md` imports, so a repository only has to write its rules once. Up to three are merged into the system prompt, machine-level first so a project's rules add to (never silently lose to) your personal ones:

1. `~/.kapel/AGENTS.md` (`$KAPEL_CONFIG_DIR` overrides the directory) — your own rules, for every project.
2. `AGENTS.md` at the repo root — project rules, shared with other agents.
3. `.agent/AGENTS.md` — kapel-specific overrides.

All that exist are concatenated in that order; a missing file is simply skipped. The interactive banner names whichever were loaded (`instructions: AGENTS.md, .agent/AGENTS.md`), and one-shot runs (`kapel "<objective>"`) apply them the same way, silently. The combined text is capped at 32 KiB. An explicit `--system "<prompt>"` replaces the default system prompt outright and is not combined with `AGENTS.md` files. Delegated backends (`--backend codex`, `--backend claude-code`) run the external CLI's own agent loop, which does not take a system prompt from kapel — those AGENTS.md files are not injected there, though the CLIs themselves may already read AGENTS.md-style files on their own.

### Claude Code backend

Want Claude models without an `ANTHROPIC_API_KEY`? Pass `--backend claude-code`
(or set `AGENT_BACKEND=claude-code`, or pick it in the wizard) to delegate the
work to Anthropic's own Claude Code CLI, under your existing subscription
login:

```bash
npm install -g @anthropic-ai/claude-code
claude                  # once, to log in with your Claude subscription
kapel --backend claude-code "fix the failing test"
kapel --backend claude-code            # …or a whole conversation
```

`kapel` never touches Anthropic's OAuth flow or Claude Code's credentials on
this path — it spawns `claude -p` in the workspace and renders the stream it
prints. `-m/--model` (or your configured orchestrator model) is forwarded to
`--model`, which takes both aliases (`opus`, `sonnet`, `haiku`) and full model
ids; `default` means "whatever your account defaults to" and is not forwarded.
Permission prompts do not apply here — Claude Code enforces its own approvals,
which the interactive banner says out loud.

**Conversations continue on Claude Code's side.** The first turn runs plain;
every turn after it passes `--resume <session_id>` with the id Claude Code
reported, so the thread lives in the CLI rather than being re-sent. Resuming a
stored conversation from the database (`kapel chat --continue`) replays the
transcript once on the first turn and continues by id from there. Codex chats
are stateless instead — `codex exec --json` does not report a resumable id —
so each Codex turn carries the recent transcript with it.

Orchestration (`kapel orchestrate`) does not support `--backend claude-code`
yet and says so; use `--backend codex` or the native loop there.

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
- `--backend codex` — delegate every task to the Codex CLI instead of the native loop (see [Codex backend](#codex-backend)). `--backend claude-code` is not supported here yet.
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

Interactive conversations live in the same database, in their own tables — `/sessions` and `kapel chat --continue` read those, `kapel runs` reads the orchestration runs above. See [Interactive mode](#interactive-mode).

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
