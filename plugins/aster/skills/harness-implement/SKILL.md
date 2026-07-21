---
name: harness-implement
description: Execute an approved implementation plan in focused, test-backed batches while preserving existing project changes. Use after a plan is approved or when the user explicitly requests implementation of a bounded change.
---

# Harness Implement

Implement the approved behavior with the smallest safe diff.

## Workflow

1. Read the approved plan, including `.aster/state/current-plan.md` when present, repository instructions, current Git status, and affected code before editing.
2. Confirm each batch has a clear outcome, owned file scope, and runnable check. Preserve unrelated and user-authored changes.
3. For non-trivial behavior, add or update the smallest test that fails for the missing behavior.
4. Implement the root behavior using existing helpers, platform features, and installed dependencies before adding abstractions.
5. Run the focused test or check after each batch. Diagnose failures at their shared cause instead of adding per-caller patches.
6. Re-read the diff for accidental scope growth, unsafe input handling, missing errors, and compatibility breaks.
7. Continue until every approved plan item is complete, then hand off to `harness-verify`.

Keep resumable progress in the project-local plan record only when the harness is initialized. This record is ignored task state, not approved memory.

Prefer `tdd-guide` for behavior changes, `code-architect` only for cross-boundary implementation, and `build-error-resolver` for actual build or type failures. A delegated writer must have exclusive file ownership; otherwise work sequentially.

## Boundaries

- Do not overwrite unrelated changes or rewrite tests merely to make failures disappear.
- Do not add speculative abstractions, dependencies, configuration, or documentation.
- Do not commit, push, publish, or release unless the user separately requests it.
- Stop and report when the approved plan conflicts with repository truth or requires a new material decision.

## Complete When

Every in-scope plan item is implemented, focused checks pass, and the remaining work is verification rather than unfinished coding.
