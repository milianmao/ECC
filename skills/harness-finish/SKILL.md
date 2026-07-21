---
name: harness-finish
description: Close out a development task by reviewing the diff, removing task-local debris, running final verification, updating necessary documentation, and preparing a handoff. Use when implementation and review are complete but before commit, push, or release.
---

# Harness Finish

Leave the task verifiable and easy to hand off.

## Workflow

1. Compare the final diff with the approved scope and acceptance criteria. Preserve unrelated user changes.
2. Remove debugging output, dead task-local code, accidental generated files, and needless duplication introduced by the task.
3. Update existing documentation only when public behavior, setup, operations, or contracts changed.
4. Run `harness-verify` at a scope proportional to the change and confirm blocking review findings are resolved or explicitly deferred.
5. If the project memory pipeline exists, record concise reusable facts as candidates. Never approve candidates or write them directly into approved memory.
6. Produce a handoff with changed behavior, important files, checks run, known limitations, and the next concrete action. Preserve plan and verification records while work remains; clear them with the project-local helper only after the task is confirmed complete.

Prefer `code-simplifier` for task-local simplification, `refactor-cleaner` for proven dead code, and `doc-updater` for required documentation. Skip an agent when its work is not needed.

## Boundaries

- Do not expand cleanup beyond the task or create documentation for unchanged behavior.
- Do not conceal failed or skipped checks.
- Do not commit, push, publish, or release automatically.

## Complete When

The diff matches scope, final checks are reported, no task debris remains, required docs are current, and the handoff names any residual risk.
