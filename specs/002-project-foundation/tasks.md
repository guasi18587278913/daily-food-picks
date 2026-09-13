# Tasks: 统一目录与双工具 SDD 开发地基

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[quickstart.md](quickstart.md)。
**Status**: 16 项任务均已完成；迁移、共享入口、归档与验证见[整理记录](../../docs/operations/project-organization.md)。原业务功能指针已恢复到 001。
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
