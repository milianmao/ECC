# Aster

Aster 为 Codex 和 Claude Code 提供项目级工作流、审查 agents、审批记忆与 hooks。
默认初始化只写入当前 Git 项目。

```powershell
aster init --both
```

你现在可以使用 67 个智能体、287 项技能和 103 个命令了。Aster 只启用精选内容和
当前项目需要的技术栈支持。

| 组件 | 可用内容 |
| --- | --- |
| 智能体 | 67 个 |
| 命令 | 103 个 |
| 技能 | 287 项 |

| 表面 | Claude Code | Codex | OpenCode | Copilot |
| --- | --- | --- | --- | --- |
| 智能体 | 67 | 共享 (AGENTS.md) | 共享 (AGENTS.md) | 12 |
| 命令 | 103 | 共享 | 基于指令 | 35 |
| 技能 | 287 | 共享 | 10 (原生格式) | 37 |

项目状态保存在 `aster.json` 与 `.aster/`。使用 `aster --help` 查看完整命令。

## 许可证

MIT，详见仓库根目录的 [LICENSE](../../LICENSE)。
