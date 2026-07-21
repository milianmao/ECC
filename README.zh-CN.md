# Aster

Aster 是面向 Codex 和 Claude Code 的项目级开发 harness。它提供精选工作流、
审查 agents、需审批的记忆和均衡 hooks，默认不改写用户级配置。

## 快速开始

```powershell
cd "<Aster 克隆目录>"
npm install
npm link
aster init --both
```

单独初始化可使用 `aster init --codex` 或 `aster init --claude`。`aster plan`、
`aster update`、`aster doctor`、`aster memory` 和 `aster uninstall` 都只管理当前
Git 项目；配置与状态分别保存于 `aster.json` 和 `.aster/`。

你现在可以使用 67 个代理、287 个技能和 103 个命令。Aster 默认只把精选内容与
检测到的技术栈支持安装到当前项目。

## 工作流

`harness-start`、`harness-plan`、`harness-implement`、`harness-verify`、
`harness-review`、`harness-debug`、`harness-finish`、`harness-release` 和
`harness-parallel` 覆盖开发、验证、审查与交付流程。

## 验证

```powershell
npm run aster:plugin:build
npm run aster:test
npm test
```

插件是可选增强；项目级初始化不需要安装用户级插件或 marketplace。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
