# Implementation Plan: 统一目录与双工具 SDD 开发地基

**Branch**: 沿用 feature/wechat-member-trial，不推送或合并
**Date**: 2026-09-13
**Spec**: [spec.md](spec.md)
**Status**: 四阶段均已完成；原业务功能选择已恢复。验证与保留边界见[整理记录](../../docs/operations/project-organization.md)。

## Summary

保留“美食博主工作台”为唯一主目录，将现有源码和 Git 历史迁入。
原 daily-food-picks 目录替换为指向主目录的兼容链接。
长期原则进入 constitution，细则进入 docs/standards，两个工具共享 AGENTS 和项目开发 Skill。

## Technical Context

- 现有源码干净，只有一个 Git 工作树；迁移基线为 a42e7d6c787f。
- .specify/integration.json 已安装 claude 和 codex；调用分隔符均为短横线。
- Spec Kit 1.0.6 按 feature.json 或显式功能目录定位，不要求重命名现有分支。
- 备份已包含两目录的原始文件和 Git 元数据，记录 2,105 个文件摘要；node_modules 原位搬迁不重复备份。
- 无应用接口、数据库、部署配置或收费逻辑变更；不运行历史采集与私有维护脚本。

## Constitution Check

- 同一事实源：主目录共同维护 specs、规范、代码；工具入口不复制规则。
- 边界与行为：业务文件内容保持一致；旧网页相对结构不变。
- 证据：迁移前后摘要、Git 历史、路径、链接、忽略规则和现有本地检查均实际核对。
- 权限与费用：私有配置、原始响应、二维码和日志保持忽略；无生产写入与收费验证。
- 按风险协作：迁移和新开发入口进行独立审查，问题修复后复审。

## Project Structure

```text
美食博主工作台/
  README.md / AGENTS.md / CLAUDE.md
  .git/ .specify/ .agents/skills/ .claude/skills/
  specs/
    001-wechat-member-trial/
    002-project-foundation/
  docs/
    workflow.md
    standards/                 开发细则
    operations/                运行记录
    archive/collection-research/  早期研究与本机试跑档案
  assets/branding/             头像与生成说明
  miniprogram/ cloudfunctions/ config/ scripts/ tests/
  .local/                     私有操作资料、预览和迁移备份
  index.html build.py src/ data/ test/  旧网页兼容文件
```

## Four Delivery Phases

1. **记录与备份**：保留原 feature 指针、Git 状态、两目录文件摘要与副本；准备迁移映射，拒绝未知同名冲突。
2. **统一根目录**：逐项移动源码（包含 .git、依赖和私有工作资料），合并 .gitignore；原源码目录确认清空后建立兼容链接。检查 HEAD、分支和源码摘要。
3. **规范与工具接入**：填写 constitution；移动并更新专题规范；建立 AGENTS、CLAUDE 导入、共享 SDD Skill、工作流与交接说明。保留已有 Spec Kit 的工具适配内容。
4. **资料归档与验收**：归档旧研究与试跑目录、整理品牌素材和本地二维码，修复当前文档链接，记录迁移结果并独立审查。

## File Movement Rules

- 原源码的 miniprogram、cloudfunctions、config、scripts、tests、package 文件和旧网页结构原样进入主目录。
- 原源码 docs/wechat-trial-runbook.md 进入 docs/operations/；只改位置说明和必要引用，运行事实保留。
- 开发规范/ 进入 docs/standards/，修订路径、正式接入状态以及 SDD 分工。
- 根目录旧研究 Markdown、采集验证/、参考资料/ 一起进入 docs/archive/collection-research/，保留相互位置和原始内容。
- 原始响应、试跑目录默认忽略；历史说明用于溯源，不是当前实现指令。
- 头像与生成说明进入 assets/branding/；二维码、截图和浏览器日志进入 .local/。
- 001 功能的完整账号 JSON 和报名原始记录进入 .local/accounts/001-wechat-member-trial/；规格保留脱敏进度摘要，原文逐字保留。
- 两份 .gitignore 的原文保留在备份中，最终合并忽略项；任何其他同名文件冲突立即停止。
- 不给归档脚本自动接上新凭据，不因归档而重新运行它们。原源码入口的兼容链接只维持开发工具路径。

## Validation Strategy

- 文件摘要与权限比对：每个原文件映射到新位置；有意修改的文档单独列出，其他内容必须完全一致。
- Git：主目录与旧入口同一根；HEAD、分支、远端和既有 tracked 文件内容保留。
- Spec Kit：从主目录、源码子目录与旧入口解析到同一 .specify 根；默认保留原业务功能选择，同时显式验证本次 002 功能。
- 工具：CLAUDE 导入同一 AGENTS，共享 Skill 引用一致、语法有效；独立场景检验不提前实施、不重复已授权步骤。
- 运行结构：执行生成副本与包检查、前端类型检查、旧网页只读数据/图片校验；业务源码未变，不重复全量业务测试。
- 私有边界：核对 .env、.local、原始响应、二维码与 feature 指针的 Git 忽略结果。
- 文档：当前入口、规范、规格、运行记录中的本地链接有效；历史原文的旧位置由归档说明解释。

## Recovery

备份先保留在本机临时目录，迁移成功后放到 .local/organization-backups/20260913/。
备份含原工作台材料、原源码（不含 node_modules）、完整 Git 元数据和摘要清单。
恢复必须以清单和实际状态为准，先停本地写入；不得用无差别删除覆盖后续用户工作。
迁移采用同文件系统移动，任何已存在目标不自动覆盖。
