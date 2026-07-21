---
name: harness-review
description: Review a diff, branch, pull request, or bounded file set for correctness, regressions, security, and test gaps. Use after code changes or before merge; report actionable findings first and remain read-only unless fixes are explicitly requested.
---

# Harness Review

Review behavior, not formatting preferences.

## Workflow

1. Resolve the review scope from the supplied target or current diff. If there are no changes, say so and stop.
2. Read repository instructions, the complete changed files, relevant callers, tests, and contracts; do not rely on isolated diff hunks.
3. Check correctness, edge cases, error handling, compatibility, security boundaries, concurrency, performance hazards, and meaningful missing tests.
4. Validate suspected findings against the actual execution path. Do not report speculation as a defect.
5. Order findings by severity and include a tight file and line reference, impact, triggering scenario, and concrete remediation.
6. Merge duplicate findings from multiple reviewers and separate blocking defects from optional improvements.
7. If the user authorized fixes, apply only the required changes and send them through `harness-verify`; otherwise remain read-only.

Prefer `code-reviewer` for correctness, `security-reviewer` for exposed trust boundaries, and `pr-test-analyzer` for test gaps. Run reviewers in parallel only when scopes are independent, with no more than three direct agents.

## Output

List findings first, highest severity first. Then state open questions and the validation or test gaps. If no actionable findings exist, say so and identify residual risk.

## Complete When

Every finding is evidence-backed and deduplicated. When fixes were in scope, blocking findings are fixed or explicitly deferred and affected checks have been rerun.
