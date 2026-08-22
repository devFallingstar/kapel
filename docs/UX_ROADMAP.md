# kapel UX gap analysis and roadmap

Comparison targets: **Claude Code**, **OpenAI Codex CLI**, **opencode
(sst/opencode)**. As of 2026-08-19. Every kapel-side claim is backed by
actual code in this repository; every peer claim is marked inline with a
link to a primary-source document. Items that could not be confirmed are
left as "(unverified)".

Work that is already landing (`--backend claude-code`, the first-run setup
wizard + `~/.kapel/config.json` + `/config`, `BackendChatSession`) is
**treated as already existing** and is not proposed again below.

---

## 1. Executive summary — the 5 things most holding back day-to-day usability right now

**① There is effectively no line editor.** `ttyLineSource()` creates a new
`readline.createInterface` on every prompt and closes it immediately
(`apps/cli/src/interactive.ts:749`). The result: **↑ history doesn't even
work within a session**, there's no multi-line input, pasting multiple
lines splits into multiple messages, and there's neither `@` file mentions
nor `/` autocomplete. All three peers provide this as a baseline — Claude
Code has `\`+`Enter`/`Ctrl+J` multi-line and `Ctrl+R` reverse search, with
persistent per-working-directory history
([interactive-mode](https://code.claude.com/docs/en/interactive-mode));
Codex has `@` fuzzy file search
([getting-started](https://github.com/openai/codex/blob/rust-v0.44.0/docs/getting-started.md));
opencode has full `@` mentions, `!` shell mode, and an Emacs edit keymap
([tui.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/tui.mdx),
[keybinds.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/keybinds.mdx)).
This single item accounts for most of "switching to kapel from another
agent hurts your hands."

**② The screen is dead while a turn is running.** The provider streams
`text.delta`, but `AgentLoop.#runTurn` only accumulates it into an internal
variable (`packages/coding-agent/src/loop.ts:354-387`) and text is emitted
all at once on `model.turn.completed`. `TextRenderer` only prints two lines
for tool start `→`/end `✓` (`apps/cli/src/render.ts:168-180`), so for the
tens of seconds the model spends thinking, there is **no spinner, no
elapsed time, no partial text**. Token-by-token streaming is the default
for all three peers.

