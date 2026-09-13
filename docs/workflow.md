# Codex、Claude Code 与 Spec Kit 的共同工作流

SDD 是先把需求和验收写清，再按约定实现。Spec Kit 组织文档与步骤，两种开发工具共用同一份材料。

## 1. 哪份文档负责什么

| 材料 | 唯一职责 |
| --- | --- |
| [constitution](../.specify/memory/constitution.md) | 长期原则与共同底线 |
| [专题规范](standards/README.md) | 代码、测试、Skill 的具体检查标准 |
| `spec.md` | 某个功能的用户场景、行为和验收 |
| `plan.md` | 模块边界、技术方案、验证策略和原则检查 |
| `tasks.md` | 实施顺序、完成事实和剩余项 |
| `research.md`、`data-model.md`、`contracts/` | 该功能确实需要的研究、数据和接口约定 |
| 运行／验收记录 | 对应源码状态的真实执行证据 |
| [AGENTS.md](../AGENTS.md)、[CLAUDE.md](../CLAUDE.md) | 两种工具读取共同规则的入口；不复制细则 |

状态不要在多份文档重复展开。spec 和 plan 顶部指向 tasks，tasks 再指向运行证据。

## 2. 每次先确认功能

用户明确指定哪个功能，就先使用那个目录。否则读取 `.specify/feature.json`；它是每个工作区的本地指针，已被 Git 忽略。

新工作树或新克隆可能没有这个文件。这是正常状态：新功能直接从 specify 建立规格；继续已有功能则先列出 specs 与未完成任务。只有一个可确定的未完成功能时说明依据后选中；候选不唯一且用户未指定时，先澄清目标。

已有默认指针时，在项目根运行：

```bash
bash .specify/scripts/bash/check-prerequisites.sh --json --paths-only
```

输出的 `FEATURE_DIR` 应位于本项目 specs 中。本机 Spec Kit 将功能目录与 Git 分支分开处理；不要根据分支名称猜功能。

没有默认指针，或只读检查另一个功能时，显式指定目录：

```bash
SPECIFY_FEATURE_DIRECTORY=specs/001-wechat-member-trial bash .specify/scripts/bash/check-prerequisites.sh --json --paths-only
```

其他 setup 命令可能持久化功能选择或覆盖模板文件。已有 plan 和 tasks 时先读内容，不为“继续开发”重新初始化。

## 3. 按任务选择流程

### 新功能

`specify → 必要的 clarify → plan → tasks → analyze → implement → 验收与交接`

- specify 写用户场景和验收，不能只列页面。
- plan 的 Constitution Check 核对长期原则，明确模块和测试策略。
- tasks 将关键行为测试、失败场景和必要审查列成实际任务。
- analyze 检查文档一致性与覆盖；它不替代代码测试。
- implement 按任务推进，依风险复用已有授权。范围发生实质变化时再对齐。

Codex 调用 `$speckit-specify` 等，Claude Code 调用 `/speckit-specify` 等；步骤和产物相同。

### 继续已有功能

定位功能 → 读 spec、plan、tasks → 核对当前 Git 差异和已留证据 → 找未完成项 → 继续实施或验收。

不要因为换了工具重新生成规格。没有未完成项时说明当前已完成，不自行找额外功能做。

### 修 Bug 或小改

按[风险分级](standards/README.md)执行。关联已有功能时复用其规则和任务记录。
关键 Bug 先建立可失败的行为用例；普通文案、颜色、间距不强制生成整套文档或启动独立审查。
业务规则或验收变化时更新对应 spec；纯样式不重写需求。

### 只讨论或只审查

只输出分析、问题和建议。读取开发 Skill 不等于用户授权执行实现或部署。

## 4. 两种工具如何交接

每个任务指定一个主要写入者，另一方可以做独立审查。角色可互换，不按模型品牌固定能力。

同一工作区不要同时改同一文件、tasks 或 feature 指针。真正独立的并行任务才使用不同文件范围或独立工作树。

新工作树应从已经包含这套规格和规范的提交创建。当前整合位于开发分支；不能默认旧 main 已经包含这些文件，合并状态见[整理记录](operations/project-organization.md)。

交接信息放在对应任务或其引用的运行记录中，至少包含：

```text
功能与任务：功能目录、任务编号、当前主要写入者
源码状态：分支、提交，或未提交差异范围
已完成：确实完成的任务与产物
验证：环境、命令、退出码、通过/失败/跳过
剩余：尚未完成、阻塞或需要决策的事项
下一步：可以直接开始的一项具体动作
```

接手者先核对文件和代码，不把交接文字当作已经验证的事实。授权继续有效，未完成的真机验收也继续保留。

## 5. 什么时候算完成

按[测试与交付](standards/测试与交付.md)选择受影响验证，再做自审；高风险独立审查并复审。

只有实际完成才勾 tasks。规格质量清单的勾选仅代表需求写清楚，不能当实现完成、部署许可或费用许可。

开发过程中无需每次全量测试。正式合并和发布仍按对应阶段落实验证，当前规范与 Skill 也不等于已安装 CI 或所有强制检查。

## 6. 维护规则而不维护两份副本

修改长期原则用项目 `speckit-constitution`；细则在 docs/standards 对应文件修改；单次功能变化进入它自己的 specs 目录。

项目 SDD Skill 的主版本是 `.agents/skills/food-picks-sdd/`，Claude 侧是同源链接。现有 Spec Kit 适配目录由其安装工具维护，不手工复制规则进去。

没有新的业务事实不重复写运行记录；踩坑需要留下原因和可复现检查，避免每次加一条相互矛盾的禁令。
