# Tasks: 统一目录与双工具 SDD 开发地基

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[quickstart.md](quickstart.md)。
**Status**: 原迁移任务 T001–T016 已完成，详见[整理记录](../../docs/operations/project-organization.md)。2026-09-16 追加开发入口加固 T017–T018，状态与证据见下文；当前业务功能以本工作区指针或用户指定为准。
**路径**: 相对统一后的项目根目录；不更改业务逻辑、推送或部署。

## Phase 1: Setup

- [x] T001 记录两目录、Git 历史与文件摘要，完整备份至本机迁移备份目录；备份信息最终写入 `docs/operations/project-organization.md`。
- [x] T002 在 `specs/002-project-foundation/` 完成需求、方案和规格检查，沿用已确认授权。

## Phase 2: Foundational

- [x] T003 用既有模板解析器填写 `.specify/memory/constitution.md`，采用首个正式版本 1.0.0，不改上游模板。
- [x] T004 准备有冲突检查的迁移脚本与原路径映射，核对 `.gitignore` 合并和私有边界；独立审查迁移方案。

## Phase 3: US1 — 唯一项目入口

**验收**：新旧路径指向同一 Git 根、HEAD 和当前功能；业务文件摘要一致。

- [x] T005 [US1] 将原源码目录内容和 `.git/` 迁入主目录，保留原分支、远端和旧网页相对结构；旧英文目录建立兼容链接。
- [x] T006 [US1] 对照迁移清单检查原文件与 `miniprogram/`、`cloudfunctions/`、`config/`、`scripts/`、`tests/` 等路径，拒绝未解释变化。

## Phase 4: US2 — 共享规范与开发流程

**验收**：两种入口读同一规则，既有功能不重复创建，新功能按 SDD 推进，咨询不触发实施。

- [x] T007 [US2] 将 `开发规范/` 整理到 `docs/standards/`，统一长期原则、细则与功能文档的归属及引用。
- [x] T008 [US2] 建立根 `AGENTS.md`、导入它的 `CLAUDE.md` 和 `docs/workflow.md`，说明功能选择、风险与交接。
- [x] T009 [US2] 在 `.agents/skills/food-picks-sdd/SKILL.md` 建共享入口，在 `.claude/skills/food-picks-sdd` 使用同源链接，保留既有 Spec Kit 适配。
- [x] T010 [US2] 验证共享 Skill 语法、引用与三个实际流程场景；验证 `.specify/feature.json` 和显式功能目录的定位，并补测无本地指针的新工作树接续。

## Phase 5: US3 — 资料归档与导航

**验收**：根目录不再混放研究文档；每份原文件有去向，私有资料被忽略。

- [x] T011 [US3] 将根目录早期研究、`采集验证/`、`参考资料/` 归入 `docs/archive/collection-research/`，保留原始内容并标明历史用途。
- [x] T012 [US3] 将头像和说明归入 `assets/branding/`，账号原始记录、二维码、预览和浏览器日志归入 `.local/`；规格保留脱敏进度，并保留迁移备份。
- [x] T013 [US3] 整理 `docs/operations/wechat-trial-runbook.md` 与 `specs/001-wechat-member-trial/` 的位置说明，修复当前链接，增加根 `README.md` 与 `docs/README.md` 导航。

## Phase 6: Verification and Handoff

- [x] T014 运行受影响的路径、忽略、文档、生成副本、包与类型检查；旧网页只读校验数据和图片。证据写入 `docs/operations/project-organization.md`。
- [x] T015 独立审查迁移结果及共享流程，修复问题并复审；同一状态不重复全量业务测试。
- [x] T016 在 `docs/operations/project-organization.md` 记录文件完整性、当前功能恢复与后续使用方式，完成本任务勾选。

## Dependencies & Execution Order

备份和方案 → 迁移预检 → 统一目录与归档 → 共同入口与引用 → 本地验证 → 独立审查与交接。

## Parallel Opportunities

独立审查可与主 Agent 的文档、规则检查并行；实际文件移动保持串行，避免同名目标竞争。

## Implementation Strategy

三类场景全部完成；不只交付目录树或规范草稿。当前业务功能的未完成项继续留在 001 功能，不挪到整理任务中冒充完成。

## 2026-09-16 开发入口加固

**目标与范围**：接续 FR-004、FR-005，落实用户认可的 `AGENTS.md` 与现有开发 Skill 入口方案。此次只修改共同入口、共享 Skill 和本任务记录；Hook 与真实会话自动触发验收另行记录，不改业务源码或其他功能的历史任务。

**验收**：开发任务在首次修改业务代码前确认功能、阶段、任务或小改范围与验收；默认指针与目标不符时重新定位；按任务实施的功能缺少必要材料时先补齐；小改和只读讨论保留既有分流；任务状态在原条目回写。

- [x] T017 [US2] 在 `AGENTS.md` 明确每个开发任务的入口动作，在 `.agents/skills/food-picks-sdd/SKILL.md` 完善功能核对、材料缺失处理与任务回写。
- [x] T018 [US2] 验证 Skill 格式、双工具共享入口、本地引用与只读功能定位；自审各流程分支，记录实际验证范围和未验证项。

### 本地验证与交接

- **源码范围**：以 GitHub `main` 的 `8ab4b4e` 为基线，在 `chore/sdd-entry-checks` 独立工作树修改上述三个文件。本记录适用于包含它的提交；原主工作区的其他业务提交不纳入本次提交。
- **Skill 格式**：`python3 /Users/liyadong/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/food-picks-sdd` 通过，退出码 0。
- **结构与定位**：本地 Python 只读检查 6 项通过、0 失败、0 跳过，退出码 0。覆盖 Claude 导入、共享 Skill 同源可读、18 个本地引用、任务编号唯一、新工作树无指针、显式选择 002 且不创建指针。
- **差异自审**：新功能从 specify 开始；继续任务缺材料先补齐；小改保留简化路径；讨论保持只读；指针与目标不符重新定位；已授权任务继续执行。按文本检查这些分支，没有把自审计为真实会话触发测试。`git diff --check` 通过，退出码 0。
- **实际限制**：未新开真实 Codex／Claude Code 会话验证自然语言自动触发；未安装 Hook；未运行业务测试、推送或部署。规则已加固，自动触发可靠性尚未验收。
- **下一步**：在两个助手的新会话中验证新增功能、继续任务、小改与只读讨论的实际入口行为，记录是否读取共享 Skill、是否选中正确功能及是否产生预期文件改动；再据实际遗漏决定是否接入 Hook。
