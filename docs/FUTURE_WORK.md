# Future work

Known gaps as of the post-v0.8.2 future-work batch. Everything the original
v0.8.2 list contained has shipped except the items below; the shipped set is
recorded at the bottom so the history stays legible.

## Remaining

### 1. Image attachments on delegated backends
`@` mentions attach real image bytes on the native backend. The delegated
chat contract (`BackendTurnRequest` → `backendTurnRunner`) has no attachment
channel: Claude Code's `-p` refuses image input outright, and while the
Codex CLI's `-i <path>` could carry one, wiring it means extending the turn
contract for one of two backends. The seam is documented on
`BackendTurnRequest` in `packages/coding-agent/src/backend-chat.ts`; until
then the REPL says so in one line and sends the path.

### 2. Codex tools-scoping fidelity
Codex's only access-control knob is `--sandbox` (`read-only` /
`workspace-write` / `danger-full-access`), which gates the whole subprocess
rather than one named tool the way the native loop's `tools:` matching or
Claude Code's `--allowedTools` can. `codexToolScopingFor` in
`packages/coding-agent/src/workers/codex-executor.ts` maps what it can: an
agent whose `tools:` grants none of `write_file`/`edit_file`/`bash` runs
under `--sandbox read-only`, a faithful (if coarse) match for "look, don't
touch". Anything else — a restriction that keeps some but not all of those —
has no sandbox equivalent at all, so the task runs under the run's normal
sandbox and the run emits a `backend.tool_scoping_unsupported` warning
(once per agent, not once per task) naming the agent whose scoping is not
enforced. That is the parity gap that remains: not silent, as it was before,
but still approximate rather than exact. Revisit if the Codex CLI ever grows
a per-tool allowlist.

## Shipped since the original list (post-v0.8.2 batch)

- **Validators under `--backend codex`** — the codex carve-out in
  `shouldRunValidators` (`apps/cli/src/orchestrate.ts`) is gone: a codex task
  is gated on the project's configured validators exactly like a native or
  claude-code one, since `ValidatingExecutor` never needed a hook inside the
  worker loop to begin with — it runs the commands against the task's own
  checkout after the worker returns, which for a delegated backend is simply
  after the CLI subprocess has exited.

- **Image attachments in the REPL** — `@` mentions of image files attach the
  bytes (4 per turn, 5 MiB each), with graceful degradation to path mentions.
- **Worker token usage attribution on delegated backends** — CLI-reported
  worker usage lands in the ledger per task/agent; the rollup no longer shows
  `0 tasks` next to a completed delegated run.
- **Validators as the check gate** — `kapel init` detects the repo's
  typecheck/test/lint scripts and seeds an enabled `validation:` block; the
  worker prompts and briefing now say validators verify the change.
- **Compile-time warning for orchestrator-role targets** — a routing or
  escalation rule targeting an orchestrator-role agent warns at
  `policy compile`/`diff`.
- **Session listing** — sessions appear in `kapel sessions` from the first
  `/orchestrate` or `/resume-run`, titled from the objective.
- **Dirty-base guidance** — the not-merged detail names the paths and the
  remedy (commit/stash, or gitignore generated files).
- **Deflaking** — the history test now waits for the settled post-trim state;
  a real concurrent `git worktree add` race in `create()` is retried on its
  known-transient signature only.
- **Tooling** — biome.json migrated to `preset: "recommended"` (not the
  ruleset-disabling `"none"` that `biome migrate` emitted).
- **Registry publishing** — already live: `.github/workflows/release.yml`
  publishes `@devfallingstar/kapel` with provenance on every release push
  (trigger: `.release` changes on main, `v*` tags, or manual dispatch),
  using the repo's `NPM_TOKEN` secret. README now leads with the registry
  install.
