# Contributing to kapel

kapel is a multi-model orchestration coding agent: a strong model plans,
cheaper or specialized models execute, and a deterministic runtime enforces
a natural-language orchestration policy compiled to a structured form. This
document covers the mechanics of working on it. For the "why" behind the
architecture, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
rest of `docs/` before making a structural change.

## Development setup

Requires **Node.js >= 20** (see `engines` in `package.json`).

```bash
npm install
npm run build
```

`npm run build` runs `tsc -b` across the workspace (`apps/*`, `packages/*`).
Once built, run the CLI directly from its compiled output:

```bash
node apps/cli/dist/index.js
```

There is also a bundled, single-file build (`npm run bundle`, via
`scripts/bundle.mjs`) used for packaging releases — you generally don't need
it for day-to-day development.

## Monorepo layout

This is an npm-workspaces monorepo:

- `apps/cli` — the `kapel` CLI/REPL entry point (`@agent/cli`).
- `packages/*` — the runtime, split by responsibility: `ai` (provider/model
  abstraction), `core`, `policy` (natural-language compiler, Policy IR),
  `orchestration` (planner, task graph, router, scheduler), `coding-agent`
  (the user-facing runtime facade, tools, workers), `workspace` (git/worktree
  isolation), `session` (SQLite/Drizzle persistence), `protocol` (typed
  events), `plugin`, `tui` (Ink-based UI).

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how these fit
together (control plane, policy plane, execution plane, provider boundary,
event boundary). [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) and
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) record the
original design intent and milestone history; `docs/UX_ROADMAP.md` and
`docs/FUTURE_WORK.md` track known gaps. Korean originals of the translated
docs live under `docs/ko/`.

## Running tests

```bash
npx vitest run
```

The root `vitest.config.ts` raises `testTimeout`/`hookTimeout` to 30s,
because the suite runs many files in parallel and a starved worker can blow
past vitest's 5s default on a small CI runner — this is a concurrency-load
accommodation, not a license to write a slow test. The suite is large (well
into the thousands of tests); add tests alongside the code they cover
(`*.test.ts` next to `src/*.ts` in each package), and prefer fakes/fixtures
over hitting real provider APIs — see the `Fake deterministic provider`
pattern used across `packages/policy/test` and `packages/orchestration/test`.

## Linting and formatting

```bash
npx biome check .
npx biome format --write .
```

Biome is configured with the `recommended` rule preset
(`biome.json`) — don't disable rules wholesale to work around a warning; fix
the code or, if the rule genuinely doesn't apply, scope a narrow suppression
to the line in question.

## TypeScript strictness

`tsconfig.base.json` turns on `strict`, plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`useUnknownInCatchVariables`, and `verbatimModuleSyntax`. In practice this
means:

- **Avoid `any`.** It does not appear anywhere in this codebase's source as
  a type annotation. Model an unknown shape with `unknown` and narrow it, or
  give it a real (possibly generic) type.
- **No TODO comments.** A comment explains a decision that was made, not a
  decision deferred. If something is a known limitation, document it as
  such — see `docs/FUTURE_WORK.md` for the project's own running list of
  known gaps — rather than leaving a `// TODO` in source.
- **Comments explain *why*, and cite the problem that motivated the code**,
  not what the code does line by line. For example, `scheduler.ts`'s class
  doc doesn't just describe rolling concurrency — it walks through why an
  escalation rule has to *grant* an extra attempt (a task with
  `defaultMaxAttempts: 2` and an escalation rule keyed on `afterFailures: 2`
  would otherwise never reach a rule that only becomes true after the last
  attempt is spent), and calls out the two deliberate exceptions to that
  grant. `vitest.config.ts`'s comment on `testTimeout` similarly explains
  *why* the timeout was raised (parallel-file load-induced flakiness on
  small runners), not just that it was raised. Match that standard: a
  reviewer reading the comment alone should understand the constraint that
  forced the design, not just get a restatement of the code beneath it.
- Indexed access and optional properties are checked strictly on purpose —
  don't add a non-null assertion (`!`) or a type cast to silence a strict
  error without first checking whether the underlying logic actually
  guarantees what you're asserting.

## Commits and pull requests

- Keep commits focused; a commit message should explain the reasoning
  behind a change, not just restate the diff.
- A PR should pass `npx vitest run`, `npx biome check .`, and
  `npm run typecheck` (`tsc -b --pretty false`) before it's ready for
  review.
- If a change affects behavior documented in `docs/` (architecture,
  milestones, UX decisions, the smoke-test procedure), update the relevant
  doc in the same PR — these files are treated as living design records,
  not one-time write-ups.
- Design rationale — why the architecture looks the way it does, what was
  considered and rejected, what's explicitly out of scope — belongs in
  `docs/`, not in code comments or PR descriptions alone. Start with
  `docs/ARCHITECTURE.md`, `docs/PROJECT_PLAN.md`, and `docs/UX_ROADMAP.md`.
