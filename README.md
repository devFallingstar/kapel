# Kapel

An orchestration-first open-source coding agent runtime.

The strongest model plans and delegates work; cheaper or specialized workers execute isolated tasks. Users define routing, concurrency, review, retry, and escalation behavior in natural language. That policy is compiled to a typed Policy IR and enforced by a deterministic scheduler.

## Quickstart

Like other terminal coding agents, `kapel` runs inside the repository you want it to work on. Install it globally from the packed tarball in this repo (identical on Windows cmd, macOS, and Linux — no build step):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.6.0.tgz

cd /path/to/your/repo
kapel                                 # first run asks which backend and models to use
```

The first time you run `kapel` on a terminal it asks five questions — which
coding backend (Claude Code, Codex, or a plain API key) and which model to use
for the orchestrator and for each of the three worker tiers — and stores the
answers in
`~/.kapel/config.json`. See [First-run setup](#first-run-setup). Piped,
redirected or `--no-setup` runs skip it and fall back to environment variables
and defaults, so nothing in CI ever blocks on a prompt.

Once published to the npm registry this becomes simply `npm install -g @devfallingstar/kapel`.
If the tarball URL is unreachable from your network, the equivalent two-step
form is `git clone
https://github.com/devFallingstar/kapel.git kapel-src && npm install -g
./kapel-src/release/devfallingstar-kapel-0.6.0.tgz`.

> Do not use `npm install -g github:...` — npm's git-dependency preparation
> mishandles workspace monorepos and produces a broken install.

For development, clone and run `npm install && npm run build`, then use `node apps/cli/dist/index.js` or `npm install -g .` from the repo root.

### Interactive mode

`kapel` with no objective opens a conversation with the agent, in the directory you ran it from — the same way `claude`, `codex` or `opencode` do. Type, the agent works with its tools, and the conversation keeps going:

```text
$ kapel
kapel v0.6.0  claude-sonnet-5  session 0f3c9a2b
/path/to/your/repo
type /help for commands, /exit to quit
\ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands and @files

kapel> calc.test.js is failing — find out why and fix it
→ read_file {"path":"calc.test.js"}
  ✓
→ grep {"pattern":"function add"}
  ✓
  calc.js
  - return a - b;
  + return a + b;
  a = always allow edit_file this session
allow edit_file? [y/n/a] y
  ✓
`add` subtracted instead of adding. Fixed and `node calc.test.js` now prints PASS.
tokens +4210 in, +318 out  (~$0.0138)

kapel> now add a `sub` function next to it, with a test
…
kapel> /exit
```

Read-only tools (`read_file`, `glob`, `grep`, `git_diff`) run without asking; anything that writes or shells out asks first, and Ctrl-C at a question answers "no". The question is what will happen, not a truncated blob of JSON: `bash` shows the command it will run, `edit_file` a `-`/`+` diff of the replacement, `write_file` the head of the new file. Answers are `y` (allow this once), `n`/Enter/Ctrl-C (deny), or `a` — allow it and stop asking for the rest of the session: for `bash` that remembers the *command prefix* (answering `a` to `npm test --run foo` stops asking for `npm test …`, while `npm publish` still asks; a command with a shell operator such as `&&` or `|` is never remembered), and for every other tool it remembers the tool name. Nothing is written to disk — a new `kapel` starts asking again — and an explicit deny rule is never overridden by it. (Under `--backend codex` or `--backend claude-code` the external CLI runs the tools and enforces its own approvals, so kapel does not prompt at all — the banner says so.) Ctrl-C during a turn cancels that turn without ending the conversation; at the prompt, twice in a row exits (so does `/exit` and Ctrl-D).

The agent's reply appears as it is generated, a token at a time, rather than landing whole when the turn finishes. While it is thinking, or a tool is running, a single self-updating line at the bottom shows a spinner, how long the current wait has been, and the conversation's token count so far. That line is a terminal courtesy and nothing else: piping or redirecting `kapel` gets plain text with no spinner and no control characters in it.

The prompt is a real input editor, not a one-shot readline: end a line with `\` (or paste a multi-line block) to keep composing before you send it — a blank line or a line with no trailing `\` ends it. ↑/↓ recall earlier messages, persisted across sessions in `~/.kapel/history` (last 1000, machine-wide). Tab completes what is under the cursor: a `/` command name, the argument of a command that has a fixed vocabulary (`/model ` offers the built-in aliases), or an `@` file mention.

**`@` mentions a file.** Type `@` and part of a path, then Tab: the match is fuzzy over the whole path, so `@clisrc` finds `apps/cli/src/…` and `@input.ts` finds it wherever it lives. A unique winner is filled in; several share whatever prefix they have in common, and pressing Tab again lists them. The candidates are the workspace's files as `git ls-files --cached --others --exclude-standard` reports them — tracked files plus untracked ones your `.gitignore` does not exclude — cached for a few seconds so holding Tab down does not spawn a process per keystroke. Outside a git repo the list comes from a bounded walk instead (four levels deep, `node_modules`/`.git`/`dist` skipped).

The mention stays plain text in your message. When the message is sent, every `@` token that names a real file inside the workspace is collected into one extra line:

```text
kapel> why is @apps/cli/src/input.ts holding stdin the whole time?

  …sent as…
  why is @apps/cli/src/input.ts holding stdin the whole time?

  [mentioned files: apps/cli/src/input.ts]
