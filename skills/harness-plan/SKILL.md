---
name: harness-plan
description: Ground requirements in an existing codebase and produce a decision-complete implementation plan without changing code. Use for features, refactors, migrations, or other non-trivial work that needs approval before implementation.
---

# Harness Plan

Turn a request into an implementation-ready plan.

## Workflow

1. Restate the goal, audience, success criteria, scope, and constraints from the supplied request or artifact.
2. Inspect repository instructions, relevant entry points, callers, tests, manifests, and nearby implementations. Cite real patterns; state when none exist.
3. Resolve discoverable facts from the repository. Ask only about decisions that materially change behavior, compatibility, or scope.
4. Choose the smallest approach that satisfies the request and matches existing architecture.
5. Specify behavior and any changed interfaces, data flow, persistence, compatibility, failure handling, and migration or rollback needs.
6. Break implementation into ordered, independently verifiable steps with affected areas and validation commands.
7. Include test scenarios, risks, acceptance criteria, and explicit assumptions.

Prefer `code-explorer` for repository evidence, `architect` for cross-boundary design, and `planner` for the final sequence. Use no more agents than the task requires and continue inline if a role is unavailable.

## Output

Return a concise plan containing:

- Summary and chosen approach.
- Ordered implementation changes.
- Public interface or data changes, or `None`.
- Test and acceptance scenarios.
- Risks, rollback needs, assumptions, and deferred work.

Do not modify code, install dependencies, or change Git state. Do not begin `harness-implement` until the user approves the plan.

After approval, the caller may persist the exact plan to `.aster/state/current-plan.md` with the project-local record helper. Do not write an unapproved draft there and do not copy it into approved memory.

## Complete When

An implementer can execute the plan without making unresolved product or architecture decisions.
