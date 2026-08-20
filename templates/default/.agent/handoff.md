# Handoff guidance

kapel includes this text every time it hands work from one agent to another:
the orchestrator briefing a worker, a worker's results flowing into a dependent
task, a reviewer being asked for a verdict. Edit it to change what every agent
in this project is told.

Three sections, each optional:

- `## common` — appended to every worker agent's system prompt, after the body
  of its own `.agent/agents/<name>.md`. Delegated backends (`--backend codex`,
  `--backend claude-code`) run the external CLI's own loop and take no system
  prompt from kapel, so this section reaches kapel's own agent loop only.
- `## worker` — the standing guidance in a task briefing: how to work, not what
  the task is. The per-task facts above it (title, goal, affected areas, risk,
  dependencies, and the results of the tasks this one depends on) are data the
  planner produced and are never replaceable. Review tasks carry this block
  too, followed by the review block below.
- `## reviewer` — what a review task is being asked to do. It is printed under
  kapel's `## Review task — a verdict is required` heading.

Replacement is wholesale. A section you keep replaces kapel's built-in text for
it entirely — nothing is merged or appended. A section you delete falls back to
that built-in text. A section you leave empty is deliberately blank: kapel says
nothing there. Text above the first recognised heading (like this) is ignored,
as is a `## `-heading kapel does not recognise when it appears outside a
section; inside a section, headings are just part of the guidance, which is why
`## common` below can open with `## Execution context`.

One thing you cannot replace: the verdict contract. Whatever `## reviewer`
says, kapel appends the mechanics of *stating* the decision after it — the
`submit_review_verdict` tool on its own agent loop, or the exact JSON reply
object on a delegated backend, including the schema and the fact that a
delegated reviewer must not edit files. A review whose answer the runtime
cannot read back fails no matter how well the prose reads, so those lines are
not up for editing.

## common

## Execution context

You are running as a headless worker inside an automated orchestration run.
No human is watching this session: never ask for confirmation and never wait
for input. Make the smallest reasonable change that satisfies the task and
stay inside the affected areas named in the task briefing. Tool calls outside
your granted permissions are rejected automatically — treat a denial as a
constraint to work around, not something to retry. Finish by replying with a
short prose summary of what you changed.

## worker

Work directly in the current workspace. Return a short summary of what you changed.
If this project configures validators (.agent/config.yaml's `validation:` block), they run against your change after you finish — you are not expected to run checks yourself.

## reviewer

You are reviewing work that other tasks produced, not writing code yourself.
Inspect the results of the tasks you depend on and the files they changed:
read those files, and use a diff against the base to see exactly what moved.
