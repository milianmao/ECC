---
name: harness-debug
description: Reproduce a failure, trace it to the shared root cause, implement the smallest authorized fix, and add regression coverage. Use for bugs, flaky tests, silent failures, crashes, incorrect output, or unexplained build and runtime errors.
---

# Harness Debug

Turn a symptom into a reproducible, regression-tested fix.

## Workflow

1. Capture expected behavior, actual behavior, environment, inputs, and the shortest known reproduction.
2. Reproduce the failure before editing. If reproduction is impossible, gather logs and invariants, state what is missing, and avoid speculative changes.
3. Trace the failing path through callers, shared helpers, boundaries, and recent relevant changes. Form one falsifiable hypothesis at a time.
4. Add the smallest regression check that fails for the root cause when the project has a suitable test surface.
5. Fix the shared cause with the smallest safe change. Preserve unrelated work and avoid one-off guards in every caller.
6. Rerun the reproduction, regression check, affected sibling paths, and relevant broader checks.
7. Report the root cause, why the fix addresses it, evidence, and any remaining uncertainty.

Prefer `code-explorer` for execution-path tracing, `silent-failure-hunter` for swallowed or misleading failures, and `tdd-guide` for regression coverage. Delegate only independent investigation paths; a single owner applies the fix.

## Boundaries

- Do not weaken assertions, suppress errors, or change expected behavior solely to make a test pass.
- Do not combine unrelated cleanup with the fix.
- Do not claim a root cause until evidence distinguishes it from correlated symptoms.

## Complete When

The original failure is reproducible before the fix, absent after it, protected by a regression check when feasible, and relevant sibling behavior remains valid.
