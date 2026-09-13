# Implementation Plan: 微信登录与多用户权限体系

**Feature**: `003-wechat-login-roles` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-wechat-login-roles/spec.md`

## Summary

把授权机制从"云函数环境变量里的单人 openId 白名单"换成"服务端用户记录 + 邀请码自助开通 + 小程序内管理页"，并把收藏从本机存储迁到云端按用户存储。身份仍取自微信平台在本次云函数调用中注入的 `OPENID` 与 `APPID`，不引入 `wx.login`、会话票据或任何个人资料采集。

技术路线（依据见 [research.md](research.md)）：

- 新增 `account` 云函数承担开通、用户与邀请码管理、收藏读写；`catalog` 保持只读职责，只换权限判定来源。
- 邀请码以归一化码值作为文档 ID，核销在事务内完成，保证并发不超额。
- 管理页做成独立页面，从首页条件渲染的入口进入，不用 tabBar。
- 迁移分两步部署：先上带回落的版本并执行幂等迁移，回读确认后再上去掉回落的版本并清空旧环境变量。
- 顺带修掉 `status` 接口重复读同一文档的浪费，并让 `published()` 在单次调用内按 snapshotId 记忆，降低轮询与收藏页的数据库读次数。

## Technical Context

**Language/Version**: JavaScript (CommonJS)，Node.js 20.19（云函数运行时与本地 `engines` 一致）

**Primary Dependencies**: `wx-server-sdk`、`@cloudbase/node-sdk`（均为现有依赖，不新增第三方库）

**Storage**: 腾讯云开发文档型数据库，上海地域，环境 `food-picks-trial-d5elis0ecfcb5d2`。新增 5 个集合，全部 ADMINONLY

**Testing**: `node --test tests/*.test.js`，用 `tests/helpers.js` 的 `MemoryStore` 做内存替身（已支持 `transaction` 串行化语义，可直接测并发核销）；前端类型检查 `npm run typecheck:mini`

**Target Platform**: 原生微信小程序（个人主体，AppID `wx8a2388888683b769`）+ 腾讯云开发云函数

**Project Type**: 小程序客户端 + 云函数后端，单一 Git 项目

**Performance Goals**: 开通提交与界面分支判定在一次云函数调用内完成；管理页列表分页每页不超过 50 条

**Constraints**: 云开发套餐为个人版、`EnableOverrun=true`（超额直接计费而非限流），因此数据库读次数是硬约束，必须在扩大用户数前回读实际配额；单文档 184000 字节上限约束收藏条数；不引入付费能力（个人主体无微信支付资质）

**Scale/Scope**: 目标 100 用户上限。新增 1 个云函数、1 个页面、5 个集合、约 6 个服务端模块；预计改动文件数超过 10，属高风险任务

## Constitution Check

*GATE: 必须在 Phase 0 前通过，Phase 1 设计后重新核对。*

逐条核对 [constitution v1.0.0](../../.specify/memory/constitution.md)：

### I. 需求、方案和任务使用同一份事实

**通过**。规格、方案、数据模型和契约都在 `specs/003-wechat-login-roles/`，Codex 与 Claude Code 读写同一份。本功能显式声明修订 001 的 FR-023 并列出 001 中继续有效的四条约定（见 spec 开头"与既有需求的关系"），没有静默改动旧验收。

`.specify/feature.json` 已指向本功能目录。001 的 T032 独立存在，不因本功能视为完成。

### II. 职责清楚，依赖有边界

**通过**。`account` 负责身份、权限与收藏的读写；`catalog` 只读选题；`collectTick` 只管采集。权限判定模块 `access.js` 的源归属 `account/lib`，`catalog` 通过生成副本消费，单向依赖，不新增循环依赖。

**需要注意的一点**：`access.js` 当前是 `catalog/lib` 下的手写文件，改为生成副本后要同步改 `.gitignore`、`git rm --cached` 和 `check-package.js` 的一致性清单。这是一次性结构调整，已列入任务。

查询不改权限：`catalog` 的 5 个 action 全部只读，不写用户记录；`redeem` 是唯一会创建用户记录的入口，且只在事务内扣减邀请码次数。

### III. 证据先于完成结论

**通过**。关键行为在任务阶段列为先写的失败测试，不留到最后补：

- 未开通、已停用身份在全部入口被拒绝，且拒绝响应不含选题数据或图片地址。
- 并发核销同一个仅剩一次的码，`usedCount` 不超过 `maxUses`。
- 最后一个可用 admin 不能被停用或降级，包括对自己操作。
- 收藏只能读写自己的，参数传他人 openId 无效。
- 本机收藏合并取并集、不丢条目、失败不清空。
- 迁移重复执行不产生重复记录、不覆盖已变更的角色。

单元测试、真实云端部署和真机验收分别报告，不互相替代。开发中只跑受影响测试。

### IV. 可信身份、真实数据和有界消费

**通过，但有一项必须前置完成**。

身份：沿用 `context.js` 的 `parseContext` 只读本次调用，不接受客户端自报身份，不沿用进程状态。新增的权限判定在单次调用内只读一次用户记录，**不跨调用缓存**。

消费：本功能不发起任何外部收费调用（spec FR-029）。但云资源消耗会随用户数线性增长，而 `EnableOverrun=true` 意味着超额直接计费。因此"在控制台回读个人版实际配额与当前用量"是**实施前置任务**，不是事后观察项。缺少该事实不得按 100 用户规模对外开通（spec FR-028）。

密钥：`DFP_BOOTSTRAP_ADMIN_OPENID` 只存在于云函数环境变量，示例配置留空，不进入客户端包。`check-package.js` 已有客户端凭据扫描，继续生效。

### V. 两种工具共享流程，按风险协作

**通过**。本功能属高风险（权限、身份隔离、数据迁移、预计超过 10 个文件），按 [规范入口](../../docs/standards/README.md)第 3 节：先完成可审阅方案并取得确认，实施后安排独立审查，修复后复审。

本文档连同 spec、data-model、contracts 即为待确认的方案。用户确认后才进入 tasks 与实施。

交接记录写入功能文档与运行记录，包含源码状态、已完成任务、验证证据和下一步。

### 复核结论（Phase 1 设计后）

重新核对：设计没有引入新的原则冲突。唯一需要用户决策的是 [research.md 第 9 节](research.md)的三个待决项（轮询退避是否允许、`status` 是否本次聚合、收藏条数上限），其中"轮询退避"涉及修改 001 的 FR-020，必须先确认再动。这些不阻塞其余实施。

## Project Structure

### Documentation (this feature)

```text
specs/003-wechat-login-roles/
├── plan.md              # 本文件
├── spec.md              # 需求与验收
├── research.md          # Phase 0：技术决策、用量调研、待决项
├── data-model.md        # Phase 1：5 个新集合的字段与状态流转
├── contracts/
│   └── account-api.md   # Phase 1：account 接口契约 + catalog 权限变化
├── quickstart.md        # Phase 1：验证步骤
├── checklists/
│   └── requirements.md  # 规格质量检查
└── tasks.md             # Phase 2（/speckit-tasks 产出，本命令不创建）
```

### Source Code (repository root)

```text
cloudfunctions/
├── account/                    # 新增云函数
│   ├── index.js                # 入口：初始化、解析身份、分发 action
│   ├── package.json
│   └── lib/
│       ├── access.js           # 新增（源）：读用户记录判定角色与状态
│       ├── users.js            # 新增：用户记录读写与状态流转约束
│       ├── invites.js          # 新增：码生成、归一化、事务核销、限流
│       ├── favorites.js        # 新增：云端收藏读写与本机合并
│       ├── admin.js            # 新增：管理动作与最后一个 admin 保护
│       ├── actions.js          # 新增：action 路由与统一错误映射
│       ├── store.js            # 生成副本（源：collectTick/lib/store.js）
│       └── context.js          # 生成副本（源：collectTick/lib/context.js）
├── catalog/
│   ├── index.js                # 改：接入新权限判定，移除临时捕捉开关
│   └── lib/
│       ├── queries.js          # 改：权限判定来源；消除重复读；published 单次调用内记忆
│       ├── access.js           # 改为生成副本（源：account/lib/access.js）
│       ├── store.js            # 生成副本，不动
│       └── context.js          # 生成副本，不动
└── collectTick/
    └── lib/store.js            # 改：COLLECTIONS 白名单加入 5 个新集合

miniprogram/
├── app.json                    # 改：注册 pages/admin/admin
├── lib/
│   ├── api.js                  # 改：account 调用封装、新错误码映射
│   ├── favorites.js            # 改：云端收藏 + 本机迁移（保留本机读取用于合并）
│   ├── admin.js                # 新增：管理页数据与校验逻辑
│   └── view.js                 # 可能微调：开通引导与停用状态的展示
└── pages/
    ├── index/                  # 改：界面分支（开通引导／内容／停用）、管理入口
    └── admin/                  # 新增：用户列表、邀请码管理
        ├── admin.js
        ├── admin.json
        ├── admin.wxml
        └── admin.wxss

config/
└── cloudbaserc.example.json    # 改：新增 account 函数与空的引导配置项

scripts/
├── prepare-functions.js        # 改：新增副本条目
└── check-package.js            # 改：一致性清单与页面产物检查同步

tests/
├── access.test.js              # 新增：权限判定、界面分支依据
├── invites.test.js             # 新增：码生成、并发核销、限流
├── favorites.test.js           # 新增：云端收藏隔离、合并
├── admin.test.js               # 新增：管理动作、最后一个 admin、迁移幂等
├── catalog.test.js             # 改：权限判定来源变化后的既有断言
└── frontend.test.js            # 改：界面分支与收藏迁移的前端行为

.gitignore                      # 改：加入 catalog/lib/access.js 生成副本
```

**Structure Decision**: 沿用现有布局——云函数各自一个目录、共享模块用生成副本、小程序页面平铺在 `miniprogram/pages/`、测试集中在 `tests/`。不引入新的目录层级或构建工具。

唯一的结构调整是 `access.js` 从 `catalog/lib` 的手写文件变为 `account/lib` 的源文件加生成副本，理由是权限判定属于账号模块的职责，`catalog` 是消费者（constitution 原则 II）。

## 实施顺序

按可独立验证的小步推进，每步结束时受影响测试可跑通：

1. **数据与共享基础**：`store.js` 白名单、`access.js`（含 `dfp_users` 读取与角色状态判定）、副本与打包脚本同步。
2. **account 云函数骨架 + redeem**：身份校验、限流、事务核销、`me`。此步完成后"新用户凭码开通"可端到端验证。
3. **catalog 权限切换（带回落）**：判定来源改为用户记录，保留静态名单回落；同时做 `status` 重复读与 `published()` 记忆两项优化。
4. **管理动作**：用户列表、停用恢复、角色指派、码生成与停用、最后一个 admin 保护、迁移动作。
5. **管理页**：独立页面 + 首页条件入口。
6. **收藏上云**：服务端读写、前端改造、本机合并迁移。
7. **部署与迁移**：部署、执行迁移、回读确认、去掉回落分支、清空旧环境变量、关闭临时捕捉开关。
8. **独立审查与验收**：差异审查、真机验收、运行记录更新。

**前置任务**（与第 1 步并行，但必须在第 7 步前有结论）：控制台回读个人版配额与当前用量（spec FR-028）。

## Complexity Tracking

Constitution Check 无违规项，无需例外豁免。

以下是范围较大但必要的改动，记录原因以便审查时核对：

| 改动 | 为什么必要 | 更简单的替代为何不够 |
| --- | --- | --- |
| 新增 `account` 云函数 | 开通、管理、收藏都要写数据，与 `catalog` 的只读职责冲突 | 全塞进 `catalog` 会让同一入口既读选题又改权限，违反原则 II |
| `access.js` 改为生成副本并换归属 | 两个函数共用同一套权限判定，源必须唯一 | 两处各维护一份会在一处改漏时造成权限判定不一致 |
| 迁移分两次部署 | 判定来源必须唯一（FR-027），但切换瞬间不能让现有用户掉线（FR-026） | 一次性切换会让迁移失败时现有用户全部失去访问 |
| 顺带做两项读次数优化 | `EnableOverrun=true`，超额直接计费；轮询与收藏页是读热点 | 不优化则用户增长直接放大账单，且 `status` 重复读本身是明显浪费 |
