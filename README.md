# 美食选题工作台

在微信里查看制作类美食选题，支持定时更新、搜索、往期、排序和本机收藏。

这里是唯一项目根目录。源码、规格、规范和 Git 历史已经统一；原 `daily-food-picks` 路径保留为指向这里的兼容链接。

## 开始开发

在 Codex 或 Claude Code 中打开本目录并新建会话。

| 入口 | 用法 |
| --- | --- |
| Codex | `$food-picks-sdd`，然后描述要新建或继续的任务 |
| Claude Code | `/food-picks-sdd`，然后描述要新建或继续的任务 |
| 共同规则 | [AGENTS.md](AGENTS.md)；Claude 的入口自动导入它 |
| 长期原则 | [constitution.md](.specify/memory/constitution.md)，管所有功能共同底线 |
| 完整流程 | [SDD 工作流](docs/workflow.md)，包含功能选择、验证与双工具交接 |

已有会话的技能列表可能仍是启动时的状态；在这个目录重新开会话后使用新入口。

## 正在维护的功能

| 功能 | 入口 |
| --- | --- |
| 微信指定成员试用版 | [需求](specs/001-wechat-member-trial/spec.md) · [任务与待验收项](specs/001-wechat-member-trial/tasks.md) · [运行记录](docs/operations/wechat-trial-runbook.md) |
| 项目目录与开发地基整合 | [需求](specs/002-project-foundation/spec.md) · [任务](specs/002-project-foundation/tasks.md) · [整理记录](docs/operations/project-organization.md) |

实施进度以各功能 tasks 为准，实际云端与手机验收以它引用的运行记录为准。当前功能指针在本地 `.specify/feature.json`，不随 Git 共享。

## 目录怎么找

| 目录 | 内容 |
| --- | --- |
| `miniprogram/` | 微信小程序页面和客户端逻辑 |
| `cloudfunctions/` | 定时采集与授权查询两个云函数 |
| `config/` | 非敏感业务规则和配置样例 |
| `scripts/`、`tests/` | 本地检查、生成副本与行为测试 |
| `specs/` | 按功能保存需求、方案、任务及验收 |
| [docs/standards](docs/standards/README.md) | 代码、测试、Skill 的开发细则 |
| [docs/operations](docs/operations/wechat-trial-runbook.md) | 运行与整理记录 |
| [docs/archive/collection-research](docs/archive/collection-research/README.md) | 早期研究；原始响应和试跑材料只保留本机 |
| `assets/branding/` | 正式头像及生成说明 |
| `.local/` | 私有账号资料、二维码、日志和迁移备份，不提交 |

根目录的 `index.html`、`build.py`、`src/`、`data/`、`test/` 是旧网页兼容结构。它们保留相对位置，方便已有预览继续工作。

## 本地检查

先按[测试与交付](docs/standards/测试与交付.md)选择受影响测试。共享源有变化时生成副本，再检查包结构；前端检查类型使用。

```bash
npm run prepare:functions
npm run check:package
npm run typecheck:mini
```

这些命令不代表云端部署或真机验收。不要通过运行历史试跑脚本、清预算或调高额度来验证目录。

完整资料导航见 [docs/README.md](docs/README.md)。
