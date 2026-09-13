# Quickstart: 验证统一项目

所有命令在统一主目录运行，均为本地检查，不触发收费采集。

## 根目录与功能

```bash
git rev-parse --show-toplevel
bash .specify/scripts/bash/check-prerequisites.sh --json --paths-only
bash .specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```

在旧 daily-food-picks 入口和 miniprogram 子目录用对应相对路径调用只读路径检查，应定位到同一项目。显式选择另一功能使用 SPECIFY_FEATURE_DIRECTORY；只读 --paths-only 不改默认指针。

新工作树不会带入本地 feature.json。未选择功能时路径检查应明确报缺少功能；显式指定 001 后应成功，不能通过跟踪本地指针来掩盖这个情况。新功能从 specify 开始。

## 现有运行结构

```bash
npm run prepare:functions
npm run check:package
npm run typecheck:mini
```

生成命令只刷新源文件的部署副本。包检查不得把新增文档或私有数据打入小程序。

## 两种开发工具

在主目录新开会话。Codex 可调用 $food-picks-sdd，Claude Code 可调用 /food-picks-sdd。

分别提出：继续已有微信试用任务、讨论一个新功能、仅解释项目目录。应使用相同原则与功能材料，讨论时不开始实施，已有授权不重复请求。

Claude Code 可用 /context 检查记忆文件，确认 CLAUDE.md 及其导入的共同规则；新旧会话加载状态应区分记录。

## 完整性与私有边界

迁移清单逐一验证原文件的新位置和摘要；有意修订只限规范、路径和状态说明。
使用 git check-ignore 核对 .env.local、.local、原始试跑、参考响应和本地 feature 指针。
检查实际差异，业务源码、配置值、旧网页和测试内容不得有未说明变化。
