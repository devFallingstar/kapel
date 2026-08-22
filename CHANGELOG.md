# Changelog

All notable changes to this project are documented in this file, newest
release first. Each entry is reconstructed from the project's `.release`
file and the commit that shipped it.

This history begins at v0.5.0 — that is the earliest release note recorded
in git; the repository's tracked history spans three days (2026-08-19
through 2026-08-21), so all dates below fall in that range.

## [0.15.0] - 2026-08-21

An edited policy keeps up with itself: a lock that no longer describes
`.agent/orchestration.md` is now a state kapel handles rather than an error
it reports, so editing a canonical policy in your editor costs nothing and
needs no command — the next startup re-reads it — while a policy rewritten
as prose is still deferred to the `/plan` or `/orchestrate` that asks for
it.

- A stale lock's status becomes its own state, `needs-refresh`, rather than
  the previous `ready`.
- `setupCallsModel` prices the recompile and `allowModel` decides whether it
  runs now, so a canonical-policy edit is read for free at the next startup.
- An unreadable lock lands in the same `needs-refresh` state, for the same
  reason: whatever is in that file, it is not this policy, and compiling
  makes it so.
- Smoke test coverage for the editor round trip, both canonical and prose.

## [0.14.1] - 2026-08-21

No model call before you ask for work: opening the REPL runs only the free
half of project setup, and a policy that would need an LLM to compile is
deferred to the `/plan` or `/orchestrate` that actually wants one,
announced in a single line rather than spent silently.

- `ensure` now takes `allowModel`; startup passes `false` and runs only the
  free half of setup, while `/plan` and `/orchestrate` pass `true`.
- A deferred compile is announced once per session and does not settle
  setup — the following `/plan` gets its own chance to compile.
- Audited the rest of startup for the same problem: backend probes
  (`--version`, `auth status`) and model resolution only read credentials,
  they never call a model.

## [0.14.0] - 2026-08-21

A policy you can read without a model: `.agent/orchestration.md` gains a
canonical form that `kapel policy compile` parses instead of compiling, so
a fresh project sets itself up with no model call and no provider
credential at all.

- `kapel policy edit` and `/policy` edit the policy IR directly and write
  both the file and its lock, leaving nothing to compile.
- A policy written as prose still compiles through an LLM exactly as
  before — now a choice made by writing prose, not the price of having a
  project.
- Smoke test coverage for the canonical compile and the `/policy` editor.

## [0.13.0] - 2026-08-21

The input band: the transcript flows between the dashboard and an input
area pinned at the bottom of the screen, bounded by soft-gray rules with no
prompt text, with submitted messages echoed into the transcript as gray
bars.

- Includes a root-cause fix for Node readline's paste path skipping
  deferred-wrap resolution.

## [0.12.0] - 2026-08-21

Conversational approvals, a live slash-command menu, and sky-blue chrome.

- Approval prompts take an answer in prose — declining with feedback
  continues the turn conversationally, rather than only accepting y/n/a.
- A live slash-command menu narrows as you type.
- The REPL wears sky-blue chrome: a titled dashboard border, an accent
  prompt band, and notice gutter bars.
- Ctrl-C prompt-buffer fixes.

## [0.11.0] - 2026-08-21

Clean-screen sessions, curated pickers, and a styled REPL.

- Alternate-screen sessions hand the terminal back on every exit
  (`--no-altscreen` opts out).
- Curated model pickers with pinned recommendations and an arrow-key
  selection fix.
- A per-agent summary table prints after every run.
- Role-based styling across the REPL, with `NO_COLOR` support.

## [0.10.1] - 2026-08-20

Fresh projects set themselves up without asking: opening the REPL in a
repository with no `.agent/` runs `init` and the policy compile immediately
with a one-line announcement instead of a question; `--no-setup` and piped
runs still opt out.

## [0.10.0] - 2026-08-20

Multiple backends at once.

- Multi-select setup with a backend+model pair per role, and mixed
  per-agent execution across backends in the same run.
- Per-directory config overrides.
- Login checks with on-the-spot `codex login` and `claude auth login`,
  plus `/login`.
- Automatic project setup on first run.
- A startup dashboard with `/stats`, backed by persisted usage history.

