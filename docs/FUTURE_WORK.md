# Future work

Known gaps and follow-ups as of v0.8.2, collected from the v0.8.0 field test,
the v0.8.1 regression pass, and decisions deliberately deferred during the
REPL-first conversion. Ordered by expected user impact, not effort.

## High impact

### 1. Image attachments in the REPL
Removing the one-shot `-i/--image` flag removed image input entirely: `@`
mentions pass file *paths* into the prompt, never bytes, and neither the
native chat session nor the delegated ones accept attachments on a turn.
The provider layer (`@agent/ai`) still supports vision content, so the
missing piece is prompt-side: a way to attach an image to a REPL turn
(e.g. `@photo.png` detecting an image extension and inlining it, subject
to the old size/count limits). Documented as unsupported in README and
`docs/SMOKE_TEST.md` §2.6 until then.

### 2. Worker token usage attribution on delegated backends
The usage ledger records planner and policy-compile spend for delegated
runs (per attempt, pass-through of what the CLI reported), but **worker**
usage never reaches it: `CodexRunResult`/`ClaudeCodeRunResult` carry token
counts that the worker executors drop. The end-of-run rollup then shows
`0 tasks · … · n/a` next to a completed run, which reads as a bug. Wire
worker-reported usage into the per-task ledger the same way
`recordDelegatedUsage` does for planning, tagged by agent and task.

### 3. Claude Code workers cannot run checks
Worker subprocesses run with `permissionMode: "acceptEdits"`, which
auto-approves edits but not Bash. The template agent prompts say "run
relevant checks", so workers report they could not verify their change.
Options: expose a per-run or per-agent permission mode, promote the
project's `validation:` block (currently commented out in the template)
to an enabled-by-default example, or grant Bash for the project's own
check commands only. Until then validators are the honest gate.

## Medium impact

### 4. Orchestrator-tier agents as escalation targets
The default ladder now stops at `senior` (v0.8.2), but a *custom* policy
may still name `lead` (role: orchestrator) as an escalation or routing
target. Under a delegated backend `lead`'s `tools:` (`task.*`, `plan.*`,
…) map to no Claude Code tool, so it runs with the CLI's unscoped default
toolset and can stall on an approval prompt, ending the task `partial`.
Either give orchestrator-role agents a real worker-facing tool mapping
when they are dispatched as workers, or reject/warn at policy-compile
time when a delegated run routes work to an orchestrator-role agent.

### 5. Codex parity limits
Codex owns its sandbox, so per-agent `tools:` scoping is ignored and
project validators are skipped under `--backend codex` (both documented).
Revisit when the Codex CLI grows the hooks; until then the asymmetry with
claude-code (which does scope tools and run validators) should stay
loudly documented.

### 6. Session listing vs. run listing
A REPL session that only ever ran slash commands (`/orchestrate`, …) is
not persisted until the first chat message, so `kapel sessions` says
"No chat sessions recorded yet" while `kapel runs` shows the run. Nothing
is lost, but the two commands disagree in a way that reads as data loss.
Persist the session at the first slash command, or say so in the output.

## Low impact / hygiene

### 7. Dirty-base guidance for user files
The not-merged event now names the offending paths, and kapel's own
`.agent/` state is exempt. Remaining nicety: when the dirty path is a
real user file, suggest the fix (commit/stash) in the message.

### 8. Flaky tests
Two pre-existing flakes observed during regression runs, each passing in
isolation: `apps/cli/test/history.test.ts` (timing assertion) and
`packages/workspace/test/worktrees.test.ts` (concurrent git-worktree
race). Deflake or mark retryable.

### 9. Tooling deprecations
`biome.json` still uses the deprecated `recommended` field (`biome
migrate` pending). `/compact` remains native-only by design; the
delegating CLIs manage their own context.

### 10. Registry publishing
The README's install path is the committed tarball; `npm publish` of
`@devfallingstar/kapel` (with `prepublishOnly` already wired) would
replace it with a normal `npm install -g @devfallingstar/kapel`.
