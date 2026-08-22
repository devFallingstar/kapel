# Real-environment smoke test guide

A procedure for verifying the full v0.1 feature set against real models on a
local machine. Setup time aside, it takes about 15–20 minutes.

> **Requirements**: Node.js 20+, git. **Windows cmd, macOS, and Linux are all
> natively supported** (shell commands run under bash on POSIX and cmd.exe on
> Windows).

## 0. Installation (Windows cmd / macOS / Linux, common)

Install the package tarball already checked into the repository, globally,
with no build step (one line):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.15.0.tgz
kapel --version
```

Once published to the npm registry, this will be replaced by
`npm install -g @devfallingstar/kapel`. If URL access isn't available on your
network: clone the repo, then run
`npm install -g ./kapel/release/devfallingstar-kapel-0.15.0.tgz`. To
uninstall: `npm uninstall -g @devfallingstar/kapel`.

> Don't use the `npm install -g github:...` form — a bug in how npm handles
> workspace git dependencies breaks the install (symptom: an empty command).
> If you previously installed that way, run
> `npm uninstall -g orchestration-agent kapel` and reinstall using the method
> above.

kapel is **REPL-only** — all agent work happens inside the prompt that
`kapel` opens, and the shell's commands (`init`/`config`/`models`/`runs`/
`sessions`/`explain`/`policy`) only configure and inspect. The former
one-shot execution forms (`kapel "<objective>"`,
`kapel exec/plan/orchestrate/resume/worker`) and their dedicated flags
(`-i`, `-y`, `--system`, `--max-iterations`, the global `--json`,
`--sandbox`, `--worker-mode`) have all been removed.

For contributors (building from source): from a clone, run
`npm install && npm run build`, then use `node apps/cli/dist/index.js ...`
or `npm install -g .`.
Quick self-check: `npm test` → 2069 tests should pass.

### Windows notes

The `bash` tool and validators run commands under cmd.exe on Windows —
`&&`/`||` work, but POSIX syntax like `export`, backticks, or `$(...)` cannot
be used (the agent is also told this via the tool description). If Git Bash
or WSL is available, the same behavior applies there.

## 1. Authentication setup (at least one)

| Path | Method | Verify |
|---|---|---|
| Anthropic API key | `export ANTHROPIC_API_KEY=...` | `kapel models` shows `api key` |
| Anthropic OAuth (no key) | install the [`ant` CLI](https://github.com/anthropics/anthropic-cli), then `ant auth login` | `kapel models` shows `oauth (ant)` |
| OpenAI (no key, Codex) | `npm i -g @openai/codex && codex login` (ChatGPT OAuth) | used in Scenario B |
| Anthropic (no key, Claude Code) | `npm i -g @anthropic-ai/claude-code`, then run `claude auth login` to log in with a subscription | used in Scenarios A-0/B2 |

Check the credential status of each model alias first with `kapel models`.

You don't need to have already logged in to Codex or Claude Code beforehand
— the wizard (1.5) or the REPL's `/login` command detects that they're
installed but not logged in, asks whether to run `codex login` /
`claude auth login` right now, hands you the terminal to finish logging in,
and then re-checks.

## 1.5. Scenario A-0 — first-run wizard (setup)

The first time you run `kapel` in a terminal on a machine that hasn't been
configured yet, it asks five questions about which backend and models to use,
then saves the answers to `~/.kapel/config.json`. To verify this from a clean
state, run it with a temporary config directory:

```bash
export KAPEL_CONFIG_DIR=/tmp/kapel-smoke      # so the real ~/.kapel is left alone
kapel config --show                           # "not configured yet — run `kapel config`" + path, exit code 0
kapel                                         # run with no objective → the wizard comes up first
```

**Expected behavior**: after a `kapel is not configured yet …` notice, five
arrow-key lists appear in turn. **The first question is multi-select**, so
you can pick several of the backends you have (`space` to toggle, `enter` to
confirm, at least one is required — pressing `enter` with nothing picked is
ignored).

```text
Which coding backends should kapel use? (space to toggle, enter to confirm)
                                             ← ☑ Claude Code / ☑ Codex / ☐ API key
Main orchestrator model                      ← e.g. opus
Worker model — most complex coding tasks     ← e.g. opus
Worker model — routine, non-trivial tasks    ← e.g. sonnet
Worker model — small, single-function tasks  ← e.g. haiku
```

If you picked only one backend, the four model lists are exactly as before —
that backend's list. If you picked two or more, each list becomes the
**union of every backend you picked**, and each line's hint is prefixed with
which backend it's from, like `Claude Code · ` / `Codex · `. So the
orchestrator could be Claude Code's `opus` while the worker for tasks that
are general but not trivial is Codex's `gpt-5.1` — mixed and matched (the
default selection is that tier's default for Claude Code if you picked it,
otherwise Codex, then the API-key list, in that order).

If a backend you picked isn't installed/logged in, you get a
`warning: … does not look ready` plus install/login instructions, and setup
continues anyway (it's only a warning, not a stop — if you picked several,
each is checked in the order you picked them).
Once you're done answering, a summary and `saved to …/config.json` are
printed, and then the command you originally meant to run (here, interactive
mode) runs as normal. Pressing `esc` cancels with just `setup cancelled` and
nothing is saved.

Things to check:

```bash
kapel config --show     # the merged effective config (which file each value came from) + both file paths
kapel config --path     # just the machine config path
kapel config            # re-run setup any time (current values show as the default selections)
kapel --no-setup        # skip the wizard, run off env vars/defaults
echo "" | kapel         # piped (non-TTY) — no wizard, just prints help
```

**Per-directory config (`--project`)** — when you want a different
backend/model just for this repository, `<repo>/.agent/config.local.json`
overrides the machine config. You can fill in only part of it (just the
backend list, just one role, or all of it), and the machine config fills in
the rest:

```bash
kapel init                       # .agent/ must already exist (--project doesn't create a directory)
kapel config --project           # same wizard → saved to .agent/config.local.json
kapel config --path --project    # just that file's path
kapel config --show              # the merged result + each value's source file
```

**Expected behavior**: in a directory with no `.agent/`,
`kapel config --project` asks no questions at all and prints
`… does not exist — run \`kapel init\` …` with exit code 1. `kapel init`
adds `.agent/config.local.json` to `.gitignore` alongside
`.agent/sessions.db*`·`.agent/worktrees/`. If the file is corrupt, a single
`warning: ignoring …` line goes to stderr and it's ignored while the command
still runs.

