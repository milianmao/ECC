---
name: harness-verify
description: Detect and run the relevant project checks, then report exact evidence, failures, and skipped coverage. Use after implementation, before handoff or release, or whenever claims about build, test, lint, type, security, or end-to-end health must be verified.
---

# Harness Verify

Prove the current state with repository-defined checks.

## Workflow

1. Determine scope from the supplied paths, plan, diff, or current task.
2. Read manifests, CI configuration, and contributor instructions to discover real commands. Do not guess scripts or install missing tools.
3. Select applicable checks: formatting in check-only mode, lint, type checking, focused tests, broader tests, build, integration or end-to-end tests, and security scans.
4. Run the cheapest relevant checks first. Escalate to broader checks when risk, shared code, or release scope justifies them.
5. Record each exact command, exit result, and concise evidence. Distinguish `passed`, `failed`, and `skipped`; give a reason for every skip. When the project harness is initialized, append the bounded result to `.aster/state/verification.jsonl` through its local helper.
6. Investigate failures enough to separate code defects, environment gaps, and unrelated pre-existing failures. Never report an unrun check as passing.
7. If fixes are authorized, use `harness-debug` or `harness-implement`, then rerun the failed and dependent checks.

Prefer `pr-test-analyzer` for coverage selection, `e2e-runner` for real user flows, and `build-error-resolver` for build or type failures. Keep independent read-only checks bounded and avoid duplicate runs.

## Output

Report scope, commands, results, failure causes, skipped checks, and residual risk. Include the shortest reproduction command for each failure.

Verification records are task evidence. Never inject them as approved memory or store credentials, environment secrets, or full command output in them.

## Complete When

All applicable checks pass, or every failure and skip is explicitly explained with its impact and next action. A partial run must be labeled partial.