## [0.9.0] - 2026-08-20

Images everywhere, customizable handoff guidance.

- Image attachments work on every backend through `@` mentions (bytes on
  native, `-i` paths on Codex, read-the-path on Claude Code).
- Customizable handoff guidance via `.agent/handoff.md`.
- Delegated worker usage attribution.
- `kapel init` seeds enabled validators from the repo's own scripts.
- Compile-time warning for orchestrator-role routing targets.
- Slash-only sessions are listed; a concurrent worktree-add race is fixed.

## [0.8.2] - 2026-08-20

Escalation stops at senior: the default escalation ladder now ends at
senior — a senior failure fails the task instead of dispatching the
tool-less orchestrator agent as a worker, which under a delegated backend
ran unscoped and stalled on an approval prompt.

- Adds `docs/FUTURE_WORK.md`, the collected follow-ups from the v0.8.0
  field test and v0.8.1 regression pass.

## [0.8.1] - 2026-08-20

Field-test fixes: every defect the v0.8.0 field test found.

- Variadic `--allowedTools` and `--add-dir` no longer swallow the prompt.
- kapel's own `.agent/` state no longer blocks merges (`init` seeds
  `.gitignore`).
- Chat turns render correctly against Claude Code 2.x streaming.
- Blocking reviews are made real on delegated backends (specificity-aware
  routing to the reviewer, plus a JSON verdict contract the executors
  enforce).
- Escalation ladders are reachable; the `"default"` model sentinel stays
  out of `--model`; partial task results are counted in `kapel runs`.
- All eight fixes were re-verified against the original failing scenarios,
  live (real Claude Code CLI, keyless) and mocked.

## [0.8.0] - 2026-08-19

REPL-first — breaking change: one-shot commands and flags are removed
(`exec`/`plan`/`orchestrate`/`resume`/`worker`, `-i`, `-y`, global `--json`,
`--system`, `--sandbox`, `--worker-mode`, `--dry-run`,
`--max-iterations`).

- `/plan`, `/orchestrate`, `/runs`, and `/resume-run` now live in the REPL.
- Removed input gets a terse unknown-command error.
- The backend auto-detects when nothing is configured.

## [0.7.0] - 2026-08-19

Delegated backends end to end.

- Per-agent model routing on Codex and Claude Code workers.
- Keyless planning and policy compilation through the delegating CLI
  backends.
- Ungated model choices with run-time access hints.
- Three worker tiers: complex, middle, low.
- Merged with the v0.6.0 P1 UX batch.

## [0.6.0] - 2026-08-19

P1 UX batch: cost attribution, `/undo`, `@` mentions, permission config,
custom commands, sessions, images, piped stdin, policy authoring.

- Per-worker/per-model cost attribution and a `/cost`-style breakdown.
- `/undo` — interactive checkpoints via temp-index git snapshots (untracked
  files included, `.agent/` and ignored paths excluded), up to 20 per
  session.
- `@` file mentions and `/` autocomplete in the REPL.
- Custom slash commands via `.agent/commands/*.md`, with `model`/`agent`
  frontmatter.
- Permission rules exposed as a config file (`~/.kapel/config.json`,
  `.agent/config.yaml`).
- Piped input reconciled with non-interactive mode.
- Policy-authoring UX: source-line ambiguity reporting, `policy diff`,
  routing rationale before execution.
- Session naming and forking; one-shot image attachments.
- Fixed a history-test teardown race (`ENOTEMPTY`) that had failed the
  initial v0.6.0 release run.

## [0.5.0] - 2026-08-19

P0 UX: streaming, status line, compaction, `AGENTS.md`, routing
attribution, y/n/a approvals with diffs.

- Turn streaming and a live progress display (spinner, elapsed time,
  cumulative tokens) instead of a dead screen while a turn runs.
- Context compaction wired into both the interactive and one-shot paths,
  plus a manual `/compact` command.
- Three-way approval UX (`y`/`n`/`a`) with session-scoped memory of
  allowed tools/command prefixes, and real diffs shown before an edit is
  approved.
- Project and user instruction files (`AGENTS.md`) loaded into the system
  prompt.
- Routing rationale and the resolved model surfaced live during a run,
  not just after the fact via `explain`.
