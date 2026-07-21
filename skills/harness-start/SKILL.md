---
name: harness-start
description: Restore project context, inspect repository state, load only approved project memory, and choose the next development workflow. Use when starting or resuming work in a project, after compaction, or when the current task state is unclear.
---

# Harness Start

Prepare a reliable task brief before planning or editing.

## Workflow

1. Parse the supplied task, scope, or artifact. If none is supplied, infer the active task only from durable project state; otherwise ask for the goal.
2. Read repository instructions and relevant project documentation.
3. Inspect Git status and recent relevant history without changing the worktree. Treat existing changes as user-owned.
4. Detect the technology stack from tracked manifests, configuration, source layout, and test tooling.
5. Read resumable state under `.aster/` when present. Treat `state/current-plan.md` and `state/verification.jsonl` as task records, not memory. Load only `memory/approved.md` as memory, never candidates or rejected entries, and honor the configured injection limit.
6. Locate the smallest set of files, tests, and existing patterns needed for the task.
7. Produce a task brief with objective, current state, constraints, risks, unresolved decisions, and the recommended next workflow.

Prefer `code-explorer` for repository mapping, `spec-miner` for recovering behavior, and `planner` for shaping the brief. Delegate only when those roles exist and the work benefits from it; otherwise run the steps inline.

## Boundaries

- Do not modify files, dependencies, Git state, or approved memory.
- Do not treat stale plans or memory as authoritative over the current request.
- Do not inject task records into long-term memory or promote them without explicit memory approval.
- Do not load unrelated skills or scan the whole repository when targeted retrieval is enough.

## Complete When

The objective, relevant state, constraints, risks, and next workflow are explicit. Recommend `harness-debug` for a reproducible failure, `harness-plan` for non-trivial design work, `harness-implement` for an approved plan, or `harness-verify` for completed changes.
