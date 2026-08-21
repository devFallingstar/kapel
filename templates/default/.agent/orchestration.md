# Orchestration Policy

<!-- kapel:policy v1 -->

This file is kapel's canonical policy form: `kapel policy compile` reads
it without calling a model. Edit it here or through `kapel policy edit`.
Rewriting it in your own prose is fine too — kapel then falls back to
compiling it with a model, which is what the marker line above turns off.

## Orchestrator

Use `lead` as the main orchestrator.

## Execution

- Run at most 4 agents at a time.
- Independent tasks may run in parallel.
- Give each task 2 attempts before giving up.

## Routing

- `architectural-work`: always route tasks of complex and architectural complexity to `senior`.
- `routine-work`: always route tasks of normal complexity to `coder`.
- `trivial-work`: always route tasks of trivial complexity to `junior`.
- `exploration`: always route `exploration` tasks to `explorer`.
- `independent-review`: always route `review` tasks to `reviewer`.

## Review

- `sensitive-change-review`: `reviewer` reviews tasks touching `auth`, `authorization`, `payments`, `secrets` and `migrations`; blocking, required.

## Escalation

- `junior-to-coder`: hand off from `junior` to `coder` after 2 failed attempts.
- `coder-to-senior`: hand off from `coder` to `senior` after 2 failed attempts.
