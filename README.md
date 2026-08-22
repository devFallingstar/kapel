# Kapel

An orchestration-first open-source coding agent runtime.

The strongest model plans and delegates work; cheaper or specialized workers execute isolated tasks. Users define routing, concurrency, review, retry, and escalation behavior in natural language. That policy is compiled to a typed Policy IR and enforced by a deterministic scheduler.

## Quickstart

Like other terminal coding agents, `kapel` runs inside the repository you want it to work on. Install it globally from the npm registry (identical on Windows cmd, macOS, and Linux — no build step):

```bash
npm install -g @devfallingstar/kapel

cd /path/to/your/repo
kapel                                 # first run asks which backends and models to use
```

`kapel` opens a prompt and stays there. **All agent work happens in that
REPL** — talking, planning, orchestrating, resuming. The commands on the shell
(`init`, `config`, `models`, `runs`, `sessions`, `explain`, `policy`) set kapel
up and inspect what it did; none of them do the work themselves.

**A new project sets itself up, and calls nothing to do it.** The first time
you open `kapel` in a repository that has no `.agent/`, it just does it — one
line, then the work:

```text
setting this project up for kapel — creating .agent/ and compiling the
orchestration policy…
```

That's exactly what `kapel init` and `kapel policy compile` do — the
`.agent/` template (agents, `config.yaml` seeded from your configuration and
this repo's `package.json` check scripts, `handoff.md`, the `.gitignore`
entries) and turning `.agent/orchestration.md` into the policy lock — printed
with the same summary those commands print. **No model is called**, and no
provider credential is needed: the shipped policy is in kapel's canonical
form, which the compile reads rather than compiles (see
[Policy](#policy)). A project that only lacks the compiled lock gets just the
compile, and one that has both is left alone (plain chat needs none of it).
If setup fails partway, kapel says so in one line and does not retry it on
every `/plan` or `/orchestrate` — fix the problem and run the command by
hand. Nothing runs where nobody would see it: piped and redirected runs are
never auto-set-up, and `--no-setup` turns this off exactly as it turns off
the first-run wizard — so `kapel init` and `kapel policy compile` remain the
way to do it by hand, or in CI.

**Nothing kapel does on its own calls a model.** Opening the REPL is not
asking for work, so startup runs only the free half of setup — the files, and
a canonical policy, which is every project kapel sets up itself. A project
whose policy has been rewritten as prose is the one thing that would need a
model, and startup declines to spend it: it says so in one line and leaves it
for the `/plan` or `/orchestrate` that actually wants a policy.

```text
this project's orchestration policy has not been compiled — /plan or
/orchestrate will compile it (one model call), or `/policy` rewrites it in
the form that needs none.
```

So a session spent chatting, reading or editing files never spends a token on
orchestration it never used. The first model call of a run is the one you
asked for.

**And nothing asks you to keep the lock in step.** Edit
`.agent/orchestration.md` in your editor and the next `kapel` picks the change
up on the way in — reading it, not compiling it, so there is nothing to spend
and no command to remember. A policy you rewrote as prose is the exception,
and takes the deferral above rather than your tokens.

The first time you run `kapel` on a terminal it asks five questions — which
coding backends you have (Claude Code, Codex, a plain API key: tick as many as
apply) and which model, on which of them, to use for the orchestrator and for
each of the three worker tiers — and stores the answers in
`~/.kapel/config.json`. A single directory can override any of it in
`.agent/config.local.json`. See [First-run setup](#first-run-setup). Piped,
redirected or `--no-setup` runs skip it and fall back to environment variables
and defaults, so nothing in CI ever blocks on a prompt.

If the npm registry is unreachable from your network, the same package ships
as a committed tarball in this repo: `npm install -g
https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.15.0.tgz`,
or the two-step form `git clone
https://github.com/devFallingstar/kapel.git kapel-src && npm install -g
./kapel-src/release/devfallingstar-kapel-0.15.0.tgz`.

> Do not use `npm install -g github:...` — npm's git-dependency preparation
> mishandles workspace monorepos and produces a broken install.

For development, clone and run `npm install && npm run build`, then use `node apps/cli/dist/index.js` or `npm install -g .` from the repo root.

### The REPL

`kapel` opens a conversation with the agent, in the directory you ran it from — the same way `claude`, `codex` or `opencode` do. Type, the agent works with its tools, and the conversation keeps going:

```text
$ kapel
╭─ kapel v0.15.0 ──────────────────────────────────────────────────────────────────────────────────╮
├─────────────────────────────────────────────────┬────────────────────────────────────────────────┤
│ setup                                           │ activity                                       │
│ workspace    /path/to/your/repo                 │ today    1 run · 1 chat                        │
│ session      0f3c9a2b                           │          2 tasks ok · 1 failed                 │
│ chat         claude-code · opus                 │          412.0k in · 38.0k out                 │
│ backends     ✓ claude-code  ! codex  ✗ native   │ 7 days   2 runs · 9 chats                      │
│                                                 │          2.3M in · 258.0k out  ~$4.21          │
│ orchestrator claude-code:opus                   │                                                │
│ complex      claude-code:sonnet                 │ usage (kapel-tracked, 7 days)                  │
│ middle       codex:gpt-5.1-codex *              │ claude-code  412.0k in · 38.0k out             │
│ low          native:claude-haiku-5              │ codex        1.9M in · 220.0k out              │
│                                                 │ native       0 in · 0 out                      │
│ * from .agent/config.local.json                 │                                                │
╰─────────────────────────────────────────────────┴────────────────────────────────────────────────╯
▌ type /help for commands, /exit to quit
▌ \ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands and @files

> calc.test.js is failing — find out why and fix it
→ read_file {"path":"calc.test.js"}
  ✓
→ grep {"pattern":"function add"}
  ✓
  calc.js
  - return a - b;
  + return a + b;
  a = always allow edit_file this session
allow edit_file? [y/n/a, or say what to do instead] y
  ✓
`add` subtracted instead of adding. Fixed and `node calc.test.js` now prints PASS.
tokens +4210 in, +318 out  (~$0.0138)
> now add a `sub` function next to it, with a test
…
> /exit
────────────────────────────────────────────────────────────────────────────────────────────────────
                                                       ← the band, always at the foot of the screen
────────────────────────────────────────────────────────────────────────────────────────────────────
```

**The dashboard.** The opening panel is the answer to "what am I about to spend, and what have I already spent". Its left half is setup: which conversation this is, what it runs on, which backends are logged in (`✓`), installed but logged out (`!`), not installed (`✗`) or still being probed (`…`), and the model each of the four orchestration roles would use, marked `*` where this checkout's `.agent/config.local.json` overrode the machine's answer. Its right half is work done, read out of `.agent/sessions.db`: orchestration runs and chat sessions started, tasks that succeeded and failed, and tokens spent — today, and over the last seven calendar days. A fresh workspace reads `no runs yet` rather than a row of zeroes, and `kapel chat --no-save` says `not recorded` rather than claiming you did nothing.

The panel is redrawn on demand by **`/stats`**, with everything re-read and every backend re-probed — which is also how a `…` cell from startup gets filled in: the login probe spawns each CLI twice, so startup gives it one second and then draws what it has rather than making you wait.

The last block is the honest part. Neither `claude` nor `codex` reports remaining subscription allowance anywhere a program can read it — `claude auth status --json` answers `loggedIn`/`authMethod`/`apiProvider` and nothing about quota, and `codex login status` answers with one line of text; both CLIs show their limits only inside their own interactive session. So kapel does not guess at a percentage or a reset time. What it shows instead is what it watched each backend spend through kapel itself, labelled `usage (kapel-tracked, 7 days)` so it is never mistaken for a quota. Those numbers come from a `usage_events` table written at the end of every chat turn and every orchestration run, so they survive the process that produced them.

**One colour, and where it is allowed to appear.** Everything above that is *furniture* — the panel's border and its title, the bar down the left of kapel's own remarks, the `❯` in a picker — is drawn in a single muted sky blue (`#7EB6D9`), and nothing else in the shell is. (Two pieces of chrome are deliberately not: the input band's rules are a soft white, because the band is where *you* are and painting its edges in kapel's colour made the prompt read as one more thing kapel had drawn, and the bar a sent message becomes is a grey background, the one treatment in the palette that survives being scrolled past.) The assistant's prose stays undecorated, tool traces stay dim, and green/yellow/red keep meaning done/careful/failed. The colour is claimed at full precision only where the terminal has said it can show one (`COLORTERM=truecolor` or `24bit`); on a `*-256color` `TERM` it falls back to xterm colour 110, and on anything else to plain cyan — a 24-bit escape sent to a terminal that cannot parse one puts its own digits on your screen. `NO_COLOR=1` and any non-terminal stream turn all of it off, chrome included: no rules, no bars, no escapes at all.

The dashboard is a terminal's opening only: piping or redirecting `kapel` keeps the plain three-line banner, with no box drawing and no control characters. (`/stats` typed into a piped session still draws the box — you asked for it.)

**A clean screen, and your terminal back afterwards.** On a terminal, `kapel` opens on a screen of its own — it switches to the alternate screen buffer, the same one `vim` and `less` use, so the session starts blank instead of under whatever your shell had printed, and the dashboard above is the top of it. Leaving puts the terminal back exactly as it was, with your previous history intact: `/exit`, Ctrl-D, Ctrl-C twice, a crash, or a `kill` all restore it before anything else is printed. The honest caveat is the other half of that bargain — while the session is running, lines that scroll off the top are gone, because most terminals keep no scrollback for the alternate buffer — so `kapel --no-altscreen` (the flag works either side of `chat`) opts out and behaves exactly as v0.10.1 did, with the whole transcript left in your terminal's own scrollback. Piped and redirected runs never switch buffers at all, and neither does `TERM=dumb`.

Read-only tools (`read_file`, `glob`, `grep`, `git_diff`) run without asking; anything that writes or shells out asks first, and Ctrl-C at a question answers "no". The question is what will happen, not a truncated blob of JSON: `bash` shows the command it will run, `edit_file` a `-`/`+` diff of the replacement, `write_file` the head of the new file. Answers are `y` (allow this once), `n`/Enter/Ctrl-C (deny), or `a` — allow it and stop asking for the rest of the session: for `bash` that remembers the *command prefix* (answering `a` to `npm test --run foo` stops asking for `npm test …`, while `npm publish` still asks; a command with a shell operator such as `&&` or `|` is never remembered), and for every other tool it remembers the tool name. Nothing is written to disk — a new `kapel` starts asking again — and an explicit deny rule is never overridden by it. (Under `--backend codex` or `--backend claude-code` the external CLI runs the tools and enforces its own approvals, so kapel does not prompt at all — the banner says so.) Ctrl-C during a turn cancels that turn without ending the conversation; at the prompt it abandons the line you were typing — the band closes over it and reopens empty, and it is gone from the buffer, so the next thing you type is the whole of the next message — and twice in a row exits (so does `/exit` and Ctrl-D).

The agent's reply appears as it is generated, a token at a time, rather than landing whole when the turn finishes. While it is thinking, or a tool is running, the band at the foot of the screen shows a spinner in place of your cursor, with how long the current wait has been and the conversation's token count so far. It is a terminal courtesy and nothing else: piping or redirecting `kapel` gets plain text with no spinner and no control characters in it.

The prompt is a real input editor, not a one-shot readline: end a line with `\` (or paste a multi-line block) to keep composing before you send it — a blank line or a line with no trailing `\` ends it. ↑/↓ recall earlier messages, persisted across sessions in `~/.kapel/history` (last 1000, machine-wide). Tab completes what is under the cursor: a `/` command name, the argument of a command that has a fixed vocabulary (`/model ` offers the built-in aliases), or an `@` file mention.

**The input band.** What you type sits in a band at the foot of the screen, bounded above and below by a thin soft-white rule, with the transcript flowing between the dashboard and it. There is no `kapel>` inside it: the rules say where the input is, more plainly than a word can, and the message you send is repeated into the transcript on a grey bar (`> your message`) rather than left as whatever the terminal happened to echo. So the line you are composing is never mixed up with the conversation it is about to join, and the conversation keeps a legible record of your half of it.

The band is *painted*, not printed. Every line of output goes through one gate — erase the band, write the line, paint the band again underneath — which is exactly the discipline the spinner has always used, three rows tall instead of one. Nothing addresses a row on the screen, so the whole thing works the same on the alternate screen and under `--no-altscreen`, and once the transcript is longer than the terminal the band is simply the bottom of it. While a turn is running the same band holds the spinner instead of your cursor. A pipe or a redirect gets none of it: no rules, no bar, and `kapel>` still in front of every prompt, byte for byte as before.

The lower rule is the hard part, and it is worth saying why. `readline` and the terminal appear to disagree about which row the caret is on whenever the typed text ends exactly at the right-hand edge — an ordinary message crosses that boundary every terminal-width characters — and drawing under the caret at that one column used to land the whole block, and the line being typed with it, a row out of place. They do not actually disagree: the terminal is holding a *deferred* wrap, and Node resolves it by writing one extra space. The catch is that Node skips that on the faster code path it takes while completion is disabled, which is precisely what a paste does — so the band writes the space itself, on the same reasoning, before it moves. Every row it counts comes from `readline`'s own display model rather than from arithmetic of our own, so the editor and the frame around it can never be counting by two different rules.

**`/` opens the command list.** Typing a slash as the first character of a message draws this session's commands under the band — one per row, each with the same sentence `/help` prints beside it, built-ins first and then whatever `.agent/commands/` contributed. It narrows live as you keep typing: `/re` leaves `/resume` and `/resume-run`, and the part you have already typed stays lit in the prompt's own colour inside every candidate so you can see how much of each name you have pinned down. Eight rows at a time, with `… and N more` counting the rest. It closes itself the moment the name is finished (a space starts the arguments), the line stops beginning with a slash, or nothing matches at all. The list only ever *shows*: Tab still completes exactly as it did, and Enter sends precisely the characters in your buffer even when one command is all that is left on screen — a menu that quietly retyped your line for you would be a worse thing to have than no menu. Like the spinner, it is a terminal courtesy and nothing else: a piped or redirected `kapel` draws no menu and writes no escape for one.

**`@` mentions a file.** Type `@` and part of a path, then Tab: the match is fuzzy over the whole path, so `@clisrc` finds `apps/cli/src/…` and `@input.ts` finds it wherever it lives. A unique winner is filled in; several share whatever prefix they have in common, and pressing Tab again lists them. The candidates are the workspace's files as `git ls-files --cached --others --exclude-standard` reports them — tracked files plus untracked ones your `.gitignore` does not exclude — cached for a few seconds so holding Tab down does not spawn a process per keystroke. Outside a git repo the list comes from a bounded walk instead (four levels deep, `node_modules`/`.git`/`dist` skipped).

The mention stays plain text in your message. When the message is sent, every `@` token that names a real file inside the workspace is collected into one extra line:

```text
> why is @apps/cli/src/input.ts holding stdin the whole time?

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
| `/login` | check every configured backend's login status, and help fix whichever isn't logged in |
| `/usage` | tokens and cost so far, in this process |
| `/stats` | redraw the startup dashboard with fresh numbers and re-probed logins |
| `/compact` | compact the conversation history now (native backend only) |
| `/undo` | put the files back the way they were before the last prompt |
| `/policy` | edit this project's orchestration policy — routing, review, escalation, concurrency — and write it back; no model is called; see [Policy](#policy) |
| `/plan "<objective>"` | plan an objective into a task graph and show it, with the routing rationale — nothing is executed; see [Orchestrate](#orchestrate) |
| `/orchestrate "<objective>"` | plan it *and* run it across routed workers; see [Orchestrate](#orchestrate) |
| `/runs` | list this workspace's recorded orchestration runs, newest first |
| `/resume-run <runId>` | finish the tasks a recorded run never completed (the id comes from `/runs`) |
| `/<name>` (custom) | run a command from `.agent/commands/<name>.md`; see below |

`/resume` and `/resume-run` are deliberately different commands: one switches
this REPL onto a stored *conversation*, the other re-executes an unfinished
orchestration *run*. Two kinds of id, two names — a single command that guessed
which you meant would be wrong at the worst possible moment.

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

`kapel chat` is the explicit spelling of bare `kapel`: use it when you want those flags. The globals (`--cwd`, `-m/--model`, `--backend`, `--timeout`, `--no-setup`, `--no-altscreen`) work the same either way.

Images attach through `@` mentions on every backend: `@screenshot.png` in a
message attaches the image to that turn — up to 4 images of 5 MiB each
(png/jpg/jpeg/gif/webp). How it travels depends on who answers: the native
backend sends the image itself, Codex receives the path through its own
image input, and Claude Code is told to open the path with its Read tool.
Anything over a limit, or unreadable, is reported in the REPL and sent as a
plain path mention instead, and the turn always goes.

### Commands on the shell

Everything outside the REPL is setup and inspection:

```bash
kapel                    # open the REPL — this is where the work happens
kapel chat               # the same thing, spelled out (--continue, --session, --no-save)
kapel init               # copy the default .agent/ configuration into this repo (the REPL offers this itself on a new project)
kapel config             # re-run setup (--show prints it, --path prints the file path, --project scopes it to this directory)
kapel models             # model aliases and their credential status
kapel runs               # orchestration runs recorded here (--limit, --json)
kapel sessions           # chat sessions recorded here (--limit, --json)
kapel sessions fork <id|name> [--name <name>]
kapel explain <taskId>   # how one task of a run was routed and what happened (--run, --json)
kapel policy edit | compile | check | explain | diff
kapel help [command]     # same as --help
```

Global flags, on every command:

- `--cwd <dir>` — the workspace to operate in (default: the current directory)
- `-m, --model <alias>` — override the planner/orchestrator model (default: `AGENT_MODEL`, then your stored config, then `claude-sonnet-5`)
- `--backend <native|codex|claude-code>` — override the execution backend; see [First-run setup](#first-run-setup) for what happens when nothing overrides it
- `--timeout <seconds>` — model call timeout
- `--no-setup` — never set anything up automatically: no first-run wizard, and no automatic project setup either; use environment variables and defaults instead
- `--no-altscreen` — keep the REPL on the terminal's normal screen instead of a clean one, so the transcript stays in your scrollback (see [The REPL](#the-repl))

`--json` is not global. It lives on the commands that actually emit machine-readable output — `runs`, `sessions`, `sessions fork`, `explain`, and each `policy` subcommand except `policy edit`, which is an interactive editor with nothing to serialize — and nowhere else.

A command that no longer exists gets the same terse answer as a typo:

```text
$ kapel plan "add a health endpoint"
error: unknown command 'plan'
```

### First-run setup

`kapel` needs to know two things before it can do anything: how to talk to a
model, and which models to use. On a terminal it asks once, on the first run of
any command that needs an answer, and stores what you say in
`~/.kapel/config.json` (`$KAPEL_CONFIG_DIR` overrides the directory).

The first question is a **multi-select**: tick every backend you actually have,
not just one.

```text
Which coding backends should kapel use? (space to toggle, enter to confirm)
❯ ☑ Claude Code (use your Claude Code subscription login — no API key)
    ☑ Codex (use your ChatGPT login via the OpenAI Codex CLI — no API key)
    ☐ API key (Anthropic/OpenAI) (call model APIs directly with a key or token)
  ↑↓ move · space toggle · enter confirm (at least one) · esc cancel
```

…followed by the orchestrator model and the three worker models — the complex
tier (the hardest coding work), the routine, non-trivial tier, and the
small-task tier (single-function changes and exploration). With one backend
ticked those four lists are that backend's models, exactly as before. With
several, each list is the **union** of every ticked backend's models, each
line naming who runs it, so a role can be put on any of them:

```text
Worker model — routine, non-trivial tasks
    ◯ opus     (Claude Code · Claude Opus — highest capability)
❯ ◉ sonnet   (Claude Code · Claude Sonnet — balanced · suggested for this role)
    ◯ default  (Codex · let the Codex CLI choose)
    ◯ gpt-5.1  (Codex · errors at run time if your plan lacks it)
```

A Claude Code orchestrator with a Codex middle tier is a normal answer. The
pre-selected suggestion for each role comes from Claude Code's tiers when it is
ticked (they are the only defaults that actually differ per tier), otherwise
Codex's, otherwise the API-key list's. Every ticked backend is probed as you
go, so a missing or logged-out CLI is reported there and then rather than on
your first objective — and when the CLI itself is installed but nobody has
signed in, the wizard offers to fix it on the spot: for Codex it asks whether
to run `codex login` right there, and for Claude Code whether to run `claude
auth login` right there (suspending the wizard, handing you the terminal,
then re-checking once it exits). Either way, setup keeps going — nothing here
blocks on being fixed. Run `/login` inside the REPL any time afterward to
re-check every backend the effective config allows and get the same offer
again for whichever one still needs it.

```bash
kapel config              # re-run the wizard at any time
kapel config --show       # the effective configuration, and which file each value came from
kapel config --path       # just the path
kapel config --project    # same wizard, saved to this directory's .agent/config.local.json
kapel config --path --project   # …and where that file is
kapel --no-setup "…"      # never ask; use environment variables and defaults
```

**Per-project overrides.** `~/.kapel/config.json` says what your *machine* is
logged into; `<repo>/.agent/config.local.json` says what *this directory*
should use instead. It is a partial — override the backend list, or one role,
or everything — and the machine config fills every gap:

```jsonc
// .agent/config.local.json — this repo runs its routine, non-trivial tier on Codex
{
  "backends": ["claude-code", "codex"],
  "models": { "middle": { "backend": "codex", "model": "gpt-5.1" } }
}
```

`kapel config --project` writes it for you (it needs a `kapel init`-ed
directory — it will not create `.agent/` itself), `kapel init` adds it to
`.gitignore` next to `sessions.db`, and a malformed file warns once on stderr
and is ignored rather than failing the command. `kapel config --show` prints
the merged result with the file each value came from.

Inside the interactive agent, `/config` runs the same wizard against the
machine file and applies the answers — still with this directory's override on
top — to the conversation you are already in: the thread is kept, only the
turns that follow change backend or model.

**Everything resolves in one order**, wherever a backend or a model is chosen
(the REPL, `/plan`, `/orchestrate`, `policy compile`):

```text
explicit CLI flag  >  environment variable  >  .agent/config.local.json  >  ~/.kapel/config.json  >  detected  >  built-in default
     --backend            AGENT_BACKEND              backends / models                  backends / models                     native
     -m/--model           AGENT_MODEL                models.<role>.model                models.<role>.model                   claude-sonnet-5
```

**Mixed execution is per task.** `kapel init` seeds each `.agent/config.yaml`
alias with its own role's provider *and* its own role's `backend:`, and
`/orchestrate` runs every task through the backend its agent's alias names. A
single run can therefore drive Claude Code workers, Codex workers and native
(API) workers side by side, each in its own task worktree, each billed and
reported under its own model. Only the backends a run can actually reach are
probed, so a configuration that never mentions Codex never asks for `codex
login`. An alias with no `backend:` — which is every config.yaml written before
this — runs on the run's own backend, exactly as it always did.

The orchestrator's own work is the exception, and deliberately so: a chat turn,
a plan and a policy compile all run on the **orchestrator role's** backend,
which is also what an untagged alias falls back to.

**Backend auto-detection** fills the gap in the last step but one. If nothing
has chosen a backend — no `--backend`, no `AGENT_BACKEND`, no stored config
(a `--no-setup` run, a piped one, a machine whose config was never written) —
kapel looks for one that actually works instead of assuming `native` and
failing on a missing credential: a logged-in Claude Code CLI first, then a
logged-in Codex CLI, then a provider credential in the environment. Whatever it
finds is announced in one line on stderr and used for that process:

```text
backend: claude-code (auto-detected — set one with `kapel config`)
```

The probe runs at most once per process, and never at all when anything above
it in the order has an answer. With nothing usable found, `native` stands, in
silence — at that point the thing worth hearing about is the missing
credential, not the detection.

`.agent/config.yaml` is a third, committed file, and a different question
again: it says which model each *agent* of an orchestration run uses. `kapel
init` seeds it from your effective configuration when you have one (`lead` and
`reviewer` from the orchestrator model, `complex`, `worker` and `cheap` from
the three worker models), giving each alias the provider of *its own* role's
backend — so a Claude Code lead and a Codex worker seed `anthropic` and
`openai` respectively — and copies the template unchanged when you don't.

### Permissions

`write_file`/`edit_file`/`bash` ask at the prompt (`[y/n/a, or say what to do
instead]` — "a" remembers the answer for the rest of that session only, never
written anywhere). Answering with a sentence rather than a letter — "왜 이
파일을 지우려는 거야?", "use the config file instead" — declines the call *and*
sends what you typed to the agent, so it answers you and proposes something
else without your having to start the turn over. There is no flag to turn the
asking off: the REPL is the one place a human is definitely present. A
`permission` block, hand-edited into either config file, changes what asks and
what doesn't — opencode's syntax, unchanged:

```jsonc
// ~/.kapel/config.json
{
  "version": 3, "backends": ["…"], "models": { "…": { "backend": "…", "model": "…" } },
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

A rule key ending in `*` matches tool names by prefix — `"mcp__github__*"` —
which is how you write a rule for tools kapel does not name itself. The most
specific key wins: an exact tool name beats `"mcp__github__*"`, which beats
`"mcp__*"`, which beats `"*"`.

### MCP servers

kapel's own agent loop speaks [MCP](https://modelcontextprotocol.io) over
stdio. Declare servers under `mcp:` in `.agent/config.yaml` — the shape Claude
Code and opencode already taught you:

```yaml
# .agent/config.yaml — committed, shared with everyone on the repo
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
  docs:
    command: ./scripts/docs-mcp
    enabled: false        # configured, not started
```

```jsonc
// .agent/config.local.json — this checkout only, gitignored
{ "mcp": { "github": { "env": { "GITHUB_TOKEN": "…" } } } }
```

Two layers, the same two everything else uses: the committed block, then this
checkout's override on top of it — field by field, so a local file adds a
token to `env` (merged key by key) or turns a server off with a bare
`{"enabled": false}` without restating the command. Secrets belong in the
local file; it is the one `kapel init` gitignores.

Each server's tools reach the model as `mcp__<server>__<tool>`, with the
server's own JSON Schema passed through untouched. Text results come back as
text; an image, an audio blob or a binary resource comes back as a line saying
what it was and how big — a tool result is a string, and base64 in the
transcript would spend your context on bytes the model cannot read.

**They ask before they run.** An MCP tool is classified with `bash` and
`write_file`, not with `read_file`: what it does is somebody else's server's
business, and kapel cannot tell a search from a deploy from the outside. Widen
it per server or per tool in either config file — `"mcp__github__*": "allow"`.

Servers start with the first turn that could use them and are stopped when the
session ends — stdin closed first, then the process group signalled. A server
that will not start costs you its own tools and a line saying why; a server
that crashes mid-call costs one failed tool call, which the model reads and
works around. Nothing about MCP can end a turn.

Two limits worth knowing. Stdio only — no HTTP/SSE servers yet. And this is
kapel's *native* loop: a run on `--backend codex` or `--backend claude-code`
delegates to that CLI's own agent loop, which reads that CLI's own MCP
configuration, so this block is neither forwarded to them nor honoured by
them. Orchestration workers do not get these tools either.

### Project instructions (AGENTS.md)

Drop an `AGENTS.md` in your repo and kapel follows it from the first turn — the same file Codex and opencode already read, and that Claude Code picks up via `@AGENTS.md` imports, so a repository only has to write its rules once. Up to three are merged into the system prompt, machine-level first so a project's rules add to (never silently lose to) your personal ones:

1. `~/.kapel/AGENTS.md` (`$KAPEL_CONFIG_DIR` overrides the directory) — your own rules, for every project.
2. `AGENTS.md` at the repo root — project rules, shared with other agents.
3. `.agent/AGENTS.md` — kapel-specific overrides.

All that exist are concatenated in that order; a missing file is simply skipped. The REPL's banner names whichever were loaded (`instructions: AGENTS.md, .agent/AGENTS.md`). The combined text is capped at 32 KiB. Delegated backends (`--backend codex`, `--backend claude-code`) run the external CLI's own agent loop, which does not take a system prompt from kapel — those AGENTS.md files are not injected there, though the CLIs themselves may already read AGENTS.md-style files on their own.

### Handoff guidance (.agent/handoff.md)

Every time kapel hands work between agents — the orchestrator briefing a worker, a worker's results reaching a dependent task, a reviewer being asked for a verdict — it includes a little standing guidance of its own. `.agent/handoff.md` is where you rewrite it. `kapel init` ships the file with kapel's built-in text in it, and it has three `## `-headed sections:

- `## common` — appended to every worker agent's system prompt, after that agent's own `.agent/agents/<name>.md` body. (Delegated backends run the external CLI's own loop and take no system prompt from kapel, so this one reaches kapel's own agent loop only.)
- `## worker` — the standing guidance in a task briefing: how to work, not what the task is. The per-task facts above it (title, goal, affected areas, risk, dependencies, dependency results) are planner output, not guidance, and are never replaceable.
- `## reviewer` — what a review task is being asked to look for.

Replacement is wholesale, per section: a section present in the file replaces kapel's built-in text for it entirely (nothing is merged or appended), a section you delete falls back to the built-in default, and a section you leave empty is a deliberate blank — kapel says nothing there. No file at all means the built-in guidance, exactly as before. Text above the first heading is a comment; an unrecognised `## ` heading outside a section is reported as a note and ignored, while headings *inside* a section are just part of the guidance.

One part is not yours to replace: the review verdict contract. Whatever `## reviewer` says, kapel appends the mechanics of stating the decision after it — the `submit_review_verdict` tool call on its own agent loop, or the exact JSON reply object (schema included) on `--backend codex` / `--backend claude-code`. A review whose answer the runtime cannot parse fails whatever the prose asked for, so those lines stay.

### Claude Code backend

Want Claude models without an `ANTHROPIC_API_KEY`? Pass `--backend claude-code`
(or set `AGENT_BACKEND=claude-code`, or pick it in the wizard) to delegate the
work to Anthropic's own Claude Code CLI, under your existing subscription
login:

```bash
npm install -g @anthropic-ai/claude-code
claude                            # once, to log in with your Claude subscription
kapel --backend claude-code       # …and open the REPL on it
```

Pick it once in `kapel config` and the flag stops being necessary; with neither, kapel detects a logged-in `claude` on its own (see [First-run setup](#first-run-setup)).

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

**Orchestration runs on it too.** `/orchestrate` under this backend
spawns one `claude -p` per task, in that task's own workspace (its worktree —
isolation is always on), on the model the routed agent
declares in `.agent/agents/*.md`. Unlike Codex, Claude Code can be scoped per
run, so each agent's `tools:` list is translated into `--allowedTools` —
a reviewer really does run without `Write` and `Edit`. Approvals stay Claude
Code's own (`acceptEdits`), and the project's `validation:` commands gate
mutating tasks here just as they do on the native loop.

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
codex login                 # ChatGPT OAuth — no API key
kapel --backend codex       # …and open the REPL on it
```

`kapel` never handles OpenAI credentials itself on this path — it just spawns `codex exec --json` in the workspace and lets Codex authenticate and run its own agent loop. `-m/--model` is forwarded to Codex only when you pass it explicitly; otherwise Codex picks its own default. Codex runs under its `workspace-write` sandbox with `--full-auto`, so it doesn't stall on approval prompts; kapel's own permission prompts don't apply here — Codex enforces its own approvals via the sandbox. As with Claude Code, picking it in `kapel config` makes the flag unnecessary, and a logged-in `codex` is detected when nothing else has chosen.

### Policy

`.agent/orchestration.md` is your routing/concurrency/review/retry/escalation policy. The CLI compiles it to a typed, deterministic IR that the scheduler enforces.

**It is written in one of two forms, and only one of them costs a model call.**

The IR is small and closed — four settings and three rule lists — so kapel can
both write that file and read it back, with no model involved. A policy in
that *canonical* form opens with a marker line:

```markdown
<!-- kapel:policy v1 -->

## Orchestrator

Use `lead` as the main orchestrator.

## Execution

- Run at most 4 agents at a time.
- Independent tasks may run in parallel.
- Give each task 2 attempts before giving up.

## Routing

- `architectural-work`: always route tasks of complex and architectural complexity to `senior`.
- `exploration`: always route `exploration` tasks to `explorer`.

## Review

- `sensitive-change-review`: `reviewer` reviews tasks touching `auth`, `payments` and `migrations`; blocking, required.

## Escalation

- `junior-to-coder`: hand off from `junior` to `coder` after 2 failed attempts.
```

This is what `kapel init` ships, so a new project compiles for free. Editing it
by hand is fine — it is a text file — but `kapel policy edit` (and `/policy` in
the REPL) is the way that cannot slip out of the form.

**Anything else is prose, and prose is what the model is for.** Delete the
marker and write three paragraphs of English; kapel compiles them with an LLM,
exactly as it always did. That is a choice you make by writing prose, not a
tax on every project.

Two rules keep the deterministic path trustworthy. Without the marker nothing
is parsed, so hand-written English is never guessed at. And with it, **one**
line that no longer fits fails the whole parse — kapel says which line, then
compiles the file with a model rather than quietly reading a policy that means
less than it says.

- `kapel policy edit` — the editor: pick a setting or a rule, change it, save. It rewrites `orchestration.md` in canonical form **and** the lock beside it, so nothing is left to compile — `/plan` works the moment you exit. No model is called and no credential is needed, so this works on a machine with no backend configured at all. Editing a policy that is currently prose starts from what it last compiled to and says, on the save line, that saving replaces the prose; a prose policy that has never been compiled (or whose lock has gone stale against it) is refused rather than half-read, with the one command to run first.
- `kapel policy compile` — rarely needed by hand: a new project compiles itself, `policy edit` writes the lock as it saves, and an edited canonical policy is re-read at the next startup. What it does when you do run it: reads a canonical `orchestration.md` outright (no model, no credential), and otherwise uses an LLM (same backend/model resolution as a run; `-m/--model` selects the model, `--backend` decides whether it goes through an API key or your Codex/Claude Code login) to compile it into `.agent/orchestration.lock.json`, reporting any warnings (judgement calls) or ambiguities (source phrases it couldn't map). Each warning/ambiguity that quotes a source phrase is annotated with the `orchestration.md:12` line (or `:12-13` when the phrase wraps lines) it was found at — best-effort: a phrase the compiler paraphrased instead of quoting carries no location, never a wrong one. `--json` adds parallel `warningLocations`/`ambiguityLocations` arrays (`null` where unresolved), and a `source` of `canonical` or `model` saying which path ran. The text output opens with the same fact and, on the model path only, prints what the compile spent; on a delegated backend that is whatever the CLI reported, and "none reported" when it reported nothing rather than a misleading `0`. A file that carries the marker but no longer parses is reported on stderr with its line number — it is about to cost a call it was written to avoid.
- `kapel policy check` — a fast, offline gate: confirms the lock still matches `orchestration.md` and the current agents, without calling an LLM. Good for CI.
- `kapel policy explain` — prints a human-readable summary of the locked policy from the lock file, also without calling an LLM. Same line-annotated warnings/ambiguities as `compile`.
- `kapel policy diff` — recompiles `orchestration.md` exactly the way `compile` does — free for a canonical policy, one LLM call for prose — and diffs the result against the current lock **without writing it**, so you can review a change before committing to it: routing/review/escalation rules added, removed, or changed field-by-field (matched by each rule's own `id`, not its position — reordering a policy's rules between compiles is not a change), plus any changed defaults (`orchestrator`, `maxConcurrency`, `parallelizeIndependentTasks`, `defaultMaxAttempts`). `--json` emits `{ok, unchanged, defaults, routing, review, escalation, warnings, ambiguities, source}`. "Same resolution as `compile`" includes the backend: under `--backend codex`/`--backend claude-code` the recompile is delegated to that CLI, so `diff` needs no API key either.

All five accept `--cwd`; each takes its own `--json` except `edit`, which has no machine-readable output to ask for.

### Orchestrate

A message at the prompt runs one model in one loop. `/orchestrate` runs the full M3 pipeline instead: the objective is **planned** into a task DAG, the plan is **rewritten by your compiled policy** (unknown agents dropped, mandated reviews injected, unrunnable plans rejected), and the resulting tasks are **routed to different workers and executed in parallel** by the deterministic scheduler.

The policy has to be compiled before either of them runs. On a new project
kapel does that for you, for free (see [Quickstart](#quickstart)); after an
`orchestration.md` edit, it is one command:

```bash
kapel policy edit        # change it and relock it in one step — no model call
kapel policy compile     # or, after editing orchestration.md in a text editor
```

```text
kapel> /plan add a health endpoint          ← preview the task graph — no work is done
kapel> /orchestrate add a health endpoint   ← plan, then execute it
kapel> /runs                                ← what has been run here
kapel> /resume-run 0f3c9a2b                 ← finish a run that stopped part-way
```

Both `/plan` and `/orchestrate` require a fresh `.agent/orchestration.lock.json` and refuse to guess. In a project that has never been set up — or never compiled — they just do it, right there at the prompt (the same automatic setup startup runs, for a session that started non-interactively or hasn't reached that point yet); where nothing can run — `--no-setup`, a piped session, or a setup that already failed this session — a missing or stale lock is the error it has always been, telling you to run `kapel policy compile`. Either way it is reported in the REPL and the conversation carries on. The planner itself runs on the model your policy's orchestrator agent is configured with (`-m/--model` overrides it; if that agent or its credential is unavailable, kapel falls back to the normal default model and says so).

Under `--backend codex` or `--backend claude-code` the planning conversation is delegated to that CLI too, so **planning needs no API key either** — it runs as one read-only `codex exec --sandbox read-only` / `claude -p --permission-mode plan` call in your workspace, on the orchestrator agent's configured model (or whatever `-m/--model` names, verbatim), and the plan it replies with is validated against the same schema and the same rules as on the native path.

`kapel policy compile` is delegated the same way on those backends — the same single read-only call, the same IR schema, the same warnings and ambiguities in the lock — on whatever model your `orchestrator` setting names (`-m/--model` > `AGENT_MODEL` > `.agent/config.local.json` > `~/.kapel/config.json`), or the CLI's own default when nothing names one, in which case the lock records it as `<codex default>`/`<claude-code default>`. `kapel policy diff` recompiles through the same delegated path. **So the whole pipeline — compile, diff, plan, orchestrate — runs on a Codex or Claude Code subscription with no API key anywhere.**

`/plan` prints one row per task — id, type, complexity, the agent the router would pick, dependencies, title — plus any reviews the policy injected and any notes from the rewrite.

It then prints the **routing rationale** for every task, always: the same `PolicyRouter.decide` the scheduler itself runs at execution time, saying which rule matched (its match criteria, strength and weight) or, with no matching rule, whether it fell back to the task's `suggestedAgent` or the policy's orchestrator — plus the model alias the picked agent is configured with. This used to be a `--why` flag you had to remember; at a prompt the table and the reason behind it are one thought.

During a run, task lifecycle lines are interleaved with the workers' own output:

```text
▶ T01 → explorer (attempt 1)
⎇ T02 worktree created (agent-task/8f3a.../T02)
▶ T02 → coder (attempt 1)
✔ T02 — Added the /healthz route.
⇡ T02 merged → 4b1c9de0
↑ T03 rerouted coder → senior
⊘ T04 (dependency-failed)
```

The run ends with a per-task status table, a **per-agent summary** — one row per participant that actually did something, orchestrator first, with its role, the backend/model it ran on, how many tasks it finished (or failed), a digest of what those were, and its tokens — and token/cost totals; it exits `0` only if every task completed. `--json` reports the same per-agent breakdown as an `agents` array on the `run.summary` line.

How a run executes is decided by your configuration, not by flags:

- **Workers run in this process**, through the native agent loop, on the model each agent declares in `.agent/agents/*.md` (resolved via the `models:` aliases in `.agent/config.yaml`). **Independent tasks fan out to different configured workers**: with a policy that routes `exploration` to your explorer agent and `implementation` to your coder agent, those two tasks run concurrently on two different models.
- **Under a delegated backend, every task goes to that CLI instead.** `codex` (see [Codex backend](#codex-backend)) or `claude-code` (see [Claude Code backend](#claude-code-backend)): one `claude -p` per task in that task's workspace, on the agent's configured model, with the agent's `tools:` list passed through as `--allowedTools`. Claude Code enforces its own approvals (`acceptEdits`), and validators still run.
- **Worktree isolation is on**, always — see [Worktree isolation](#worktree-isolation) below.
- **The project's validators gate every mutating task**; see [Validation and review](#validation-and-review).
- **The run is recorded** in `.agent/sessions.db` unless the REPL was opened with `kapel chat --no-save`; see [Sessions](#sessions).
- `--timeout <seconds>` applies **per task**, not to the run as a whole.

#### Worktree isolation

Parallel workers editing one checkout would see each other's half-finished edits, so by default **every mutating task gets its own git worktree**: a private checkout of the current `HEAD` on an `agent-task/<runId>/<taskId>` branch, under `.agent/worktrees/`. The worker only ever sees that directory. When the task succeeds, its changes are committed on the task branch and merged back into your checked-out branch — merges are serialized, so concurrent tasks land one after another rather than racing. The checkout and the branch are then deleted, and the task's reported `changedFiles`/`commit` describe what actually landed.

This applies to the native loop and to `--backend codex` alike; isolation is about how tasks share the repository, not about what runs them.

- **Read-only tasks run in place.** `exploration` and `review` tasks never write, so they run directly in your workspace with no checkout and no branch.
- **Conflicts are reported, not resolved.** If a task's branch cannot be merged (two tasks touched the same lines, or the base checkout was dirty), the task comes back `partial` with the conflicting files and the branch name in its unresolved issues, and **the branch is preserved** so you can merge or inspect it by hand. Your working tree is left clean — no merge in progress, no conflict markers.
- **Failed tasks keep their evidence.** A task that fails after making edits still has them committed on its branch, which is kept for inspection; nothing is merged.

Worktree isolation needs the workspace to be a git repository with at least one commit; if it isn't, `/orchestrate` says so before spending a model call on a plan. Should a run be killed mid-flight, leftover checkouts and `agent-task/*` branches can be cleaned up with `git worktree prune` plus `git branch -D`.

#### Validation and review

`.agent/config.yaml` can gate every mutating task on a `validation:` list:

```yaml
validation:
  - name: typecheck
    command: npm run typecheck
  - name: test
    command: npm test        # timeoutSeconds: 300  (optional, default 600)
```

Each command runs via `bash -lc` **inside the task's own worktree, before it is merged back**; a failing command fails the task (and cancels its dependents) instead of merging broken work, and its output streams as `validation.started`/`validation.completed` events. Failed and low-confidence results are retried per the policy's `escalation`/`defaultMaxAttempts` rules, rerouting to another agent when configured. Validators are skipped under `--backend codex`, since Codex reports one result per task with no hook to run a separate suite against. Separately, a policy's `review:` rules inject **blocking** review tasks for matching risk categories — a rejected verdict fails the task (and the run) the same way a failed validator does.

#### Sessions

Every `/orchestrate` run records itself in a SQLite database at **`.agent/sessions.db`**: the objective, the policy snapshot it executed under, the post-rewrite plan, every event it emitted, and a rolling per-task summary. The run id is printed as the run starts (`Run 0f3c… — 3 tasks, up to 4 at a time`) — that is what the commands below take.

```text
kapel> /runs                   ← what has been run here, newest first
kapel> /resume-run 0f3c…       ← finish the tasks that never succeeded
```

```bash
kapel runs                     # the same listing, from the shell (--limit, --json)
kapel explain T03              # why T03 ran where it ran, and what happened to it
kapel explain T03 --run 0f3c…  # …in a specific run (default: the most recent)
```

- **`/runs`** and **`kapel runs`** list id, status, start time, task counts and objective for the last `--limit` runs (default 20). `--json` (shell only) emits the same as an array. A workspace with no database yet just says so.
- **`kapel explain <taskId>`** reads one task's history back: the agent it ended on and how many attempts it took, the routing decision re-derived by running the router over the run's own policy snapshot (naming the rule that matched, or the `suggestedAgent`/orchestrator fallback when none did), and a chronological digest of the decisions made about it — held behind a conflicting task, started, escalated, low confidence, failed validators, merged or conflicted worktree, completed, cancelled. `--json` gives `{task, agent, attempts, events, route}`.
- **`/resume-run <runId>`** rebuilds the run's task graph, marks everything that already succeeded as done, and re-executes the rest into the *same* run — events keep accruing and the final status is updated in place. It runs under the **policy snapshot recorded with the run**, not the current lock: the remaining tasks were planned and routed under the original constraints, and swapping the rules half way through would produce a run that never existed under any one policy. If the project's lock has moved on since, it says so and carries on; to plan under the new policy, start a fresh `/orchestrate`. Isolation, validators and the backend are whatever `/orchestrate` itself would use.

Token usage lives there too, in a `usage_events` table: one append-only row per chat turn and per finished orchestration run, holding what was spent, by which backend, when. It is what makes the REPL's dashboard and `/stats` able to answer "how much today" after the process that spent it is gone — `/usage` only ever knows about the turns of the process it is running in. Rows are never written for a turn the backend reported nothing for, and a row carries a price only when something actually priced it, so a subscription-billed backend shows tokens with no dollar figure rather than `$0.00`.

Conversations live in the same database, in their own tables — `/sessions` and `kapel chat --continue` read those, `/runs` reads the orchestration runs above. See [The REPL](#the-repl). Outside the REPL, `kapel sessions` lists them the same way `kapel runs` lists orchestration runs, and `kapel sessions fork <id|name> [--name <name>]` copies one — its title, model and whole transcript so far — into a brand new session that then evolves independently of the one it was forked from:

```bash
kapel sessions                                # this workspace's chat sessions, newest-touched first
kapel sessions fork 0f3c…                     # copy a conversation into a new, unnamed session
kapel sessions fork 0f3c… --name "plan b"     # …and name the copy
```

`kapel sessions` shows a `NAME` column once any listed session has one; a session picks up a name by being forked with `--name`, or from `/name` at the prompt (see the command table above — it persists immediately, no need to wait for the next message). `kapel sessions fork` and `--session` everywhere they appear (`kapel chat --session`, `/resume`) resolve `<id|name>` in this order: an exact id, then a unique id prefix, then an exact name — if two sessions share a name the most recently touched one is used and a note is printed to stderr. `--json` on either `sessions` command emits the same fields as an array/object instead of a table/line.

`/fork [name]` at the prompt does the same copy `kapel sessions fork` does, but from inside the REPL and on the conversation you're already in: it branches everything said so far into a new session and switches you onto it immediately (the original stays put, unaffected, with its own history up to the fork point). Useful for "let me try a different approach without losing where I was" — `/fork before-refactor`, try the risky thing, `/resume` back to the original if it doesn't pan out.

`kapel chat --no-save` skips persistence entirely — for the conversation and for anything `/orchestrate` runs from it, so nothing is written and those runs cannot be listed, explained or resumed afterwards. Persistence is also skipped silently in a workspace with no `.agent` directory, and a store that cannot be written to never fails a run: recording a run is an observer of it, not a participant. If you'd rather not commit the database, add `.agent/sessions.db*` to your `.gitignore`.

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
- Ink/React for the terminal dashboard
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