**③ Approval UX is a binary choice with no way back.** `askOnce()` is
`[y/N]` only (`apps/cli/src/prompter.ts:91`), and the preview is the tool
input JSON truncated to 120 characters, so you can't see `edit_file`'s
actual diff (`previewInput`). There is no axis like "allow this tool for
the rest of this session" or "deny this path", and the interactive path
gets no worktree isolation either (`--isolation` is `orchestrate`/`resume`
only) — approve the wrong thing and the working tree stays contaminated.
Claude Code has `Shift+Tab` permission-mode cycling and `/rewind` (Esc Esc)
checkpoints
([checkpointing](https://code.claude.com/docs/en/checkpointing)); opencode
has per-tool/per-pattern `allow|ask|deny` plus `/undo`·`/redo`
([permissions.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)).

**④ There's no project instruction file, and context compaction isn't
wired up.** The system prompt is just `defaultSystemPrompt(workspacePath)`
— there is no `CLAUDE.md`/`AGENTS.md` equivalent. Claude Code has a
four-layer managed→user→project→local hierarchy
([memory](https://code.claude.com/docs/en/memory)); Codex merges
`~/.codex/AGENTS.md` + repo root + cwd across three tiers; opencode has
`AGENTS.md` plus an `instructions` key
([rules.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/rules.mdx)).
On top of that, `CompactionOptions` is implemented in `loop.ts` but **is
not injected anywhere in the CLI** (zero call sites across the whole
repository pass `compaction:`). A long interactive session eventually just
fails at the context limit.

**⑤ The orchestration product thesis is invisible in the interactive
path.** `▶ T02 → coder (attempt 1)` says **neither which model it went to
nor why it went there** (`render.ts:217`). The routing rationale exists
only in the after-the-fact `kapel explain <taskId>`, and cost is a single
run-total line (`orchestrate.ts`'s `usageLine`), so the value proposition
"an expensive model plans, a cheap worker executes" is **never proven with
numbers**. Parallel progress display hides behind `--tui` (the Ink
dashboard) and isn't the default path. This is a capability peers don't
have, and kapel isn't showing it off yet either.

---

## 2. Capability comparison matrix

✅ = present, `~` = partial/conditional, — = absent

| Capability | kapel | Claude Code | Codex | opencode |
|---|---|---|---|---|
| Session start/resume | ✅ `chat --continue`/`--session`, `/resume` | ✅ `-c`, `-r <id\|name>` | ✅ `codex resume [--last\|<ID>]` | ✅ `--continue/-c`, `--session/-s` |
| Session fork/branch | — | ✅ `--fork-session`, `/branch` | ✅ Esc-Esc then Enter to branch | ✅ `--fork` |
| Naming a session | — (id prefix only) | ✅ `-n/--name` | `(unverified)` | ✅ `--title` |
| Multi-line input | — (`readline`, 1 line) | ✅ `\`+Enter, `Ctrl+J`, `Shift+Enter` | `(unverified)` | ✅ (editor keymap) |
| Prompt history ↑ / search | — (new interface every prompt) | ✅ persistent per directory + `Ctrl+R` | `(unverified)` | ✅ |
| `@` file mentions · autocomplete | — | ✅ | ✅ fuzzy file search | ✅ `@`, `@alias/` |
| `/` command autocomplete | — (string `switch`) | ✅ | `(unverified)` | ✅ dropdown |
| Shell mode `!` | — | ✅ | `(unverified)` | ✅ |
| Compose in an external editor | — | ✅ `Ctrl+G` / `Ctrl+X Ctrl+E` | `(unverified)` | ✅ `/editor`, `<leader>e` |
| Image attachments | — | ✅ `Ctrl+V` clipboard | ✅ `-i/--image` | ✅ `attachment.image` |
| Piped input (`cat x \| agent`) | — (stdin ignored when an objective is given) | ✅ `cat f \| claude -p` | ✅ | ✅ `--file/-f` |
| Token-streamed output | — (dumped after the turn ends) | ✅ | ✅ | ✅ |
| Spinner/elapsed time/live tokens | — | ✅ | ✅ | ✅ |
| Diff rendering | — (tool input JSON, 120 chars) | ✅ | ✅ | ✅ `diff` config |
| todo/plan display | — | ✅ `Ctrl+T` task list | `(unverified)` | ✅ |
| Message queuing while running | — (no input during a turn) | ✅ | `(unverified)` | `(unverified)` |
| Permission-mode switching | — (`-y` approve-all only) | ✅ `Shift+Tab`, `--permission-mode` | ✅ `-a/--ask-for-approval`, `--full-auto` | ✅ `plan`/`build` agents, `--auto` |
| Per-tool/pattern permission rules | `~` code constant `DEFAULT_PERMISSIONS` | ✅ `--allowedTools "Bash(git log *)"` | ✅ `approval_policy` + `sandbox_mode` | ✅ `permission: {bash: {"git *":"allow"}}` |
| Undo (checkpoint/undo) | — | ✅ `/rewind`, Esc Esc | ✅ Esc-Esc backtrack | ✅ `/undo`, `/redo`, `snapshot` |
| Project instruction file | — | ✅ `CLAUDE.md` 4-tier + `.claude/rules/` | ✅ `AGENTS.md` 3-tier | ✅ `AGENTS.md` + `instructions` |
| User global instruction file | — | ✅ `~/.claude/CLAUDE.md` | ✅ `~/.codex/AGENTS.md` | ✅ `~/.config/opencode/AGENTS.md` |
| Custom slash commands | — | ✅ `.claude/commands/` = skills | `(unverified)` | ✅ `command` key |
| Subagents | `~` orchestrate-only, not user-invokable | ✅ `--agents`, `/agents` | `(unverified)` | ✅ `mode: subagent`, `@`-invoked |
| MCP | `~` `mcp:` in `.agent/config.yaml`, stdio only, native loop only | ✅ `claude mcp`, `--mcp-config` | ✅ `mcp_servers` TOML | ✅ `opencode mcp add` |
| Hooks / plugin loader | `~` `@agent/plugin` types only, no loader | ✅ hooks + plugins | `(unverified)` (lifecycle hooks are mentioned) | ✅ `plugin`, `opencode plug` |
| LSP integration | — | — | — | ✅ `lsp` |
| Config layering | `~` `~/.kapel/config.json` + `.agent/` | ✅ managed>CLI>local>project>user ([settings](https://code.claude.com/docs/en/settings)) | ✅ `~/.codex/config.toml` + `--profile` | ✅ 8-tier merge ([config.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/config.mdx)) |
| Theme | — (ANSI dim/bold only) | ✅ `/theme` | `(unverified)` | ✅ `<leader>t` |
| Non-interactive / CI | ✅ one-shot + `--json` JSONL | ✅ `-p --output-format json\|stream-json` | ✅ `codex exec --json`, `--output-schema` | ✅ `opencode run --format` |
| Context compaction | `~` implemented but not wired up | ✅ `/compact`, auto-compact | `(unverified)` | ✅ `/compact` |
| Session sharing/web | — | ✅ `--cloud` | — | ✅ `/share`, `opencode web` |
| **Multi-model routing** | ✅ policy IR + router | — | — | `~` per-agent model |
| **Natural-language policy compilation** | ✅ `kapel policy compile` | — | — | — |
| **Worktree parallel isolation** | ✅ default | — | — | — |
| **Run resume/explain** | ✅ `runs`/`explain`/`resume` | `~` agent view | — | — |
| Per-worker/per-model cost attribution | — (run total only) | `~` `--max-budget-usd` | `(unverified)` | ✅ `opencode stats --models` |

**Commentary on the rows that actually matter in this table**

- *The six input-editor rows are one lump.* Individually they look minor,
  but since they share a single cause (`ttyLineSource`'s per-prompt
  interface), **they get fixed together, and must be fixed together**. The
  reason for the current design is spelled out in a code comment — the
  permission prompter opens its own interface on the same stdin mid-turn,
  and two interfaces would split the answer between them. So replacing the
  line editor has to be designed together with the prompter.
- *The permission-rules row.* kapel's `DEFAULT_PERMISSIONS` is an 18-line
  constant in `apps/cli/src/permissions.ts`. There is no user-facing
  surface at all. All three peers offer file-based configuration here, and
  opencode's `{"bash": {"*":"ask", "git *":"allow"}}` shape in particular
  fits kapel best (orchestration policy is already natural-language→IR
  compilation, so permissions can ride the same axis).
- *The subagents row.* kapel actually has a stronger multi-agent executor
  than its peers (router, scheduler, worktrees, validation gates), but in
  the interactive path it's only exposed through the single `/orchestrate`
  line. Peers' subagents are weaker than kapel's workers, but they win on
  being **callable**.
- *The cost-attribution row.* This is the only cell in the table that's
  "peers don't do this well either, but kapel absolutely has to." The
  product thesis is "push work down to a cheap model," yet there's no
  screen showing the savings that produces.

---

## 3. Priority roadmap

Size: **S** ≈ 1 day or less, **M** ≈ 2–5 days, **L** ≈ 1 week or more.

### P0 — Next release

**P0-1. Replace the line editor (single long-lived readline + persistent
history + multi-line)** — **M** — ✅ shipped (v0.4.0)
- *What*: instead of creating a new interface on every prompt, keep one
  readline alive for the lifetime of the REPL and persist the `history`
  array to `~/.kapel/history` (or `.agent/history`). `\` + `Enter`
  continues a line; pasting multiple lines is coalesced into a single
  message via a short idle timer.
- *Why*: as described in ①, the single biggest cause of "this hurts your
  hands." Felt daily, more than any other feature.
- *Shape of the implementation*: split `ttyLineSource()`/`replLoop()` out
  of `apps/cli/src/interactive.ts` into a new module,
  `apps/cli/src/input.ts`. Change `apps/cli/src/prompter.ts`'s
  `askOnce()` so it no longer opens its own interface but **borrows the
  same one** (inject a `LineSource` into `createPrompter`). Keep SIGINT
  handling on `PromptState` as-is, but consolidate raw-mode-toggle
  responsibility into one place. Leave `pipedLineSource()` untouched.
- *Acceptance criteria*: (a) after `/exit` and a re-run, ↑ restores the
  previous session's last prompt. (b) sending a 3-line prompt via
  `\`+Enter results in exactly one message accumulating in
  `session.messages()`. (c) pasting 40 lines of text becomes one message.
  (d) `allow …? [y/N]` still works correctly mid-turn and Ctrl-C still
  reads as "no" (all existing `interactive.test.ts` tests pass).

**P0-2. Turn streaming + progress display** — **M** — ✅ shipped (v0.5.0)
- *What*: stream `text.delta` as an event, and while a tool is running,
  update a single status line with a spinner + elapsed seconds +
  cumulative tokens.
- *Why*: ②. Right now there's no way to tell kapel is even alive before a
  response arrives. All three peers ship this by default, which also
  makes kapel *look* slower by comparison.
- *Shape of the implementation*: emit a `model.text.delta` event from
  `packages/coding-agent/src/loop.ts`'s `#runTurn` (keep the existing
  `model.turn.completed` for JSONL-consumer compatibility). Add the event
  type to `@agent/protocol`. In `apps/cli/src/render.ts`'s
  `TextRenderer`, accumulate and print partial text, plus a `\r`-based
  status line that's active only on a TTY (silent otherwise).
  `JsonRenderer` passes the delta straight through.
- *Acceptance criteria*: on a TTY, the perceived delay until first text
  appears equals the first-token latency. The existing line shapes in
  `--json` output don't change (only new types are added). No control
  characters leak into piped/redirected output.

**P0-3. Wire up context compaction + `/compact`** — **S** — ✅ shipped
(v0.5.0)
- *What*: inject the already-existing `CompactionOptions` into both the
  interactive and one-shot paths, and add a manual `/compact` slash
  command plus a one-line `context.compacted` display.
- *Why*: the second half of ④. This is **effectively a bug** — a feature
  left unwired. Long sessions silently fail. Cost also grows unbounded.
- *Shape of the implementation*: pass `compaction: { … }` into
  `apps/cli/src/interactive.ts`'s `createSession` factory and
  `apps/cli/src/run.ts`'s `AgentLoop` construction. Add `compact` to
  `SLASH_COMMANDS` and a case in `handleSlash`. Add a one-line
  `context.compacted` case in `render.ts`.
- *Acceptance criteria*: a conversation exceeding 60 messages leaves a
  single compaction log line and continues. Right after `/compact`, the
  next turn's input tokens in `/usage` drop meaningfully.

**P0-4. Three-way approval UX + session-scoped memory + a real diff** —
**M** — ✅ shipped (v0.5.0)
- *What*: `[y/N]` → `[y/n/a]` (a = always allow this tool/command prefix
  for the rest of this session). `edit_file`/`write_file` show a few lines
  of unified diff instead of JSON. `bash` shows the full command text.
- *Why*: ③. Right now you have to re-approve `npm test` on every turn, and
  what you're approving is only visible as 120 characters of JSON. As
  Claude Code's `--allowedTools "Bash(git log *)"` and opencode's
  `{"bash":{"git *":"allow"}}` demonstrate, **prefix-level allow** is the
  real-world unit of approval.
- *Shape of the implementation*: extend response parsing in
  `apps/cli/src/prompter.ts`'s `askOnce()` plus a session-scoped allowlist
  (in memory). Keep the constant in `apps/cli/src/permissions.ts`, but
  layer a runtime overlay onto `@agent/coding-agent`'s `PermissionEngine`.
  For diff rendering, add `previewEdit(tool, input)` alongside
  `previewInput`, shared with `render.ts`.
- *Acceptance criteria*: approving `bash npm test` with `a` means it isn't
  asked again in the same session, while `npm publish` is still asked
  about. The `edit_file` prompt shows `-`/`+` lines.

**P0-5. Load project/user instruction files (`AGENTS.md`)** — **S** — ✅
shipped (v0.5.0)
- *What*: read `~/.kapel/AGENTS.md` → repo-root `AGENTS.md` →
  `.agent/AGENTS.md` in that order, append them after the system prompt,
  and show a one-line "which files were loaded" note in the banner.
- *Why*: the first half of ④. This is the common minimum baseline across
  all three peers, and many repositories already have an `AGENTS.md` —
  without this, **kapel alone is the agent that doesn't know that repo's
  rules**. The filename is `AGENTS.md` — compatible with Codex/opencode,
  and Claude Code also picks it up via `@AGENTS.md` import
  ([memory](https://code.claude.com/docs/en/memory)).
- *Shape of the implementation*: new `apps/cli/src/instructions.ts`
  (read/merge/size-limit). `apps/cli/src/run.ts`'s
  `defaultSystemPrompt()` composes it in. The interactive path composes it
  in `interactive.ts`'s `createSession`; orchestrate workers compose it
  alongside `.agent/agents/*.md` (since per-agent prompts already exist,
  **the project instructions go in front of them**).
- *Acceptance criteria*: putting an `AGENTS.md` in the repo makes
  `instructions: AGENTS.md` show up in the banner, and a rule written
  there (e.g. "always run npm run typecheck") is followed from the first
  turn.

**P0-6. Surface routing rationale and the model in flight** — **S** — ✅
shipped (v0.5.0)
- *What*: `▶ T02 → coder (attempt 1)` → `▶ T02 → coder [claude-haiku-4-5]
  (rule: implementation)`. That is, show right there **which model** it
  went to and **which policy rule** made that happen.
- *Why*: ⑤. This line is the entire reason to use this product. Right now
  this information can only be recomputed after the fact via `kapel
  explain`, but the moment it's actually needed is while the run is in
  flight. Implementation cost is also low — `PolicyRouter` already knows
  the rule-match result.
- *Shape of the implementation*: add `model` and `rule` (or
  `suggestedAgent`/`fallback`) fields to the scheduler's `task.started`
  event payload (`packages/orchestration`); extend the `task.started` case
  in `apps/cli/src/render.ts`'s `#emitTaskLifecycle`.
  `apps/cli/src/explain-cmd.ts` can be simplified to read the same fields
  directly instead of recomputing them.
- *Acceptance criteria*: `kapel orchestrate`'s text output lets you read
  each task's model and matching rule, and `--json`'s `task.started`
  carries the same fields.

### P1

**P1-1. Per-worker/per-model cost attribution and `/cost` breakdown** —
**M** — ✅ shipped (v0.6.0)
- Add `MODEL / TOKENS / $` columns per task to the run summary table, with
  a per-model rollup at the end (`orchestrator 1 task $0.42 · coder 3
  tasks $0.03`). Break `/usage` down by model in the interactive path.
- *Why*: the **only proof** of "an expensive model plans, a cheap worker
  executes." Without this, kapel's differentiator remains a claim.
  opencode's `opencode stats --models` is the closest precedent
  ([cli.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/cli.mdx)).
- *Files*: add a tag (agent/model) axis to `packages/ai`'s `UsageTracker`;
  `apps/cli/src/orchestrate.ts`'s `usageLine`/`summaryRow`;
  `apps/cli/src/interactive.ts`'s `usageTotalsLine`. Delegated backends
  (claude-code/codex) are subscription-based so a dollar figure can't be
  computed — show tokens only, explicitly marked `$ n/a`.
- *Acceptance*: in a 3-task run, the sum of per-model tokens/cost matches
  the overall total.

**P1-2. `/undo` — interactive checkpoints** — **M** — ✅ shipped (v0.6.0)
- Snapshot the working tree right before every user prompt (a `git stash
  create`-based object if it's a git repo, otherwise a copy under
  `.agent/checkpoints/<n>/`), and restore it with `/undo`. Document that
  changes made by bash are not tracked (Claude Code documents the same
  limitation,
  [checkpointing](https://code.claude.com/docs/en/checkpointing)).
- *Why*: kapel needs this even more than its peers, because it writes
  directly with no isolation in the interactive path.
- *Files*: new `apps/cli/src/checkpoint.ts`, `interactive.ts`'s
  `handleMessage` entry point, `SLASH_COMMANDS`. Reuse `@agent/workspace`'s
  git helpers.

**P1-3. `@` file mentions and `/` autocomplete** — **M** (depends on P0-1)
— ✅ shipped (v0.6.0)
- A `glob`-based fuzzy list at `@`, the `SLASH_COMMANDS` list at `/`.
  Reuse the arrow-key selection UI already in
  `apps/cli/src/select-prompt.ts`.
- *Files*: `apps/cli/src/input.ts` (P0-1's output), `select-prompt.ts`,
  `interactive.ts`.

**P1-4. Custom slash commands `.agent/commands/*.md`** — **S** — ✅
shipped (v0.6.0)
- Letting frontmatter specify `model`/`agent` makes this **a shape that's
  only meaningful in kapel** (`/review-pr` always running on the
  orchestrator model). Claude Code folded this into skills
  ([skills](https://code.claude.com/docs/en/skills)); opencode uses a
  `command` key.
- *Files*: file-based lookup ahead of `handleSlash` in
  `apps/cli/src/interactive.ts`; one example added to the
  `apps/cli/src/init.ts` template.

**P1-5. Expose permission rules as a config file** — **M** — ✅ shipped
(v0.6.0)
- A `permission:` block in `~/.kapel/config.json` (persisting P0-4's
  session allowlist) and `.agent/config.yaml`. Borrow opencode's syntax
  directly (`{"bash": {"*": "ask", "git *": "allow"}}`).
- *Files*: `apps/cli/src/config.ts` (schema extension),
  `apps/cli/src/permissions.ts`, `packages/coding-agent`'s
  `PermissionEngine`.

**P1-6. Reconcile piped input with non-interactive mode** — **S** — ✅
shipped (v0.6.0)
- Make `cat log.txt | kapel "explain this"` merge stdin into the prompt.
  Currently stdin is discarded whenever an objective is present (the
  default action in `index.ts`). This shape is actually used in CI.
- *Files*: `apps/cli/src/index.ts`, `apps/cli/src/run.ts`.

**P1-7. Policy-authoring UX** — **M** — ✅ shipped (v0.6.0)
- `kapel policy compile` already prints warnings/ambiguities, but there's
  no loop for fixing them. (a) print the `orchestration.md` source line
  number an ambiguity points to, (b) `kapel policy diff` to show the lock
  before/after a change, (c) `kapel plan --why <taskId>` to preview
  routing rationale **before execution**.
- *Why*: natural-language policy is this product's input language, and
  there's no tool for debugging that language.
- *Files*: `apps/cli/src/policy.ts`, `apps/cli/src/plan.ts`; preserve
  source spans in `@agent/policy`'s compile result.

**P1-8. Session naming/forking** — **S** — ✅ shipped (v0.6.0) / **P1-9.
Image attachments** — **M** — ✅ shipped (v0.6.0)
- The former adds `name` to `NewChatSession` + `/name`; the latter first
  needs to check whether `@agent/ai`'s message parts support images.

### P2 / Exploratory

- **MCP client** — **L** — ✅ shipped for the native loop. Stdio
  transport, hand-rolled JSON-RPC with every inbound frame zod-validated;
  `mcp:` in `.agent/config.yaml` with a `.agent/config.local.json`
  override; tools bridged as `mcp__<server>__<tool>` and gated by the
  same permission rules as `bash`. Servers start with the first native
  session that could use them and stop with it, which is the answer to
  the per-worker lifetime cost this entry used to worry about: workers
  on the delegated backends read those CLIs' own MCP config instead.
  Still open: HTTP/SSE transport, and MCP tools for orchestration
  workers.
- **Hooks** — **M**. Something like `PreToolUse`/`PostTask` via
  `.agent/hooks.yaml`. But kapel already has a strong hook in
  `validation:`, so there's overlap risk. Only after an integrated design
  with the validators.
- **Plugin loader** — **M**. `@agent/plugin` has types only, no actual
  loader. Policy transforms (`registerPolicyTransform`) are kapel's own
  interesting extension axis.
- **Inline parallel-worker progress in the interactive path** — **M**. Not
  a full `--tui` dashboard, but a one-line summary at the bottom of
  line-based output: `[T01 ✔] [T02 ▶ coder 12s] [T03 ⏸ dep]`. A screen
  peers don't have.
- **Theme/color configuration** — **S**. Currently fixed to ANSI dim/bold.
- **LSP · session sharing · web UI** — leaning toward not doing these (see
  section 4).

---

## 4. Explicitly out of scope

| Item | Reason |
|---|---|
| Claude Code's background sessions / daemon / `--cloud` / remote-control | kapel's "several things at once" is already handled by the worktree scheduler. Building a separate session supervisor solves the same problem twice, and the operating cost (daemon, process lifetime, recovery) exceeds what a single maintainer can carry. |
| opencode's headless server + web UI + SDK + ACP | Orthogonal to the terminal product thesis, and the surface area would dominate maintenance cost. If integration is ever needed, the JSONL event stream that already exists is a more honest contract. |
| vim mode, emoji shortcodes, voice input, spellcheck, prompt suggestions | Claude Code has these, but they're all "decoration on top of the line editor." Once P0-1 makes the base editor sound, the felt benefit of each is small, and each is a permanent maintenance burden. |
| Bringing in a Claude-Code-fullscreen-renderer-class custom TUI for the interactive path | The interactive path stays **line-based**. Scrollback/`grep`/redirect friendliness fits kapel's nature — used together with CI/scripts — better, and keeping Ink confined to `--tui` (the orchestrate dashboard) is the right separation as it stands. |
| Codex's `--profile` multi-layer config, opencode's 8-tier config merge | Two layers are enough for kapel — the **machine layer (`~/.kapel/config.json`) + repo layer (`.agent/`)**. More layers make "why was this model picked" cost more to explain proportional to the layer count, which directly collides with the explainability this product needs to be best at. |
| opencode-style provider marketplace (listing hundreds of models) | kapel's correct abstraction is **four slots: orchestrator / complex / middle / low** (`KapelModels` is already shaped this way). Roles, not a model list, should be what's exposed to the user. |
| Claude Code's auto memory (the model writing its own memory) | kapel sells "compile a policy and enforce it deterministically." If a model's silently accumulated memory changes routing/review outcomes, `kapel explain`'s explanation becomes a lie. We go as far as a human-authored `AGENTS.md` (P0-5) and no further. |
| LSP integration | Only opencode has it, and the validator (`validation:`) already runs typecheck/lint as a task gate. A pre-merge gate fits kapel's execution model better than edit-time diagnostics. |

---

## 5. Open questions for the maintainer

1. **If `--backend claude-code` becomes the default, who owns the native
   loop's UX?** P0-2 (streaming), P0-4 (approval), and P1-2 (checkpoints)
   are features of the native path. On a delegated backend, the Claude
   Code CLI has its own approval and streaming, so **the two paths'
   UX diverge**. (a) Should the delegated path pass the sub-CLI's screen
   through as-is, or (b) should `BackendChatSession` normalize it and
   redraw it in kapel's own screen? This choice doubles the scope of
   P0-2/P0-4.
2. **Is a single loop the right default behavior for `kapel>`?** The
   product's name is orchestration, yet the default conversation is
   single-agent and orchestrate is opt-in via `/orchestrate`. Isn't
   "if the request is complex, automatically plan → distribute" closer to
   the thesis? (If so, the fallback experience for a missing policy lock
   becomes a P0.)
3. **Should worktree isolation be added to the interactive path too?**
   Doing so makes P1-2 (`/undo`) almost free, but creates the confusion
   of "the file I'm looking at isn't changing."
4. **The source of truth for cost.** Delegated backends are
   subscription-based, so a dollar figure can't be computed. In P1-1's
   table, do we show tokens only, or a "converted savings" figure at list
   price (which risks being misleading)?
5. **Where does `AGENTS.md` live?** Repo root (shared with other agents)
   vs. `.agent/` (kapel-only)? We lean toward the former, but then the
   composition order with `.agent/agents/*.md`'s per-agent prompts needs
   to be documented.
6. **`ant` OAuth token expiry.** As a comment in `models.ts` itself admits,
   the token is resolved only once, at run start. Should a long
   orchestrate run hitting a 401 partway through be treated as a P1?
7. **`--json` in the interactive path.** Currently explicitly refused
   (`runInteractive`). Claude Code scripts the interactive path via `-p
   --input-format stream-json --output-format stream-json`. Should kapel
   open this axis too, or is orchestrate JSONL alone considered
   sufficient?

---

## Appendix — peer behaviors that could not be confirmed

This environment's egress proxy blocks `developers.openai.com` and
`opencode.ai`, so the following could not be verified against primary-source
documents.

- **Codex CLI's full slash-command list** `(unverified)`. The
  `openai/codex` repository's `docs/slash_commands.md` is currently a stub
  redirecting to `developers.openai.com`, and that domain is blocked. In
  the Codex column above, whether `/init`·`/compact`·`/diff`·`/model`·
  `/approvals` and similar commands exist is left unconfirmed.
- **Codex's multi-line input, prompt history, queuing, and todo display**
  `(unverified)`. What is confirmed is: `Esc`-`Esc` backtrack (branching
  from an earlier message), `@` fuzzy file search, `-i/--image`,
  `--cd/-C`, three-tier `AGENTS.md` merging, `codex resume
  [--last|<ID>]`, `codex exec
  --json/--output-schema/-o/--skip-git-repo-check`, and
  `config.toml`'s `approval_policy`/`sandbox_mode`/`profiles`/
  `mcp_servers`/`model_providers`/`notify`/`history`/`file_opener`/`tui`
  keys, nothing more
  ([getting-started](https://github.com/openai/codex/blob/rust-v0.44.0/docs/getting-started.md),
  [exec](https://github.com/openai/codex/blob/rust-v0.44.0/docs/exec.md),
  [config](https://github.com/openai/codex/blob/rust-v0.44.0/docs/config.md)
  — all pinned to the `rust-v0.44.0` tag, so **there may be differences
  from the latest release**).
- **opencode** was verified instead through GitHub's documentation source
  (the `dev` branch's `packages/web/src/content/docs/*.mdx`), since
  `opencode.ai/docs` is blocked. There may be small differences from the
  shipped product.
- **Codex's hooks/plugins** `(unverified)`. `requirements.toml` and an
  `allow_managed_hooks_only` key related to lifecycle hooks are mentioned
  in the repository's documentation, but the content lives on a blocked
  page.