```

The file's *contents* are never pasted in — the agent has `read_file` and decides for itself how much of the file it needs, which keeps the context window for the conversation instead of for bytes nobody asked for. A token that names nothing (`@here`, an email address, a path outside the directory you opened `kapel` in) is left alone and reported to nobody.

Commands available at the prompt:

| command | what it does |
|---|---|
| `/help` | list these commands |
| `/exit`, `/quit` | leave the session |
| `/new` | start a fresh conversation in this directory |
| `/sessions` | list this directory's conversations (id, name, last touched, messages, title) |
| `/resume <id\|name>` | switch to a stored conversation — a unique id prefix or a `/name` both work |
| `/name` / `/name <name>` | show, or set, this conversation's name — persists immediately |
| `/fork` / `/fork <name>` | branch this conversation (everything said so far) into a new session and switch to it |
| `/model` / `/model <alias>` | show, or switch, the model used for the turns that follow |
| `/config` | re-run setup and apply it to this conversation — switches backend and/or model without losing the thread |
| `/usage` | tokens and cost so far |
| `/compact` | compact the conversation history now (native backend only) |
| `/undo` | put the files back the way they were before the last prompt |
| `/orchestrate "<objective>"` | run the multi-agent pipeline without leaving the prompt; see [Orchestrate](#orchestrate) |
| `/<name>` (custom) | run a command from `.agent/commands/<name>.md`; see below |

Anything else you type is a message to the agent.

**Custom commands from `.agent/commands/*.md`.** A file there defines `/<name>` (the name is the filename, lowercase letters/digits/hyphens only — e.g. `.agent/commands/review.md` becomes `/review`). The file is an optional YAML front matter block followed by a prompt template:

```markdown
---
description: Review the current diff for bugs, then summarize risk
model: claude-haiku-4-5
---
Review the current diff for bugs, correctness issues, and anything unfinished.

$ARGUMENTS
```

`description` shows up in `/help`. `model` pins *this one turn* to that model (native backend only — on a delegated backend, or an alias that doesn't resolve, kapel prints one line saying the pin was skipped and runs on the session's current model instead); the session's own model is unaffected before or after. `agent` is parsed but reserved for a future sub-agent dispatch and does nothing yet. Whatever you type after the command name replaces every `$ARGUMENTS` in the template, or — if the template has no placeholder — gets appended after a blank line. The expanded text is sent exactly like a typed message: checkpoints, `@` mentions and history all apply normally. A file whose name collides with a built-in command (`/help.md`, say) is skipped in favor of the built-in, with a warning printed by `/help`; commands are scanned once at startup and rescanned on every `/help`, so adding a file mid-session doesn't need a restart. `kapel init` ships one example, `.agent/commands/review.md`.

On the native backend, a long conversation compacts itself automatically once it passes 60 messages — old tool results get elided (kept ones are marked, nothing is dropped from the transcript), leaving one dim `≈ context compacted: …` line — so it keeps going instead of eventually blowing the model's context window. `/compact` does the same thing on demand, useful right before a turn you want as much context budget for as possible. Under `--backend codex` or `--backend claude-code` the external CLI manages its own context, so `/compact` there just says it isn't supported.

**`/undo` — a checkpoint before every prompt.** The interactive agent writes straight to your files, with no worktree between you and it, so kapel takes a snapshot of the working tree just before each message is sent (slash commands change nothing, so they take none) and `/undo` restores the newest one: `↩ restored 3 files to before "fix the tests" (2 min ago)`. The snapshot is a git tree object built against a *temporary* index — your index, your worktree and your stash list are never touched — which means it covers untracked files too, not only the ones `git stash` would see. Restoring diffs that snapshot against the tree as it is now and reverses the difference: files the turn changed are rewritten, files it created are deleted, files it deleted come back.

Read the fine print before you rely on it:

- **git only.** Outside a git repository nothing is captured and `/undo` says so — full-directory copies of an arbitrary working directory are not a trade kapel is willing to make on your behalf.
- **It reverts the file, not the author.** Everything that changed since the checkpoint goes back, whoever changed it — the agent's `edit_file`, a `bash` command it ran, your own editor in another window, a build that wrote into the tree. If a turn ran that long, look before you undo.
- **Scope.** The snapshot covers the whole repository the working directory belongs to, minus anything `.gitignore` excludes (`node_modules/`, build output, `.env`) and minus `.agent/`, which holds kapel's own session database and task worktrees. Those are never captured and never restored.
- **One-way, and only for this process.** There is no `/redo`: an undone checkpoint is popped. The last 20 checkpoints of a session are kept, in memory only — quitting kapel forgets them. The commit objects behind them stay in the repository unreferenced (`git show <hash>` still works if you noted one down) until git's own garbage collection eventually prunes them.
- **Refusals.** `/undo` will not run while a merge, rebase, cherry-pick, revert or bisect is half-finished; finish or abort that first. The checkpoint stays put in the meantime.

**Sessions are per directory and survive restarts.** Every conversation is recorded in `.agent/sessions.db` beside the repo (the directory is created on first use — no `kapel init` needed), titled from your first message. Pick one back up with:

```bash
kapel chat --continue           # the most recent conversation here
kapel chat --session 0f3c9a2b   # a specific one (id, unique prefix, or /name)
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

**Piped stdin becomes context**, not a second conversation: when stdin isn't a terminal and you also give an objective, whatever is piped in is read to the end (capped at 1 MiB, truncated with a `[stdin truncated]` marker past that) and appended after the objective, separated by a `--- piped input ---` line:

```bash
cat error.log | kapel "explain this failure"
```

Piping nothing (`< /dev/null`, or a command that produces no output) leaves the objective untouched — same as not piping at all. This composes with every flag above (`--json`, `-y`, `--backend`, `-m`, …), since the piped text only ever changes the objective/prompt text. Piping with **no** objective given is a different, unchanged feature — lines piped in drive the interactive prompt instead (see [Interactive mode](#interactive-mode)).

**Attach images with `-i/--image <path>`** (repeatable, up to 4 per run, 5 MiB per file, 20 MiB combined):

```bash
kapel -i screenshot.png "why does this dialog render off-screen?"
kapel -i before.png -i after.png "what changed between these two?"
```

PNG, JPEG, GIF and WEBP are recognized from the file's actual bytes, not its extension — a `.png` that is really a renamed JPEG is still sent correctly as JPEG. Support depends on the backend:

| Backend | Support |
|---|---|
| native (default) | Sent as image content blocks alongside the objective, in the same request as the rest of the turn. |
| `--backend codex` | Forwarded as repeated `codex exec -i <path>` flags. This has only been exercised against a fake CLI in kapel's own tests, not the real Codex binary — treat it as unverified until you've tried it. |
| `--backend claude-code` | Not supported: `claude -p` (headless mode) has no documented flag for attaching an image, so kapel fails the run immediately with a clear message rather than silently dropping the attachment or stuffing it into the text prompt. |

Interactive mode (`kapel chat`) does not accept `-i/--image` yet.

Useful commands and flags:

- `kapel chat` — the interactive agent (also `kapel` with no objective); `--continue`, `--session <id|name>`, `--no-save`
- `kapel init` — copy the default `.agent/` configuration template into the current repo
- `kapel models` — list available model aliases and their credential status
- `kapel plan "<objective>"` / `kapel orchestrate "<objective>"` — multi-agent planning and routed parallel execution; see [Orchestrate](#orchestrate)
- `kapel runs` / `kapel explain <taskId>` / `kapel resume <runId>` — inspect and continue recorded runs; see [Sessions](#sessions)
- `kapel sessions` / `kapel sessions fork <id|name> [--name <name>]` — list and branch interactive chat sessions; see [Sessions](#sessions)
- `-m, --model <alias>` — pick the model (default: `AGENT_MODEL`, then your stored config, then `claude-sonnet-5`)
- `-y, --yes` — auto-approve permission prompts; without it, write/edit/bash ask on the terminal
- `-i, --image <path>` — attach an image (repeatable, up to 4, 5 MiB each); native and codex backends only, see above
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

…followed by the orchestrator model and the three worker models — the complex
tier (the hardest coding work), the everyday tier, and the small-task tier
(single-function changes and exploration). The chosen backend is probed as you
pick it, so a missing or logged-out CLI is reported there and then rather than
on your first objective.

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
`complex`, `worker` and `cheap` from the three worker models), and copies the
template unchanged when you don't.

### Permissions

Without `-y`, `write_file`/`edit_file`/`bash` ask on the terminal (`[y/n/a]` —
"a" remembers the answer for the rest of that run only, never written
anywhere). A `permission` block, hand-edited into either config file, changes
what asks and what doesn't — opencode's syntax, unchanged:

```jsonc
// ~/.kapel/config.json
{
  "version": 1, "backend": "…", "models": { "…": "…" },
  "permission": {
    "edit_file": "allow",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" }
  }
}
```

```yaml
# .agent/config.yaml — same shape, applies to this project only
permission:
  edit_file: allow
  bash:
    "*": ask
    "git *": allow
    "rm *": deny
```

Each tool's value is `"allow" | "ask" | "deny"`, except `bash`, whose value is
a map of command patterns to verdicts: `"*"` is the catch-all, `"git *"`
matches any `git` subcommand, `"git log *"` matches only `git log`, and a bare
`"git"` matches only `git` with no subcommand at all — the most specific
pattern that matches wins, and an explicit `"deny"` always wins a tie.

Precedence: built-in defaults, then `~/.kapel/config.json`, then
`.agent/config.yaml` — each layer only needs to mention what it wants to
change. A `"deny"` from any of these three cannot be talked around by
answering "a" at the prompt; it never reaches the prompt at all. There is no
`/config` UI for this yet — edit the file, restart the run. Neither file needs
a `permission` block; both work exactly as before without one.

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

**Orchestration runs on it too.** `kapel orchestrate --backend claude-code`
spawns one `claude -p` per task, in that task's own workspace (its worktree,
under the default `--isolation worktree`), on the model the routed agent
declares in `.agent/agents/*.md`. Unlike Codex, Claude Code can be scoped per
run, so each agent's `tools:` list is translated into `--allowedTools` —
a reviewer really does run without `Write` and `Edit`. Approvals stay Claude
Code's own (`acceptEdits`), and the project's `validation:` commands gate
mutating tasks here just as they do on the native loop.

What this backend still does not support is `-i/--image`: `claude -p` has no
image flag, so a run with attachments fails immediately with a clear message
rather than sending the objective without them — see
[One-shot mode](#one-shot-mode).

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

- `kapel policy compile` — uses an LLM (same backend/model resolution as a run; `-m/--model` selects the model, `--backend` decides whether it goes through an API key or your Codex/Claude Code login) to compile `orchestration.md` into `.agent/orchestration.lock.json`, reporting any warnings (judgement calls) or ambiguities (source phrases it couldn't map). Each warning/ambiguity that quotes a source phrase is annotated with the `orchestration.md:12` line (or `:12-13` when the phrase wraps lines) it was found at — best-effort: a phrase the compiler paraphrased instead of quoting carries no location, never a wrong one. `--json` adds parallel `warningLocations`/`ambiguityLocations` arrays (`null` where unresolved). The text output also prints what the compile spent; on a delegated backend that is whatever the CLI reported, and "none reported" when it reported nothing rather than a misleading `0`.
- `kapel policy check` — a fast, offline gate: confirms the lock still matches `orchestration.md` and the current agents, without calling an LLM. Good for CI.
- `kapel policy explain` — prints a human-readable summary of the locked policy from the lock file, also without calling an LLM. Same line-annotated warnings/ambiguities as `compile`.
- `kapel policy diff` — recompiles `orchestration.md` (one LLM call, same resolution as `compile`) and diffs the result against the current lock **without writing it**, so you can review a change before committing to it: routing/review/escalation rules added, removed, or changed field-by-field (matched by each rule's own `id`, not its position — reordering a policy's rules between compiles is not a change), plus any changed defaults (`orchestrator`, `maxConcurrency`, `parallelizeIndependentTasks`, `defaultMaxAttempts`). `--json` emits `{ok, unchanged, defaults, routing, review, escalation, warnings, ambiguities}`. "Same resolution as `compile`" includes the backend: under `--backend codex`/`--backend claude-code` the recompile is delegated to that CLI, so `diff` needs no API key either.

All four accept `--cwd` and `--json`.

### Orchestrate

`kapel "<objective>"` runs one model in one loop. `kapel orchestrate "<objective>"` runs the full M3 pipeline instead: the objective is **planned** into a task DAG, the plan is **rewritten by your compiled policy** (unknown agents dropped, mandated reviews injected, unrunnable plans rejected), and the resulting tasks are **routed to different workers and executed in parallel** by the deterministic scheduler.

```bash
kapel policy compile                        # once, and after every orchestration.md edit
kapel plan "add a health endpoint"          # preview the task graph — no work is done
kapel orchestrate "add a health endpoint"   # plan, then execute it
```

Both commands require a fresh `.agent/orchestration.lock.json` and refuse to guess: a missing or stale lock is an error telling you to run `kapel policy compile`. The planner itself runs on the model your policy's orchestrator agent is configured with (`-m/--model` overrides it; if that agent or its credential is unavailable, the CLI falls back to the normal default model and says so).

Under `--backend codex` or `--backend claude-code` the planning conversation is delegated to that CLI too, so **planning needs no API key either** — it runs as one read-only `codex exec --sandbox read-only` / `claude -p --permission-mode plan` call in your workspace, on the orchestrator agent's configured model (or whatever `-m/--model` names, verbatim), and the plan it replies with is validated against the same schema and the same rules as on the native path.

`kapel policy compile` is delegated the same way on those backends — the same single read-only call, the same IR schema, the same warnings and ambiguities in the lock — on whatever model your `orchestrator` setting names (`-m/--model` > `AGENT_MODEL` > `~/.kapel/config.json`), or the CLI's own default when nothing names one, in which case the lock records it as `<codex default>`/`<claude-code default>`. `kapel policy diff` recompiles through the same delegated path. **So the whole pipeline — compile, diff, plan, orchestrate — runs on a Codex or Claude Code subscription with no API key anywhere.**

`kapel plan` prints one row per task — id, type, complexity, the agent the router would pick, dependencies, title — plus any reviews the policy injected and any notes from the rewrite. `--json` emits a single `{plan, injectedReviews, notes, routes}` object. `kapel orchestrate --dry-run` prints exactly the same thing.

`kapel plan --why [taskId]` additionally prints the routing rationale — the same `PolicyRouter.decide` the scheduler itself runs at execution time — for one task, or every task when no id is given: which rule matched (its match criteria, strength and weight) or, with no matching rule, whether it fell back to the task's `suggestedAgent` or the policy's orchestrator, plus the model alias the picked agent is configured with. `--json` adds a `why` array of `{taskId, title, type, complexity, agent, modelAlias?, reason, rule?}` alongside the usual plan output.

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
- `--backend claude-code` — delegate every task to the Claude Code CLI instead (see [Claude Code backend](#claude-code-backend)): one `claude -p` per task in that task's workspace, on the agent's configured model, with the agent's `tools:` list passed through as `--allowedTools`. Claude Code enforces its own approvals (`acceptEdits`), and validators still run.
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

Interactive conversations live in the same database, in their own tables — `/sessions` and `kapel chat --continue` read those, `kapel runs` reads the orchestration runs above. See [Interactive mode](#interactive-mode). Outside the REPL, `kapel sessions` lists them the same way `kapel runs` lists orchestration runs, and `kapel sessions fork <id|name> [--name <name>]` copies one — its title, model and whole transcript so far — into a brand new session that then evolves independently of the one it was forked from:

```bash
kapel sessions                                # this workspace's chat sessions, newest-touched first
kapel sessions fork 0f3c…                     # copy a conversation into a new, unnamed session
kapel sessions fork 0f3c… --name "plan b"     # …and name the copy
```

`kapel sessions` shows a `NAME` column once any listed session has one; a session picks up a name by being forked with `--name`, or from `/name` at the prompt (see the command table above — it persists immediately, no need to wait for the next message). `kapel sessions fork` and `--session` everywhere they appear (`kapel chat --session`, `/resume`) resolve `<id|name>` in this order: an exact id, then a unique id prefix, then an exact name — if two sessions share a name the most recently touched one is used and a note is printed to stderr. `--json` on either `sessions` command emits the same fields as an array/object instead of a table/line.

`/fork [name]` at the prompt does the same copy `kapel sessions fork` does, but from inside the REPL and on the conversation you're already in: it branches everything said so far into a new session and switches you onto it immediately (the original stays put, unaffected, with its own history up to the fork point). Useful for "let me try a different approach without losing where I was" — `/fork before-refactor`, try the risky thing, `/resume` back to the original if it doesn't pan out.

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
