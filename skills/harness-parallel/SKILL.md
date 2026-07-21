---
name: harness-parallel
description: Split a development task into independent agent assignments with explicit ownership, bounded concurrency, and parent integration. Use when two or more workstreams can proceed without overlapping writes; keep sequential work inline when dependencies or ownership cannot be separated.
---

# Harness Parallel

Parallelize only work that is genuinely independent.

## Workflow

1. Decompose the request into deliverables and map dependencies before spawning agents.
2. Keep dependent steps sequential. If fewer than two assignments can run independently, use the appropriate single workflow instead.
3. For each assignment, define its objective, inputs, owned files or read-only scope, acceptance criteria, validation, and expected handoff.
4. Reject overlapping write scopes. Shared files belong to the parent integrator or one named writer; read-only investigation may overlap.
5. Launch at most three direct child agents. Set recursion depth to one: child agents must not spawn more agents.
6. Continue useful parent work while children run, then collect every result before integration.
7. Reconcile assumptions, inspect combined changes, resolve conflicts centrally, and run checks that cover interactions between workstreams.

Choose the narrowest role for each assignment, such as explorer, implementer, reviewer, security reviewer, test analyzer, or documentation updater. Do not add an agent merely to fill all three slots.

## Handoff Contract

Require each agent to report:

- Outcome and acceptance status.
- Files read or changed.
- Commands and results.
- Risks, assumptions, and unresolved blockers.

## Complete When

All agents have returned, write ownership remained disjoint, parent integration is complete, combined checks pass or are explained, and one consolidated result is reported.
