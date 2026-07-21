---
name: harness-release
description: Prepare and validate a release candidate through version, changelog, package, build, test, and security checks without publishing it. Use before a package, binary, image, deployment, tag, or other external release; require explicit confirmation before publishing.
---

# Harness Release

Validate the exact artifact that would be released.

## Workflow

1. Identify the release target, version policy, source revision, distribution channel, and repository-defined release process.
2. Inspect Git state, version sources, changelog conventions, CI, packaging configuration, and required credentials without exposing secret values.
3. Confirm the candidate contains only intended changes and that required version and release notes are consistent.
4. Run `harness-verify` with release scope, including applicable tests, build, security, migration, and compatibility checks.
5. Build or package in dry-run or local mode using the project's existing tooling. Inspect the produced file list and metadata for missing files, secrets, and unintended content.
6. Produce the exact publish or deployment command, rollback procedure, and release notes, but do not execute the external release yet.
7. Present a final gate with evidence and request explicit approval for any tag, push, publish, deployment, or remote state change.

Prefer `security-reviewer` for artifact and secret exposure, `doc-updater` for release notes, and `build-error-resolver` for packaging failures.

## Boundaries

- Never publish from an unverified artifact or silently change versions.
- Never print credentials or introduce a new release service without approval.
- Treat dry runs that contact external systems as external actions and obtain approval when required by the runtime.

## Complete When

The candidate artifact, checks, version, notes, publish command, and rollback path are ready, with actual publication still behind explicit user confirmation.