Precedence check: `--backend`/`-m` flag → `AGENT_BACKEND`/`AGENT_MODEL`
environment variables → `.agent/config.local.json` →
`~/.kapel/config.json` → **auto-detection** → built-in default, in that
order — whichever is found first wins. For example, even if config says
`claude-code`, `kapel --backend native` runs the native path.

**Mixed per-agent execution now works** — each task under `/orchestrate` runs
on the backend named by `backend:` in `.agent/config.yaml` for the alias
assigned to that task. That is, a single run can have Claude Code workers,
Codex workers, and native workers running side by side, each in its own
task worktree, with usage tallied separately under each backend's own model
names. Only the backends actually reachable are checked, so a config that
doesn't use Codex doesn't require `codex login`. An alias with no `backend:`
falls back to that run's default backend, as before. Chat turns, `/plan`, and
`policy compile` still run on the **orchestrator role's backend**, which is
also the default backend.

**Backend auto-detection** check — this only kicks in when nobody has chosen
a backend (no flag, no `AGENT_BACKEND`, no config file):

```bash
env -u AGENT_BACKEND KAPEL_CONFIG_DIR=/tmp/kapel-empty kapel --no-setup
```

**Expected behavior**: if a logged-in Claude Code CLI is present, a single
`backend: claude-code (auto-detected — set one with \`kapel config\`)` line
goes to stderr and the REPL opens on that backend. If Claude Code isn't
present, it tries Codex; failing that, native if
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY` is set. If none
of the three are present, it silently falls back to native as before (no
notice line — what needs to be reported at that point is missing
credentials, not detection). Detection runs once per process, and the
notice line is printed once too.

Once the wizard finishes (and immediately every time after), opening the
REPL in a repo with no `.agent/` goes straight into **automatic project
setup** (no question asked) — see section 2.

After finishing setup, running `kapel init` fills `.agent/config.yaml`'s
`models:` from the effective config (`lead`/`reviewer` ← the orchestrator
model, `complex`·`worker`·`cheap` ← the three worker models). Each alias's
`provider:` comes from whichever backend that role actually uses, so a
Claude Code lead + Codex worker configuration honestly ends up with
`lead: anthropic` / `worker: openai`. With no config, the template is copied
as-is.

## 1.6. Scenario A-1 — permission rules config file (P1-5)

By default, `write_file`/`edit_file`/`bash` ask every time in a prompt (there
is no batch-approve flag like `-y` — the REPL has a person to answer). Add a
`permission` block directly to the `$KAPEL_CONFIG_DIR/config.json` you just
created, and confirm that specific commands are auto-allowed/denied:

```bash
# Add this at the top level of config.json (same level as backends/models)
#   "permission": {
#     "edit_file": "allow",
#     "bash": { "*": "ask", "git *": "allow", "rm *": "deny" }
#   }
kapel "run git status"       # git * → allow, runs immediately with no prompt
kapel "edit a test file"     # edit_file → allow, edits immediately with no prompt
kapel "rm -rf the build folder"    # rm * → deny, no prompt at all, denied outright
```

`.agent/config.yaml` can hold the same shape of `permission:` block, and the
repo side takes precedence over the machine config. If neither file has
`permission`, behavior is unchanged from before (default: only read-only
tools auto-allowed). If part of a `permission` block is malformed (e.g. a
typo), the rest of the config isn't broken — only the bad entry is ignored,
with a single `warning: …` on stderr.

## 2. Scenario A — interactive agent (M1)

Create a test repository (on Windows cmd, substitute Notepad or similar for
file creation) and run inside it:

```bash
mkdir -p /tmp/agent-fixture && cd /tmp/agent-fixture && git init -q
cat > calc.js <<'EOF'
function add(a, b) { return a - b; }   // intentional bug
module.exports = { add };
EOF
cat > calc.test.js <<'EOF'
const { add } = require("./calc");
if (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
EOF
git add -A && git commit -qm init

kapel --no-setup          # enter the REPL — we'll do this by hand in section 4, so turn off auto-setup
```

`kapel` no longer **asks** whether to set up the project — for a fresh repo
with no `.agent/`, before the banner appears it prints the one line below and
runs `kapel init` and `kapel policy compile` right there. The same summaries
those two commands print in the shell are echoed straight into the REPL:

```text
setting this project up for kapel — creating .agent/ and compiling the
orchestration policy…
```

**Confirm no model call happens.** The notice line should not say
`(one model call)`, and the summary that follows should include
`Read the policy from its canonical form — no model call.` The policy the
template ships is already in kapel's canonical form, so it's handled by
parsing rather than compiling — this setup runs to completion even on a
machine with zero credentials.

**A prose-policy repo skips this at startup entirely.** In a repo whose
`.agent/` has only a prose `orchestration.md` and no lock, opening `kapel`
doesn't compile — it prints a single line:

```text
this project's orchestration policy has not been compiled — /plan or
/orchestrate will compile it (one model call), or `/policy` rewrites it in
the form that needs none.
```

Confirm that `.agent/orchestration.lock.json` was **not** created. Just
opening the REPL never calls a model — only typing `/plan` or
`/orchestrate` triggers a compile. That line is printed at most once per
session.

If this fails, the REPL doesn't stop — the conversation continues, and it
won't retry in the same session (even if you then run `/plan` or
`/orchestrate`). This setup never runs at all under piped/redirected input
or under `--no-setup`.

**Run this scenario exactly as shown, with `--no-setup`** — Scenario C
(section 4) runs `kapel init` and `kapel policy compile` by hand, so we
don't want auto-setup finishing that job first. With `--no-setup`, neither
`.agent/` nor the notice line appears, and the conversation starts right
away (ordinary conversation doesn't need `.agent/`).

Run from a terminal, and a **dashboard panel** appears before the banner.
The left side is setup (working directory, session id, the backend·model
this conversation uses, login status per configured backend, and
`role  backend:model` for the four roles); the right side is this
workspace's activity (today/last-7-days runs and chats read from
`.agent/sessions.db`, succeeded/failed task counts, token totals):

```text
╭─ kapel v0.15.0 ──────────────────────────────────────────────────────────────╮
├───────────────────────────────────────┬──────────────────────────────────────┤
│ setup                                 │ activity                             │
│ workspace    /tmp/agent-fixture       │ today    no runs yet                 │
│ session      0f3c9a2b                 │ 7 days   no runs yet                 │
│ chat         claude-sonnet-5          │                                      │
│ backends     ✓ claude-code            │ usage (kapel-tracked, 7 days)        │
│                                       │ claude-code  0 in · 0 out            │
│ orchestrator claude-code:opus         │                                      │
│ …                                     │                                      │
╰───────────────────────────────────────┴──────────────────────────────────────╯
▌ type /help for commands, /exit to quit

──────────────────────────────────────────────────────────────────────────────
kapel>
```

**Things to check**:

- Being a new repo, the activity column should read `no runs yet` (not a row
  of zeros).
- **The title is embedded in the box's top border** —
  `╭─ kapel v0.15.0 ───…─╮`. Only the title is bold; the border, uprights,
  and dividers are all drawn in the accent color (muted sky blue). It must
  not go back to the old style of a separate title line inside the box.
  Redrawing with `/stats` should look identical.
- **The accent color degrades in three tiers depending on terminal
  capability.** Check:
  ```bash
  script -qfc "env COLORTERM=truecolor TERM=xterm-256color kapel chat --no-save --no-setup" /tmp/kapel-c.log
  grep -ao $'\033\[38;2;126;182;217m' /tmp/kapel-c.log | head -1   # 24-bit
  
  script -qfc "env -u COLORTERM TERM=xterm-256color kapel chat --no-save --no-setup" /tmp/kapel-256.log
  grep -ao $'\033\[38;5;110m' /tmp/kapel-256.log | head -1         # 256-color
  
  script -qfc "env -u COLORTERM TERM=xterm kapel chat --no-save --no-setup" /tmp/kapel-16.log
  grep -ao $'\033\[36m' /tmp/kapel-16.log | head -1                # basic cyan
  ```
  Sending a 24-bit escape to a 256-color terminal prints the raw numbers
  on screen, so a mistake in this tiering is immediately obvious.
- **Anything kapel says on its own gets a left-hand accent bar (`▌ `)** —
  the banner hint, the auto-setup notice (per line, if multi-line),
  `resumed …`, the backend-auto-detection line, and even the Ctrl-C notice.
  Tool logs (`→ read_file …`) and the model's answers don't get one.
- **`NO_COLOR=1` strips every bit of decoration** — no bar, no rules above
  or below the prompt, no SGR escapes at all. Check:
  ```bash
  script -qfc "env NO_COLOR=1 kapel chat --no-save --no-setup" /tmp/kapel-nc.log
  grep -ac $'\033\[[0-9;]*m' /tmp/kapel-nc.log   # 0
  ```
- Login checks spawn the CLI twice, so if they exceed a 1-second budget that
  column renders as `…`. Hitting `/stats` shortly after re-checks and fills
  it in as `✓`/`!`/`✗`.
- A role overridden by `.agent/config.local.json` gets a `*`, and a
  `* from .agent/config.local.json` line appears below the box.
- Subscription balance is never shown. Neither `claude` nor `codex` exposes
  remaining usage in a machine-readable form, so instead kapel shows the
  usage it tracks itself, explicitly labeled
  `usage (kapel-tracked, 7 days)`.
- Below 80 columns wide, the two side-by-side columns stack into a single
  narrow box. Narrow the terminal and run `/stats` again to check.
- **Piped/redirected execution never shows the dashboard** — you get the
  old plain banner (`kapel v0.15.0  claude-sonnet-5  session 0f3c9a2b`) and
  no control characters leak through. Check:
  `printf '/exit\n' | kapel chat --no-save | cat -A` should have no `^[`.
- **Starts on a clean screen** — run from a terminal and it switches to an
  alternate screen buffer like `vim`/`less`, so whatever was in the shell
  before is hidden and the dashboard above becomes the top of that blank
  screen. **Regardless of how you exit** (`/exit`, Ctrl-D, Ctrl-C twice,
  `kill <pid>` from another terminal), the original terminal must come back
  with its prior history intact — staying on the alternate screen and
  dropping back to the shell there is a bug. Note that lines scrolled off
  during the session mostly don't stay in scrollback in most terminals. If
  you want the transcript to stay in terminal scrollback,
  `--no-altscreen` turns this off (works like v0.10.1 did; can go before or
  after `chat`). Check:

  ```bash
  script -qec "kapel chat --no-save --no-setup" /tmp/kapel-tty.log   # /exit inside
  grep -c $'\033\[?1049h' /tmp/kapel-tty.log   # 1 — on entry
  grep -c $'\033\[?1049l' /tmp/kapel-tty.log   # 1 — on exit (once each, in order)

  script -qec "kapel chat --no-save --no-setup --no-altscreen" /tmp/kapel-plain.log
  grep -c $'\033\[?1049' /tmp/kapel-plain.log  # 0 — none at all
  ```

  Neither sequence appears at all under piped/redirected execution or
  `TERM=dumb` (same reason as the `cat -A` check above).

Once the `kapel>` prompt appears, tell it to fix the bug in conversation.
This prompt is a line editor: append `\` at the end of a line (or paste
several lines at once) to keep typing, ending with a blank line; ↑/↓ recall
previous input, persisted across sessions in `~/.kapel/history`; Tab
completes whatever is under the cursor — `/` command names, arguments for a
command with a fixed argument list (built-in model aliases after
`/model `), and `@` file mentions.

Check the **rule above the prompt** first. Every time the prompt appears, an
accent-colored horizontal rule is drawn just above it, visually separating
the message you're typing from the history above. This rule is just a
printed line, so it stays in scrollback and there's nothing to redraw or
erase. **There's deliberately no rule below** — the area below the input
line is used by the `/` menu, and the moment the number of characters typed
becomes a multiple of the terminal width, Node's `readline` view of the
cursor row drifts one row out of sync with the terminal's actual cursor row
(a short `/command` never hits this boundary, but an ordinary message
crosses it once per width). Drawing something below on every keystroke would
break a wrapped input line by shifting it one row. This rule also isn't
drawn under piped/redirected input or `NO_COLOR`.

**Ctrl-C discards the line being typed.** Type up to `/res`, press Ctrl-C,
then type `/exit` — `/exit` must run as typed. (Previously `/res` stayed in
the buffer and `/exit/res` was dispatched.) The discarded line stays visible
on screen (so you can see what was thrown away), and the notice
`▌ (/exit to quit, Ctrl-C again to force)` appears on the next line below it.

```text
────────────────────────────────────────────────────────────────
kapel> /res            ← Ctrl-C here
▌ (/exit to quit, Ctrl-C again to force)
────────────────────────────────────────────────────────────────
kapel> /exit           ← exits cleanly. Must not become "/exit/res"
```

Check the **`/` command menu** next. The moment `/` is typed as the first
character of a message, this session's command list appears **below** the
input line — one per line, with the same description as the `/help` table.
It narrows live as you type more, and disappears the moment the name ends
with a space (starting an argument) or the line no longer starts with `/`.
It shows up to 8 lines, counting the rest as `… and N more`. The menu is
**display only**: Tab still completes as before, and Enter sends exactly
what you typed even if only one candidate remains on screen.

```text
────────────────────────────────────────────────────────────────
kapel> /          ← 8 lines of command list below the input line + "… and N more"
kapel> /re        ← only /resume, /resume-run remain
kapel> /re⏎       ← list is cleanly cleared, no residue in the history above
```

**Expected behavior**: on the alternate screen (with or without
`--no-altscreen`), the history above the prompt stays put while the list is
drawn and cleared. Under piped/redirected execution, the menu never renders
at all — no control characters at all should appear:

```bash
printf '/re\n/exit\n' | kapel chat --no-save --no-setup > /tmp/kapel-piped.log
grep -c $'\033' /tmp/kapel-piped.log   # 0
```

Now check **`@` file mentions (P1-3)**. Type `@` followed by part of a path
and press Tab to complete it via fuzzy matching over the full path —
`@clisrc` → `apps/cli/src/…`, `@calc` → `calc.test.js`. With one candidate
it fills in directly; with several, it fills in the common prefix, and
pressing Tab again shows the list. Candidates come from
`git ls-files --cached --others --exclude-standard` in a git repo (tracked
files plus untracked files not caught by `.gitignore`), or otherwise a
depth-4 directory walk skipping `node_modules`/`.git`/`dist`. Results are
cached for a few seconds so repeated Tab presses don't re-spawn git every
time.

```text
kapel> @calc      ← Tab → completes to "@calc.test.js"
kapel> find the reason @calc.test.js is failing and fix it. Verify with node calc.test.js.
```

**Expected behavior**: the mention stays in the message as typed, and at
send time, a `[mentioned files: calc.test.js]` line is appended listing only
the files that actually exist — the file's **contents are not attached**
(the agent reads it itself via `read_file`). A nonexistent path, an email
address (`me@example.com`), or a path outside the working directory
(`@../x`) are ignored and nothing is appended.

```text
kapel> find the reason calc.test.js is failing and fix it. Verify with node calc.test.js.
```

**Expected behavior**: read/grep are auto-allowed; before running
`edit_file`/`bash`, you get an
`allow ...? [y/n/a, or say what to do instead]` prompt → answering `y` →
the fix, then a summary + a one-line token/cost note for that turn
(`tokens +… in, +… out`). What's actually about to happen is shown before the
prompt — `bash` shows the full command, `edit_file` shows a `-`/`+` unified
diff, `write_file` shows the path and the start of its content. There are
four possible answers: `y` (allow just this once) / `n`·Enter·Ctrl-C
(deny) / `a` (always allow for the rest of this session) / **anything
else** (deny, and pass that text straight to the agent). For example,
answering "why are you trying to delete this file?" or "write the config
file for me instead" means that tool call doesn't run, and within the same
turn the agent responds to what you said and proposes a different approach
(which gets its own prompt in turn). This kind of answer leaves nothing in
the session allowlist. For `bash`, `a` remembers the **command prefix** —
answering `a` to `npm test --run foo` means `npm test …` isn't asked about
again, but `npm publish` still is (a command mixing shell operators like
`&&`·`|` isn't remembered). Every other tool is remembered by tool name;
either way, nothing is written to disk, so it's gone once the process
exits.
Back at the prompt, the conversation continues:

```text
kapel> also add a sub function and its tests
kapel> /usage        # this process's cumulative tokens/cost
kapel> /stats        # redraw the dashboard — the today column now has "1 chat" and real tokens
kapel> /compact      # compact context right now ("compacted: elided … / nothing to compact.")
kapel> /sessions     # list of conversations in this directory (id, last updated, message count, title)
kapel> /undo         # restore the working tree to before the last prompt
kapel> /exit
```

The native backend also auto-compacts once a conversation exceeds 60
messages — old tool results get elided (the conversation itself stays, only
marked as elided), a gray `≈ context compacted: …` line appears, and the
conversation continues uninterrupted. Under `--backend codex`/
`--backend claude-code`, the external CLI manages its own context, so
`/compact` just prints
`not supported with the … backend`.

Check **checkpoints and `/undo`**. Since an interactive session edits real
files with no isolation, kapel snapshots the working tree **right before
every prompt** (slash commands don't touch files, so they aren't
snapshotted). After `calc.js` was fixed above, press `/undo`:

```text
kapel> /undo
↩ restored 1 file to before "find the reason calc.test.js is failing and …" (2 min ago)
  every edit since then is gone, including ones made by shell commands or other programs — undo is one-way
```

`git diff` lets you confirm the revert (back to
`add(a, b) { return a - b; }`). The snapshot is a git tree object built in a
**temporary index**, so it never touches the real index, working tree, or
`git stash list` (check that `git stash list` stays empty), and it includes
**untracked files**, which `git stash` can't see — a file the agent newly
created is deleted by `/undo`, and a file it deleted comes back. Edge cases
worth checking:

- Nothing to undo: `nothing to undo — no checkpoint has been taken in this
  session yet.`
- A non-git directory (`mkdir /tmp/plain && cd /tmp/plain && kapel`): no
  snapshot is ever taken, and `/undo` says
  `needs a git repository … Run \`git init\``.
- A merge/rebase in progress (a `git merge` conflict state): refused with
  `/undo is unavailable while a merge is in progress …`, and the checkpoint
  is kept as-is.
- Anything matched by `.gitignore`, and `.agent/`, are excluded from both
  snapshot and restore (the session DB is never rolled back). Undo is
  one-directional; there is no `/redo`. Checkpoints are kept for the most
  recent 20 per session, in memory only, and gone once the process exits.

Next, check **resume** — the conversation is stored in
`.agent/sessions.db`, so it survives the process being stopped and
restarted:

```bash
kapel chat --continue     # picks that same conversation back up ("resumed … (N messages)")
```

`kapel chat --help` also documents `--session <id|name>` (a specific
conversation, by id, id prefix, or a name set via `/name`) and `--no-save`.
From the prompt, also try `/new` (new conversation), `/resume <id|name>`
(switch), `/name` (view/set this conversation's name), `/fork [name]`
(clone the conversation so far into a new session and switch to it),
`/model <alias>` (swap models starting next turn), `/config` (re-run the
machine-config wizard and apply the backend/model directly to this
conversation — this directory's `.agent/config.local.json` override is
kept as-is, and the backend follows the orchestrator role's; conversation
content is preserved), `/compact` (compact context right now), `/undo`
(restore files to before the last prompt), and `/help`. `/config` only
works in a terminal — under piped execution it prints
`/config needs a terminal —`.

Check **`/name`·`/fork` (the rest of P1-8)**:

```text
kapel> /name                    ← if unnamed yet: "(unnamed)"
kapel> /name calc-experiment     ← sets a name — reflected in .agent/sessions.db immediately
kapel> /name                    ← "calc-experiment"
kapel> /fork before-refactor    ← clones the conversation so far into a new session and switches to it
```

**Expected behavior**: `/fork` prints
`forked to <newId8> (before-refactor) — now on the new session.`, and
subsequent prompts continue on the new session — the original
(`calc-experiment`) stays where it is, keeping its history up to the fork
point, and both show up as separate rows in `/sessions`. `--session
calc-experiment` reopens the original (if a name spans multiple sessions,
the most recent one is picked, with a one-line notice saying so). A name
can't be empty or start with `/` (to avoid confusion with slash commands)
— `/name /oops` is rejected immediately.

Also check: Ctrl-C mid-turn (cancels only that turn, conversation is kept),
Ctrl-C twice at the prompt (exit), Ctrl-D (exit).

Check the **removed surface** — the old one-shot commands and flags should
end with a short Commander error line and exit code 1 (no message pointing
you to the REPL):

```bash
kapel plan "add a health endpoint"   # error: unknown command 'plan'
kapel exec "fix the test"            # error: unknown command 'exec'
kapel worker                         # error: unknown command 'worker'
kapel "fix the failing test"         # error: unknown command 'fix the failing test'
kapel --json                         # error: unknown option '--json'
kapel -i shot.png                    # error: unknown option '-i'
echo $?                              # 1
```

`kapel --help` and `kapel help` should show only the remaining
administrative commands (`chat`, `init`, `config`, `models`, `runs`,
`sessions`, `explain`, `policy`, `help`) and global flags (`--cwd`,
`-m/--model`, `--timeout`, `--backend`, `--no-setup`) — no
`exec`/`plan`/`orchestrate`/`resume`/`worker` rows.

Also check: Ctrl-C mid-turn (cancels only that turn), `--timeout 30`.

Check **`AGENTS.md` loading** — put a project instruction file in the same
repo and run again:

```bash
echo 'always run `node calc.test.js` after every edit' > AGENTS.md
kapel
```

**Expected behavior**: the line right after the banner shows
`instructions: AGENTS.md`, and that rule is followed from the first turn.
`.agent/AGENTS.md` (kapel-only rules) and `~/.kapel/AGENTS.md`
(`$KAPEL_CONFIG_DIR`-relative, machine/user-global rules) are merged the
same way, and only files that exist are listed in the banner — if none
exist, that line is omitted entirely.

## 2.6. Image attachments — `@` mentions

Images are attached via the REPL's `@` mention, and this works on **all
three backends**. Mentioning an image file (png/jpg/jpeg/gif/webp) like
`@screenshot.png` in a message attaches the image for that turn. Up to 4 per
turn, 5 MiB each — this limit is the same regardless of backend.

```text
kapel> @screenshot.png what's wrong in this screen?
```

**Expected behavior**: the prompt shows
`[attached images: screenshot.png]` and the model answers based on the
image's content. Delivery differs by backend — native sends the image
bytes themselves; `--backend codex` passes the path through Codex CLI's own
image input (`-i <path>`); `--backend claude-code` passes the path in the
prompt's `<attached-images>` block so the agent opens it itself via the
Read tool. If the limit is exceeded or the read fails, you get a
`note: @huge.png was not attached — …` notice and it downgrades to a plain
path mention, with the turn still sent. There's still no one-shot flag
(`kapel -i x.png` → `error: unknown option '-i'`, exit code 1).

## 2.7. Scenario A-3 — custom slash commands (P1-4)

`kapel init` already creates `.agent/commands/review.md` as an example (if
you haven't run `kapel init` yet, do it first in Scenario C). Check it
interactively:

```bash
cd /tmp/agent-fixture
kapel init          # if not done yet — includes .agent/commands/review.md
kapel
```

```text
kapel> /help                    ← under "custom commands (.agent/commands/):"
                                    confirm "/review  Review the current diff for bugs..."
kapel> /review focus only on calc.js's add function
```

**Expected behavior**: `/review` behaves as if the body of
`.agent/commands/review.md` (with `$ARGUMENTS` replaced by what you just
typed, "focus only on calc.js's add function") was sent as an ordinary user
message — a checkpoint is taken, a token-usage line follows the response,
same as any regular message.

Create a new command yourself:

```bash
mkdir -p .agent/commands
cat > .agent/commands/tests.md <<'EOF'
---
description: Run the project's tests and summarize failures
model: claude-haiku-4-5
---
Run `node calc.test.js` via the bash tool and summarize any failures.

$ARGUMENTS
EOF
```

```text
kapel> /help          ← check again — /tests appears immediately (no restart needed)
kapel> /tests
```

**Expected behavior**: since it has `model:` frontmatter, this turn runs on
`claude-haiku-4-5` (the banner/`/model` still show the original model
right after), and everything else matches the above. A file whose name
doesn't match `^[a-z][a-z0-9-]{0,31}$` (e.g. `Foo.md`), or one that collides
with a built-in command name (`help.md`), gets a single
`warning: skipping …` in `/help` and is ignored — built-in commands always
win.

## 3. Scenario B — Codex backend (OpenAI OAuth)

```bash
cd /tmp/agent-fixture
kapel --backend codex           # open the REPL on the Codex backend
```

```text
kapel> add a subtraction function sub next to calc.js's add function
```

**Expected behavior**: the Codex CLI is spawned, streaming command
execution and file changes, and the turn ends normally. The banner shows a
line noting that approval lives with the Codex CLI. If not
installed/logged in, install/login instructions are printed and it exits
with code 1. Selecting Codex in `kapel config` opens the same path with no
flag needed.

## 3.5. Scenario B2 — Claude Code backend (subscription login)

This path works with only a Claude subscription login, no API key:

```bash
cd /tmp/agent-fixture
kapel --backend claude-code     # open the REPL on the Claude Code backend
```

**Expected behavior**: `claude -p` is spawned, printing tool-use lines
(`→ claude: Edit`) and the final answer, ending with `status: success`. If
not installed/logged in, install/login instructions
(`npm install -g @anthropic-ai/claude-code`, then run `claude` and log in)
are printed, exiting with code 1.

Next, check **interactive use on the Claude Code backend**:

```bash
kapel --backend claude-code            # run with no objective → interactive
```

The banner reads
`kapel v0.15.0  claude-code · opus  session 0f3c9a2b`, with
`approvals are enforced by the Claude Code CLI — kapel does not prompt here`
below it — on this path, kapel never asks
`allow …? [y/n/a, …]` (approval is handled by the Claude Code CLI's own
policy).

```text
kapel> find out why calc.test.js is failing
kapel> fix the file you just mentioned        ← checks that it remembers the previous turn (--resume chaining)
kapel> /model sonnet                    ← swaps models starting next turn (conversation kept)
kapel> /compact                         ← "not supported with the Claude Code backend." single line
kapel> /sessions                        ← recorded in the same DB as native conversations
kapel> /exit
```

**Expected behavior**: the second turn must know about the previous
conversation — the first turn just runs, and later turns append
`--resume <id>` using the session id Claude Code handed back (the
conversation content is not resent). The conversation is stored in
`.agent/sessions.db`, so `kapel chat --continue --backend claude-code` can
pick it back up — in that case, the conversation content saved so far is
replayed once on the first turn, then continues via the session id as
before. (The Codex backend doesn't report a resumable id, so it works
statelessly, resending the recent conversation on every turn.)

Note: this backend's REPL still supports `/plan`·`/orchestrate` normally.
Planning delegates to a single `claude -p --permission-mode plan` call
(read-only); execution spawns one `claude -p` per task in that task's own
workspace (worktree), using the model and `tools:` list the agent declares
(passed as `--allowedTools`).

## 4. Scenario C — multi-agent orchestration (M2–M6)

```bash
cd /tmp/agent-fixture
kapel init                      # copies the .agent/ template
```

(If you already opened `kapel` without `--no-setup` in section 2 and
auto-setup already ran, `.agent/` and the lock already exist —
`kapel init` prints `already exists` with exit code 1, so either skip this
step or use `kapel init --force` to recreate it. The `kapel policy compile`
below can still be run either way.)

Edit `.agent/config.yaml`'s `models:` to match your credentials (if you have
a global config, it's already filled in per Scenario A-0). If you only have
Anthropic, change `reviewer` like this:

```yaml
  reviewer:
    provider: anthropic
    model: claude-opus-5
```

Then:

```bash
kapel policy compile            # canonical-form policy → orchestration.lock.json
                                # `Read the policy from its canonical form — no model call.`
                                # there must be **no** `tokens — …` line (nothing was spent)
kapel policy explain            # review the compiled policy summary
kapel policy check              # offline freshness check (for CI)

# Open .agent/orchestration.md to confirm it's in canonical form — it should
# start with a `<!-- kapel:policy v1 -->` marker, with one-line rules under
# `## Execution` / `## Routing`.

# The editor: edits the policy without calling a model.
kapel policy edit               # pick "Concurrency" → change the number → "Save"
                                # ends with `No model was called.`, printing the changed item as a diff
kapel policy check               # the lock should already be fresh right after the edit (no compile needed)

# After hand-editing the canonical form:
kapel policy diff                # preview pending changes against the lock (lock untouched, no model call)
kapel policy compile             # actually updates the lock — though you'll rarely type this by hand:
                                 # the next `kapel` startup re-reads it automatically, as below

# Switching back to prose crosses over to the model path. Rewrite
# orchestration.md entirely as a few natural-language paragraphs (also
# deleting the marker line), then:
kapel policy compile            # this time: `Compiled policy using …` + `tokens — …`
                                # check that warnings/ambiguities carry orchestration.md:N line numbers

# Keep the marker but break one rule line — it should name the line number
# on stderr and then compile via the model — confirm it isn't silently
# ignored.

# This works the same on delegated backends too (no API key needed — see 3.4/3.5):
kapel policy compile --backend codex   # for a prose policy, the `tokens — …` line reports whatever the CLI reported,
kapel policy diff --backend codex      # or `none reported by the codex CLI` if it reported nothing

```

Planning and execution happen inside the REPL:

```bash
kapel                           # enter the REPL
```

```text
kapel> /plan add multiply/divide functions to calc.js, with a test file for each
kapel> /orchestrate add multiply/divide functions to calc.js, with a test file for each
```

**`/plan` expected behavior**: a task DAG table (ID/TYPE/COMPLEXITY/AGENT/
DEPS/TITLE) is followed by a `Routing rationale:` section, **always** —
which rule (match criteria, strength, weight) routed each task to which
agent/model, and if no rule matched, whether it fell back to
`suggestedAgent` or the orchestrator. This is what the old `kapel plan
--why` did; it's now the default behavior rather than a flag. Nothing is
executed.

**`/orchestrate` expected behavior**: task-lifecycle lines like
`▶ T01 → explorer`, worktree creation (⎇)/merge (⇡) lines, merge commits in
`git log`. Once execution finishes, a per-task status table (STATUS/ID/
AGENT/TRIES/MODEL/TOKENS/$/TITLE) is followed by a **per-agent summary
table** — one row per participant that actually did something, orchestrator
first: AGENT/ROLE/BACKEND·MODEL/TASKS/DID/TOKENS columns, where the
orchestrator row shows `planned N tasks` (plus `· M reviews injected` if
policy injected reviews) and an objective summary, and worker rows show a
task tally like `2 ok · 1 failed` plus the titles of completed tasks. An
escalated task is tallied under whichever agent ultimately completed it (or
exhausted retries on it). In `--json`, the same information appears in the
`run.summary` line's `agents` array. If the policy lock is missing or stale,
that fact is reported and the conversation stays open (the REPL doesn't
disconnect).

**`/plan`·`/orchestrate` on an unprepared project**: an interactive session
auto-completes setup on open as in section 2, so to see this state you need
a session started with `--no-setup` (see section 2) or a non-interactive
session. Such a session doesn't attempt auto-setup even with no `.agent/` or
lock, and errors immediately. To check this, open `kapel --no-setup` in an
empty directory with no `.agent/`, then type `/plan anything` — with no
notice line at all, it prints the old
`No .agent directory found — run \`kapel init\` first` as before.
(When auto-setup itself fails in an interactive session, one line reports
the failure, and the same session's next `/plan`·`/orchestrate` doesn't
retry, just errors. A canonical-form policy never calls a model, so it
doesn't fail here for lack of credentials — only a project whose policy was
rewritten as prose does.)

Isolation (worktree), validators, and backend are now decided by config
rather than flags — `--worker-mode`/`--isolation`/`--tui`/`--dry-run`/
`--no-validate` have been removed, and a worker always runs on this
process's native loop (or the delegated backend's CLI).

### 4.4. An edited policy is picked up automatically

Open `.agent/orchestration.md` (canonical form) in an editor and change one
line:

```bash
sed -i 's/- Run at most 4 agents at a time./- Run at most 2 agents at a time./' .agent/orchestration.md
kapel        # just open it again — type nothing
```

**Expected behavior**: two lines appear before the banner, and the lock is
updated:

```text
re-reading this project's edited orchestration policy…
Read the policy from its canonical form — no model call.
Lock written to …/.agent/orchestration.lock.json
```

`kapel policy check` → `policy lock is up to date`, and
`.agent/orchestration.lock.json`'s `policy.maxConcurrency` should be 2. The
point is that you never have to type `kapel policy compile` by hand.

**Editing it as prose works the other way** — rewriting `orchestration.md`
in natural language (also removing the marker line) means it doesn't
compile at startup, printing only:

```text
this project's orchestration policy has changed since it was compiled — /plan
or /orchestrate will compile it (one model call), or `/policy` rewrites it in
the form that needs none.
```

Confirm the lock was **not** updated.

## 4.5. `/policy` — editing policy without a model

Inside the REPL:

```text
kapel> /policy                  ← an arrow-key list appears
```

**Expected behavior**: under the title `Orchestration policy`, you see
`Orchestrator` / `Concurrency` / `Independent tasks` / `Attempts per task` /
`Routing rules (5)…` / `Review rules (1)…` / `Escalation rules (2)…` /
`Save` / `Discard changes`. Check:

- **Editing a scalar** — pick `Attempts per task`, change the number, then
  `Save`. Expect `Wrote …/orchestration.md`, `Lock written to …`, a diff of
  the changed item (`defaultMaxAttempts: 2 -> 4`), and finally
  `No model was called.`
- **Adding a rule** — `Routing rules…` → `Add a rule…` → edit the fields,
  then `Back`. The list should grow by one rule. Conversely, pressing
  **esc** from the rule screen should **not** add it (pressing `Back` with
  no edits made does add it).
- **Removing a rule** — select a rule, then `Remove this rule`.
- **Cancel** — choosing `Discard changes` prints
  `Nothing written — the policy is unchanged.` and the file is untouched.
- **Fresh right after saving** — from the shell, `kapel policy check` →
  `policy lock is up to date`. Since the editor writes the lock too, no
  compile is left pending.
- **Rejects an invalid agent** — the editor can't save an agent this
  project doesn't define (the agent field is a picklist so this normally
  can't happen, but delete a file under `.agent/agents/` and press `Save`
  to see `This policy cannot be saved yet:`).

Under piped/redirected input, both `/policy` and `kapel policy edit` report
that there's no terminal to ask on, and exit.

## 5. Sessions, resume, and explain (M6)

Inside the REPL:

```text
kapel> /runs                    ← the run just done appears in the list (use its id in the commands below)
kapel> /resume-run <runId>      ← (if there's a failed run) re-runs only the incomplete tasks
```

**Expected behavior**: `/runs` shows an ID/STATUS/STARTED/TASKS/OBJECTIVE
table; `/resume-run` starts with
`Resuming run <id> — N of M tasks left …` and re-runs only the remaining
tasks. Note that this is a different command from `/resume`, which switches
conversations — `/resume <sessionId>` still switches conversations, even if
given a run id (it does not resume a run). Given an unknown run id, a
single `Unknown run … Run \`/runs\` to see the recorded ones.` line appears
and the conversation continues.

From the shell:

```bash
kapel runs                      # same list (--limit, --json)
kapel explain T01               # routing rationale + event digest (--run, --json)
```

Conversations (Scenario A) and orchestration runs are each stored in the
same `.agent/sessions.db`: conversations are checked via
`kapel chat --continue` / the prompt's `/sessions`; runs via `/runs` (or
`kapel runs`).

Outside the REPL, to list or clone conversations:

```bash
kapel sessions                              # this workspace's conversation list, most recently updated first
kapel sessions fork <id>                    # clones that conversation's full history into a new session
kapel sessions fork <id> --name "experiment branch"  # …with a name attached
```

**Expected behavior**: `kapel sessions` shows the conversation created in
Scenario A as an `ID`/`UPDATED`/`MSGS`/`TITLE` table (a `NAME` column is
added if any session has a name). `kapel sessions fork <id>` prints a single
`Forked <id> → <newId>` line, and afterward the clone shows up as a
separate row in `kapel sessions`, continuing independently of the
original — entering the clone with
`kapel chat --session <newId>` and sending a message leaves the original
conversation's (`<id>`) message count unchanged. In place of `<id>` you can
use the full id, a short prefix, or a session name (set above via
`--name`); if a prefix matches multiple sessions, it errors and asks for a
longer prefix.

## 6. Validation gate (M5)

Add this to `.agent/config.yaml` and run `/orchestrate` again — each
write-task must pass validation inside its worktree before it merges:

```yaml
validation:
  - name: test
    command: node calc.test.js
```

## Known caveats

- The catalog's OpenAI model IDs (`gpt-5.1`, etc.) are close to
  placeholders — when using the native OpenAI path, point `config.yaml`/`-m`
  at a real, available model id. (Irrelevant for the Codex backend.)
- `ant` OAuth tokens are short-lived, so a very long run can hit expiry.
- `~/.kapel/config.json` is machine-wide config, and
  `.agent/config.local.json` is the same shape as a per-directory override
  (not committed). Both are separate from the committed
  `.agent/config.yaml` (per-agent models) — `kapel init` only fills the
  latter in from the former.
- It's recommended to add `.agent/sessions.db*`·`.agent/worktrees/`·
  `.agent/config.local.json` to the target repo's `.gitignore`
  (`kapel init` does this automatically).

## Reporting problems

If something goes wrong, please share: the command (or slash command) you
ran, the output of `kapel runs --json` / `kapel explain <taskId> --json`,
and the run id in `.agent/sessions.db`.
