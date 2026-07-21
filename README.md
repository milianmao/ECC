# Aster

Aster is a project-local development harness for Codex and Claude Code. It
adds focused workflows, review agents, approval-gated memory, and balanced
hooks without changing user-level configuration by default.

## Quick Start

```powershell
cd "<Aster checkout>"
npm install
npm link
aster init --both
```

Use `aster init --codex` or `aster init --claude` for one target. `aster plan`,
`aster update`, `aster doctor`, `aster memory`, and `aster uninstall` manage
the project-local installation. State is kept in `aster.json` and `.aster/`.

The source catalog provides access to 67 agents, 287 skills, and 103 commands.
Aster installs a curated subset plus detected stack support into the current Git
project.

## Workflows

`harness-start`, `harness-plan`, `harness-implement`, `harness-verify`,
`harness-review`, `harness-debug`, `harness-finish`, `harness-release`, and
`harness-parallel` cover the normal development loop.

| Component | Available |
| --- | --- |
| Agents | 67 agents |
| Commands | 103 commands |
| Skills | 287 skills |

## Project Surface

```text
|-- agents/ # 67 specialized subagents for delegation
|-- skills/ # curated workflows and source material
|-- commands/ # compatibility entry points
|-- plugins/aster/ # self-contained Aster plugin
|-- scripts/aster.js # project-local CLI
```

## Compatibility Surface

| Surface | Claude Code | Codex | OpenCode | Copilot |
| --- | --- | --- | --- | --- |
| Agents | 67 | Shared (AGENTS.md) | Shared (AGENTS.md) | 12 |
| Commands | 103 | Shared | Instruction-based | 35 |
| Skills | 287 | Shared | 10 (native format) | 37 |

## License

MIT. See [LICENSE](LICENSE).
