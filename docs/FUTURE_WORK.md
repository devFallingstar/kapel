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

### 2. Codex parity limits
Codex owns its sandbox, so per-agent `tools:` scoping is ignored and project
validators are skipped under `--backend codex` (both documented). Revisit
when the Codex CLI grows the hooks; until then the asymmetry with
claude-code (which scopes tools and runs validators) stays loudly
documented.

## Shipped since the original list (post-v0.8.2 batch)

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
