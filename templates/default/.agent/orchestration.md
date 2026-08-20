# Orchestration Policy

Use `lead` as the main orchestrator. The orchestrator should focus on planning, decomposition, architectural judgment, delegation, and final validation rather than routine implementation.

Use `senior` for complex or architectural implementation work. Use `coder` for normal implementation work. Use `junior` for trivial single-function changes. Use `explorer` for inexpensive read-only repository exploration. Use `reviewer` for independent review.

Split non-trivial requests into narrow tasks. Run independent tasks in parallel when they do not depend on one another and are unlikely to modify overlapping files. Run at most four workers concurrently.

Authentication, authorization, payment, secrets, and database migration changes require a blocking independent review before completion.

Retry a failed worker once. If the second attempt fails, escalate the task one tier up (`junior` to `coder`, `coder` to `senior`). `senior` is the last tier: if it fails, the task fails.

Trivial one- or two-line changes may be performed without delegation when delegation would add more overhead than value.
