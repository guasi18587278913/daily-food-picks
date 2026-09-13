---

description: "Task list for 003-wechat-login-roles"
---

# Tasks: 微信登录与多用户权限体系

**Input**: Design documents from `specs/003-wechat-login-roles/`

**Prerequisites**: [plan.md](plan.md)、[spec.md](spec.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts/account-api.md](contracts/account-api.md)、[quickstart.md](quickstart.md)

**Tests**: 必须包含。constitution 原则 III 要求关键业务先写能失败的行为测试，AGENTS.md 要求关键逻辑有行为测试，不留到最后补。每个阶段的测试任务先写、先确认失败，再实现。

**Organization**: 按用户故事分阶段。故事间的真实依赖写在「Dependencies」，不假装完全独立。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 对应 spec.md 的用户故事（US1–US4）
- 每条都带确切文件路径

## Path Conventions

云函数在 `cloudfunctions/<name>/`，小程序在 `miniprogram/`，测试在 `tests/`，脚本在 `scripts/`，部署配置在 `config/`。生成副本不直接编辑，改源后跑 `npm run prepare:functions`。

---

## Phase 1: Setup（共享基础）

**Purpose**: 新集合可用、新云函数可部署、生成副本与打包检查跟上

- [x] T001 在 `cloudfunctions/collectTick/lib/store.js` 的 `COLLECTIONS` 常量中加入 `dfp_users`、`dfp_invites`、`dfp_favorites`、`dfp_redeem_attempts`、`dfp_access_log`，保持 `Object.freeze` 与现有顺序风格；改完跑 `npm run prepare:functions` 刷新 `catalog` 副本
- [x] T002 创建 `cloudfunctions/account/package.json`，依赖与 `cloudfunctions/catalog/package.json` 一致（`wx-server-sdk`、`@cloudbase/node-sdk`），名称 `account`，不新增第三方库
- [x] T003 在 `scripts/prepare-functions.js` 的 `copies` 数组加入三条：`cloudfunctions/collectTick/lib/store.js` → `cloudfunctions/account/lib/store.js`、`cloudfunctions/collectTick/lib/context.js` → `cloudfunctions/account/lib/context.js`、`cloudfunctions/account/lib/access.js` → `cloudfunctions/catalog/lib/access.js`
- [x] T004 在 `.gitignore` 加入 `cloudfunctions/account/lib/store.js`、`cloudfunctions/account/lib/context.js`、`cloudfunctions/catalog/lib/access.js`，并执行 `git rm --cached cloudfunctions/catalog/lib/access.js` 让它只作为生成副本存在
- [x] T005 在 `scripts/check-package.js` 的副本一致性清单加入 T003 的三条对应关系，使 `npm run check:package` 能发现未刷新的生成副本
- [x] T006 在 `config/cloudbaserc.example.json` 的 `functions` 数组加入 `account`（`runtime` 为 `Nodejs20.19`、`handler` 为 `index.main`、`timeout` 为 30、`memorySize` 为 256），`envVariables` 含 `DFP_APP_ID`（沿用现值）、`DFP_BOOTSTRAP_ADMIN_OPENID`（留空）、`DFP_ALLOWED_OPENIDS`（留空，仅迁移窗口使用）

**Checkpoint**: `npm run prepare:functions` 与 `npm run check:package` 通过，新函数目录结构成立

---

## Phase 2: Foundational（阻塞所有故事）

**Purpose**: 权限判定从静态名单换成用户记录，并让 `catalog` 立即按新来源判权。没有这一步，任何新开通的用户都看不到数据。

**⚠️ 关键**：本阶段完成前，任何用户故事都不能开始。

### 测试（先写，确认失败）

- [x] T007 [P] 新建 `tests/access.test.js`：身份缺失、AppID 不符、别名冲突返回 `UNAUTHENTICATED`；请求参数中的 `OPENID`／`APPID` 被忽略；`dfp_users` 无记录返回 `NOT_REGISTERED`；`status` 为 `suspended` 返回 `SUSPENDED`；`role` 或 `status` 缺失、为非法值时按无权限处理不放宽；断言拒绝响应不含选题作品、图片地址和轮次信息
- [x] T008 [P] 在 `tests/access.test.js` 增加引导用例：配置的 `DFP_BOOTSTRAP_ADMIN_OPENID` 身份在无记录时被建为 `active`/`admin` 且 `grantedVia` 为 `bootstrap`；已有记录时不改动其 `role` 与 `status`；非该身份不因配置获得 admin
- [x] T009 [P] 在 `tests/access.test.js` 增加迁移窗口用例：开启回落时，无用户记录但在静态名单中的身份通过判定；关闭回落时同一身份返回 `NOT_REGISTERED`
- [x] T010 [P] 改 `tests/catalog.test.js`：把 `config: { appId, allowedOpenIds: ['owner'] }` 的构造替换为基于 `dfp_users` 记录的替身；保留「每个 action 在读取或签发图片链接前拒绝缺失、外部和伪造身份」这条断言，并把未开通的期望码从 `FORBIDDEN` 改为 `NOT_REGISTERED`；新增 `suspended` 身份对 5 个 action 全部返回 `SUSPENDED` 的用例
- [x] T011 [P] 在 `tests/catalog.test.js` 增加读次数断言：用计数型 store 替身统计 `get` 调用，断言一次 `status` 对 `dfp_snapshots` 的读取不超过 1 次，一次取 N 篇、来自 M 个轮次的 `getNotes` 对 `dfp_snapshots` 的读取不超过 M 次；并断言优化前后返回值逐字段相同

### 实现

- [x] T012 新建 `cloudfunctions/account/lib/access.js`（权限判定的唯一源）：导出从 `dfp_users/{openId}` 读取并判定的函数，输入为调用上下文与配置，输出角色与状态或抛出分类错误；单次调用内只读一次用户记录并向下传递；**不得跨调用缓存**；含 `DFP_BOOTSTRAP_ADMIN_OPENID` 引导分支与由配置开关控制的迁移窗口回落分支
- [x] T013 新建 `cloudfunctions/account/lib/users.js`：用户记录读写与状态流转约束。字段按 [data-model.md](data-model.md) 的 `dfp_users` 表：`role` 取 `'admin'`｜`'member'`，`status` 取 `'active'`｜`'suspended'`，`grantedVia` 取 `'invite'`｜`'bootstrap'`｜`'migration'`，`grantedAt`／`updatedAt` 为 ISO 8601，`inviteCode` 在 `grantedVia` 为 `'invite'` 时必填。实现 data-model 的状态流转表，拒绝表中未列出的流转；流转约束由 `tests/users.test.js` 覆盖
- [x] T014 新建 `cloudfunctions/account/lib/actions.js`：action 路由与统一错误映射，错误码与提示文案按 [contracts/account-api.md](contracts/account-api.md) 的错误码表；`CODE_NOT_FOUND` 对「不存在」和「已停用」使用同一码与同一提示
- [x] T015 新建 `cloudfunctions/account/index.js`：初始化云环境、用 `lib/context.js` 的 `currentWxContext` 读取本次调用身份、分发到 `actions.js`，顶层 catch 统一返回 `{ok:false,error:{code:'BACKEND_UNAVAILABLE',...}}`，结构与 `cloudfunctions/catalog/index.js` 一致
- [x] T016 在 `cloudfunctions/account/lib/actions.js` 实现 `me` 动作：返回 `{role, status, grantedAt}`，未开通时返回 `NOT_REGISTERED`。这是客户端决定显示开通引导还是选题内容的唯一依据
- [x] T017 改 `cloudfunctions/catalog/lib/queries.js`：把 `authorize(wxContext, config)` 换成基于用户记录的判定；未开通返回 `NOT_REGISTERED`、已停用返回 `SUSPENDED`，`FORBIDDEN` 保留给其他拒绝场景；5 个 action 的入参、返回结构和分页游标语义不变
- [x] T018 改 `cloudfunctions/catalog/lib/queries.js`：消除 `status` 动作中 `published()` 的重复调用（当前 `revision` 与 `snapshotId` 两个三元表达式各发起一次 `store.get`），改为求值一次后复用
- [x] T019 改 `cloudfunctions/catalog/lib/queries.js`：让 `published()` 在单次调用生命周期内按 `snapshotId` 记忆结果，降低 `getNotes` 与 `search` 路径的重复读取；记忆容器随调用结束释放，不跨调用保留
- [x] T020 改 `cloudfunctions/catalog/index.js`：移除 `DFP_CAPTURE_CALLER_FOR_SETUP` 临时捕捉分支及相关写入（新用户改由邀请码自助开通，不再需要先捕捉身份再人工加名单）
- [x] T021 删除 `cloudfunctions/catalog/lib/access.js` 的手写内容，改由 T003 的生成副本提供；确认 `npm run prepare:functions` 后 `catalog` 与 `account` 的 `access.js` 字节一致

**Checkpoint**: `node --test tests/access.test.js tests/catalog.test.js` 通过；权限判定来源已是用户记录，`catalog` 行为除错误码外无变化

---

## Phase 3: User Story 1 - 新用户凭邀请码自助开通 (Priority: P1) 🎯 MVP

**Goal**: 拿到码的人扫码进入、输入码、立即可用，不需要联系维护者，不提供任何个人资料。

**Independent Test**: 用从未开通的真实微信账号进入，确认只看到开通引导且无任何选题数据；输入有效码后能看到完整内容；同一码用到次数上限后被拒绝。

### 测试（先写，确认失败）

- [x] T022 [P] [US1] 新建 `tests/invites.test.js`：码生成符合 10 位字符集 `ABCDEFGHJKMNPQRSTVWXYZ23456789`；连续生成多个不重复；生成时若码值已存在则重试且不覆盖已有码
- [x] T023 [P] [US1] 在 `tests/invites.test.js` 增加核销用例：有效未用尽未过期码建出 `active`/`member` 且 `grantedVia` 为 `'invite'` 并记录 `inviteCode`；码不存在与已停用都返回 `CODE_NOT_FOUND` 且提示相同；已过期返回 `CODE_EXPIRED`；已用尽返回 `CODE_EXHAUSTED`
- [x] T024 [P] [US1] 在 `tests/invites.test.js` 增加幂等与隔离用例：同一身份重复提交同一有效码返回 `ALREADY_REGISTERED` 且 `usedCount` 不变、不产生第二条记录；`suspended` 身份提交有效码返回 `SUSPENDED` 且不扣减次数
- [x] T025 [US1] 在 `tests/invites.test.js` 增加**并发核销**用例：对 `maxUses` 为 1 且 `usedCount` 为 0 的码，两个不同身份同时发起 `redeem` 并 `await Promise.all`，断言恰好一个成功、另一个 `CODE_EXHAUSTED`、最终 `usedCount === maxUses` 且不为负（借 `tests/helpers.js` 的 `MemoryStore.transaction` 串行化语义）
- [x] T026 [P] [US1] 在 `tests/invites.test.js` 增加限流用例：窗口内连续 10 次错误提交后再提交返回 `TOO_MANY_ATTEMPTS` 并带恢复时间且不读取邀请码文档；窗口过期后重置而非累加；成功开通后 `dfp_redeem_attempts/{openId}` 被删除；限流不影响已开通身份的读取
- [x] T027 [P] [US1] 在 `tests/invites.test.js` 增加归一化与入参用例：含小写、首尾空白、分隔符的码正常核销；长度或字符集非法时返回 `INVALID_ARGUMENT` 且不查库

### 实现

- [x] T028 [US1] 新建 `cloudfunctions/account/lib/invites.js`：码生成（加密安全随机源、10 位、字符集 `ABCDEFGHJKMNPQRSTVWXYZ23456789`）、归一化（去首尾空白与分隔符、转大写）、格式校验（`^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$`）。字段按 data-model 的 `dfp_invites` 表：`maxUses` 为 1–100 安全整数，`usedCount` 为 ≥0 且 ≤`maxUses`，`expiresAt` 为 ISO 8601，`active` 为布尔，`note` 可空且 ≤50 字符
- [x] T029 [US1] 在 `cloudfunctions/account/lib/invites.js` 实现事务核销：用 `CloudStore.transaction()` 在一个事务内读码、校验 `active && now < expiresAt && usedCount < maxUses`、读用户记录、按 contracts 的决策表写入；保证 `usedCount` 永不超过 `maxUses`、永不为负
- [x] T030 [US1] 在 `cloudfunctions/account/lib/invites.js` 实现限流：`dfp_redeem_attempts/{openId}` 记 `windowStartedAt`（毫秒时间戳）与 `failures`（安全整数 ≥0），窗口 1 小时、上限 10 次失败，窗口过期重置，成功后删除文档
- [x] T031 [US1] 在 `cloudfunctions/account/lib/actions.js` 接入 `redeem` 动作：唯一不要求已有用户记录的 action；顺序为校验身份 → 查限流 → 事务核销 → 清限流并写审计
- [x] T032 [P] [US1] 新建 `cloudfunctions/account/lib/audit.js`：写 `dfp_access_log`，文档 ID 为 `${ISO时间戳}_${随机后缀}`，字段为 `at`、`actor`、`action`、`target`、`result`；不写入邀请码明文之外的细节，不写入任何选题内容或图片地址
- [x] T033 [US1] 改 `miniprogram/lib/api.js`：增加 `account` 云函数调用封装；错误码提示映射按 contracts 的错误码表补齐 `NOT_REGISTERED`、`SUSPENDED`、`CODE_NOT_FOUND`、`CODE_EXPIRED`、`CODE_EXHAUSTED`、`ALREADY_REGISTERED`、`TOO_MANY_ATTEMPTS`、`LAST_ADMIN`、`LIMIT_EXCEEDED`
- [x] T034 [US1] 改 `miniprogram/pages/index/index.js`：`onLoad` 先调 `account.me` 决定界面分支——`active` 进入内容、`NOT_REGISTERED` 显示开通引导、`SUSPENDED` 显示停用提示、`UNAUTHENTICATED` 提示从微信重新进入；未开通与已停用状态下**不发起任何选题数据请求、不启动轮询**
- [x] T035 [US1] 改 `miniprogram/pages/index/index.wxml` 与 `index.wxss`：增加开通引导区块（说明 + 邀请码输入框 + 提交按钮）与停用提示区块，沿用现有配色与排版风格；提交中禁用按钮避免重复提交
- [x] T036 [US1] 在 `miniprogram/pages/index/index.js` 实现提交邀请码：成功后当前会话直接进入内容（不需重启小程序），失败按错误码显示对应提示，不把失败显示成成功
- [x] T037 [P] [US1] 改 `tests/frontend.test.js`：覆盖四种界面分支；断言 `NOT_REGISTERED` 与 `SUSPENDED` 下没有发出选题数据请求、没有启动轮询；断言开通成功后直接进入内容

**Checkpoint**: 新身份可凭码开通并立即看到选题；未开通身份拿不到任何数据。MVP 成立。

---

## Phase 4: User Story 2 - 管理员在小程序里管理用户和邀请码 (Priority: P1)

**Goal**: 维护者用手机就能查看用户、停用滥用账号、生成码发给客户。

**Independent Test**: admin 账号能完成生成码、查看列表、停用与恢复；member 账号看不到管理入口且直接调用管理接口被拒。

### 测试（先写，确认失败）

- [x] T038 [P] [US2] 新建 `tests/admin.test.js`：member 与未开通身份调用每一个管理动作都被拒（member 返回 `FORBIDDEN`、未开通返回 `NOT_REGISTERED`），且响应不含用户列表、邀请码明文或其他用户信息
- [x] T039 [P] [US2] 在 `tests/admin.test.js` 增加列表用例：`admin.listUsers` 分页正常、`nextCursor` 语义稳定；返回字段只含 `openId`、`role`、`status`、`grantedAt`、`grantedVia`、`inviteCode`，不含手机号、昵称、头像或任何用户的收藏内容
- [x] T040 [US2] 在 `tests/admin.test.js` 增加**最后一个 admin 保护**用例：只有一个 `active` admin 时，停用它返回 `LAST_ADMIN` 且状态不变；把它降为 member 返回 `LAST_ADMIN` 且角色不变；admin 对自己执行同样操作同样被拒；存在两个 active admin 时允许停用其中一个
- [x] T041 [P] [US2] 在 `tests/admin.test.js` 增加停用与恢复用例：停用 member 后其所有读取返回 `SUSPENDED` 且 `dfp_favorites` 文档仍存在；恢复后读取正常、收藏内容与停用前一致
- [x] T042 [P] [US2] 在 `tests/admin.test.js` 增加码管理用例：`admin.createInvite` 入参 `maxUses` 为 1–100、`expiresInDays` 为 1–365、`note` ≤50 字符，越界返回 `INVALID_ARGUMENT`；`admin.revokeInvite` 置 `active` 为 false 后核销失败，但已用该码开通的用户仍为 `active`
- [x] T043 [P] [US2] 在 `tests/admin.test.js` 断言每个成功的管理动作都写入一条 `dfp_access_log`，含操作者、类型、对象和时间

### 实现

- [x] T044 [US2] 新建 `cloudfunctions/account/lib/admin.js`：实现 `listUsers`（`limit` 为 1–50，默认 20，游标由服务端生成）、`setUserStatus`、`setUserRole`、`createInvite`、`listInvites`、`revokeInvite`、`migrateWhitelist` 的业务逻辑，每个动作都要求 `role === 'admin'`
- [x] T045 [US2] 在 `cloudfunctions/account/lib/admin.js` 实现最后一个 admin 保护：停用或降级前统计 `active` 且 `role === 'admin'` 的数量，会导致为 0 时返回 `LAST_ADMIN` 并拒绝写入，包含操作者对自己的操作
- [x] T046 [US2] 在 `cloudfunctions/account/lib/actions.js` 接入全部管理动作，并为每个成功动作调用 `audit.js` 写记录
- [x] T047 [P] [US2] 新建 `miniprogram/lib/admin.js`：管理页的数据组织与入参校验（码生成表单的次数与有效期范围、用户列表分页状态），与页面渲染分离便于测试
- [x] T048 [US2] 新建 `miniprogram/pages/admin/admin.js`、`admin.json`、`admin.wxml`、`admin.wxss`：用户列表（分页、状态与角色显示、停用／恢复操作）、邀请码区块（生成表单、码列表含已用次数与有效期、复制码值、停用）；沿用首页配色风格
- [x] T049 [US2] 在 `miniprogram/app.json` 的 `pages` 数组注册 `pages/admin/admin`（不使用 tabBar）
- [x] T050 [US2] 改 `miniprogram/pages/index/index.js` 与 `index.wxml`：`me` 返回 `role === 'admin'` 时显示管理入口并用 `wx.navigateTo` 跳转；member 与未开通身份不渲染该入口
- [x] T051 [P] [US2] 在 `tests/frontend.test.js` 增加用例：`role` 为 `member` 时不渲染管理入口；`role` 为 `admin` 时渲染；管理页入参校验拒绝越界的次数与有效期

**Checkpoint**: admin 能在手机上完成全部用户与码管理；member 既看不到入口也调不通接口。

---

## Phase 5: User Story 4 - 从单人白名单平滑切换 (Priority: P1)

**Goal**: 切换过程中现有已授权账号不掉线、不需要重新要码，维护者切换后仍能管理。

**Independent Test**: 在现有白名单有记录的状态下迁移，白名单账号无需邀请码即可使用；至少一个账号具备 admin 能力；重复执行迁移不产生重复或冲突记录。

### 测试（先写，确认失败）

- [x] T052 [P] [US4] 在 `tests/admin.test.js` 增加迁移用例：静态名单有 N 个身份且用户记录为空时，建出 N 条 `active`/`member` 且 `grantedVia` 为 `'migration'`；返回 `{created, skipped, total}` 与实际一致
- [x] T053 [US4] 在 `tests/admin.test.js` 增加**幂等**用例：重复执行迁移时 `created` 为 0、`skipped` 为 N，不产生重复记录；名单中已被手动改为 admin 的身份不被改回 member；已被停用的身份不被改回 `active`
- [x] T054 [P] [US4] 在 `tests/admin.test.js` 断言非 admin 调用 `migrateWhitelist` 返回 `FORBIDDEN`

### 实现

- [x] T055 [US4] 在 `cloudfunctions/account/lib/admin.js` 实现 `migrateWhitelist`：读取服务端配置的静态名单，逐个身份「无记录则建为 `active`/`member` 且 `grantedVia='migration'`，有记录则跳过且不覆盖 `role` 与 `status`」，返回 `{created, skipped, total}`，并写审计
- [x] T056 [US4] 在 `cloudfunctions/account/lib/access.js` 确认迁移窗口回落分支由独立配置开关控制（而非与静态名单是否为空耦合），使窗口可显式开启和关闭
- [x] T057 [US4] 在 `docs/operations/` 新建或更新运行记录的迁移小节：写明两步部署顺序（带回落版本 → 执行迁移 → 回读确认 → 去回落版本 → 清空 `DFP_ALLOWED_OPENIDS`）、窗口起止时间、`DFP_BOOTSTRAP_ADMIN_OPENID` 当前值的来源与核对时间（不写入值本身）

**Checkpoint**: 迁移可重复执行且不覆盖已变更状态；判定来源在窗口结束后唯一。

---

## Phase 6: User Story 3 - 收藏跟人走，换设备不丢 (Priority: P2)

**Goal**: 收藏按身份存云端，换设备不丢；各人收藏互不可见。升级时本机已有收藏不丢。

**Independent Test**: A 账号收藏后清除本地存储再进入，收藏仍在；B 账号看不到 A 的收藏；本机已有收藏的账号升级后原收藏保留。

### 测试（先写，确认失败）

- [x] T058 [P] [US3] 新建 `tests/favorites.test.js`：收藏与取消收藏返回真实计数；换身份读取只看到自己的；请求参数传他人 `openId` 无效且仍读写调用者自己的文档
- [x] T059 [P] [US3] 在 `tests/favorites.test.js` 增加合并用例：本机有、云端空时合并后云端含全部条目且 `mergedAt` 非空；两侧都有不同条目时取并集且同一 `noteId` 保留较早时间戳；重复调用合并幂等不丢条目；空的一侧不覆盖另一侧
- [x] T060 [P] [US3] 在 `tests/favorites.test.js` 增加失败与上限用例：写入失败返回失败且不清空已有数据；超过 500 条软上限时新增返回 `LIMIT_EXCEEDED` 且不部分写入；`noteId` 不匹配 `^[0-9a-f]{24}$` 时返回 `INVALID_ARGUMENT`
- [x] T061 [P] [US3] 在 `tests/favorites.test.js` 增加停用用例：被停用身份读写收藏返回 `SUSPENDED`；恢复后数据完整

### 实现

- [x] T062 [US3] 新建 `cloudfunctions/account/lib/favorites.js`：`dfp_favorites/{openId}` 的读写。字段按 data-model：`items` 键为 24 位十六进制 `noteId`、值为正安全整数时间戳，`updatedAt` 为 ISO 8601，`mergedAt` 可空。文档 ID 一律取自调用上下文的 openId，不从请求参数取
- [x] T063 [US3] 在 `cloudfunctions/account/lib/favorites.js` 实现合并：与云端 `items` 取并集，同一 `noteId` 保留较早时间戳，写入 `mergedAt`；重复调用幂等；条数超过 500 条软上限时拒绝新增并返回 `LIMIT_EXCEEDED`，接近上限时在返回值中带提示标记
- [x] T064 [US3] 在 `cloudfunctions/account/lib/actions.js` 接入 `favorites.list`、`favorites.toggle`、`favorites.merge`
- [x] T065 [US3] 改 `miniprogram/lib/favorites.js`：保留本机读取能力用于迁移来源，收藏状态改以服务端返回为权威；写入失败时明确返回失败，不显示虚假成功，不丢弃已有数据
- [x] T066 [US3] 改 `miniprogram/pages/index/index.js`：首次进入新版本且云端 `mergedAt` 为空且本机有收藏时调用 `favorites.merge`；合并失败保留本机副本并提示，不清空本机数据；收藏列表改为先取 `favorites.list` 的 `noteId` 再调 `catalog.getNotes` 取内容
- [x] T067 [US3] 改 `miniprogram/pages/index/index.wxml`：把收藏页的「保存在这台手机上」文案改为反映云端存储的说明；接近条数上限时显示提示
- [x] T068 [P] [US3] 在 `tests/frontend.test.js` 增加用例：本机有收藏且云端未合并时触发一次合并；合并失败时本机数据保留且有提示；收藏写入失败时不显示「已收藏」

**Checkpoint**: 收藏按身份隔离、跨设备可见、本机旧数据不丢。

---

## Phase 7: 部署、配额核实与验收

**Purpose**: 把改动真正上线并取得实际证据。**本阶段前 T069 必须有结论。**

- [x] T069 回读腾讯云开发控制台并记入运行记录：个人版套餐的云函数调用次数、数据库读／写次数、存储容量的配额与当前已用量，以及 `EnableOverrun` 当前值（运行记录已载为 `true`，需复核）。对照 [research.md 7.4](research.md) 的估算判断 100 用户是否安全。**此项需要控制台访问权限，由维护者执行**；没有这组数字不得按 100 用户规模对外开通
- [ ] T070 根据 T069 结论决定是否采纳 [research.md 7.5](research.md) 第 3 项（`status` 聚合为单文档读）与第 4 项（轮询退避）。第 4 项涉及修改 001 的 FR-020，须先获得用户确认才能实施；两项都不在本阶段擅自改动
- [x] T071 按 `npm run prepare:functions` → `npm test` → `npm run typecheck:mini` → `npm run check:package` 顺序在确定提交上跑一个权威批次，记录退出码与通过／失败／跳过数
- [x] T072 部署带迁移窗口回落的 `account` 与 `catalog` 版本；在云端为 `dfp_users`、`dfp_invites`、`dfp_favorites`、`dfp_redeem_attempts`、`dfp_access_log` 设置 ADMINONLY 权限并回读确认
- [ ] T073 配置 `DFP_BOOTSTRAP_ADMIN_OPENID` 为维护账号身份，用该账号打开一次确认被建为 admin 且管理入口出现
- [ ] T074 调用 `admin.migrateWhitelist` 执行迁移，回读确认原白名单身份均已有用户记录，并在运行记录写明迁移时间与 `{created, skipped, total}`
- [ ] T075 部署去掉回落分支的版本，清空云函数环境变量 `DFP_ALLOWED_OPENIDS`，确认已迁移用户仍可正常使用
- [ ] T076 按 [quickstart.md](quickstart.md)「云端验证」8 项逐项执行并把真实结果写入运行记录：引导管理员、生成码、未开通账号只见引导、开通、码用尽被拒、停用与恢复、收藏跨设备、最后一个 admin 保护。**模拟器结果不能替代真机**
- [x] T077 本功能属高风险（权限、身份隔离、数据迁移、改动超过 10 个文件），安排独立审查：核对逻辑、安全、现有约定与多余改动；修复阻塞项后复审受影响部分

---

## Phase 8: Polish & 收尾

- [x] T078 [P] 更新 `specs/003-wechat-login-roles/spec.md` 的 Status 栏为实际实施状态，并在 [001 规格](../001-wechat-member-trial/spec.md) 的 FR-023 处标注已被本功能修订
- [x] T079 [P] 更新 `docs/standards/README.md` 第 2 节的事实来源清单，加入本功能目录
- [x] T080 [P] 在运行记录中记录 `DFP_CAPTURE_CALLER_FOR_SETUP` 已随 T020 移除，以及 `DFP_ALLOWED_OPENIDS` 已停用的时间
- [x] T081 确认 001 的 T032（指定成员真机验收）状态未被本功能改动，单独跟踪

---

## 实施记录

### 2026-09-13：独立审查完成，已修 8 项

按规范对这次高风险改动做了独立审查（T077）。**未发现权限绕过**；审查确认身份只来自调用上下文、`role`/`status` 的非法值不会被放宽、管理动作由服务端独立把关、收藏按身份隔离。以下是确认成立并已修的问题：

| # | 问题 | 失败场景 | 修法 |
| --- | --- | --- | --- |
| 1 | **收藏静默丢数据**（阻塞） | 云端短暂不可用 → 页面落回本机模式 → 用户继续收藏 → 下次冷启动因 `mergedAt` 非空直接用远端覆盖本机，离线期间新增的收藏被无声删除 | `syncFavorites` 改为「本机有云端没有的条目就合并」，不再只看 `mergedAt`；`loadFavorites` 在本机模式下也重试同步，不再是单向陷阱 |
| 2 | 权限写入丢更新 | 两个管理员同时操作同一账号，后写的基于过期数据，会把前一次的停用整条还原，而两条审计都记「成功」 | `changeAccess`、`revokeInvite` 改为在事务内读-查-写 |
| 3 | 最后管理员检查的竞态 | 两个管理员同时降级自己，两次检查都读到 2 个 admin → 都通过 → 0 个管理员。且 bootstrap 只在无记录时建记录，救不回来，只能改库 | 检查与写入放进同一事务；候选名单在事务外取、事务内逐个重读（事务没有查询 API），名单过期只会让判断更严 |
| 4 | 唯一的错误出口没有日志 | 任何未预期异常都只给用户一句「服务暂时不可用」，函数日志里一个字都没有，无法区分平台故障和业务失败 | `actions.js`、`queries.js` 和两个入口的 catch 都补了 `console.error`，只记错误码和消息，不记数据 |
| 5 | 审计吞错后丢证据 | 写入失败时只打了 action 名，`actor`/`target`/`at` 全丢，无法从日志重建记录 | 整条 entry 加底层原因一起打；未知 action 也留日志。吞错本身保留——主操作已成功，不能因审计回滚 |
| 6 | 审计文档 ID 的字符集从未验证 | ID 原用 ISO 时间串，把 `:` 和 `.` 引入文档 ID，而现有 9 个集合从未用过这两个字符；一旦平台拒绝，又恰好落在吞错的 catch 里，审计表会永久为空且无人知晓 | 换成定长毫秒数加随机后缀，只含数字字母下划线，字典序仍等于时间序 |
| 7 | 读路径会写权限记录 | `catalog` 的每次查询都走 `authorize`，迁移窗口里会建记录——查询改变权限状态（原则 II）。更要紧的是：今天 catalog 造不出 admin 只因为它没配 bootstrap 变量，是运气不是设计 | `authorize` 新增 `mayProvision`，只有 `account` 传 true；`catalog` 即使被误配 bootstrap 也不会铸管理员 |
| 8 | 收藏写入被拒时没关内容 | `favorites.toggle` 返回 `SUSPENDED` 时只弹 toast，页面仍停在内容页并继续轮询 | 准入类错误码改走 `showError`，与读路径一致 |

另外修了 5 项守卫与失败路径：`usable()` 补齐 `maxUses` 校验（缺失时 `0 >= undefined` 为 false，码会变成无限次）；限流计数移入事务；`redeem` 成功后的清理失败不再把成功翻成失败；`provision` 与 `createInvite` 的 catch 改为用「重读是否存在」判断竞争，不再吞掉真实存储故障；`migrateWhitelist` 加 200 条上限，避免超时后无法区分完成与中断。`actions.js` 改为显式声明只读动作，不再靠返回值形状推断。

**一条没有改的**：`MemoryStore.transaction` 把所有事务全局串行化，所以「并发不超卖」这类用例证明的是替身的串行性，没有触碰真实并发路径。这是测试替身的固有限制，已写入 [research.md 第 4 节](research.md)，最终证据只能来自真实云端。

**一条记录为已知限制**：`collectTick` 因为共享 `store.js` 生成源，集合白名单被动扩大到包含 `dfp_users` 等。真实权限边界在云端 ADMINONLY，属形式问题，不改。

修复后：`npm test` **165 通过 / 0 失败 / 0 跳过**；`npm run typecheck:mini` 通过；`npm run check:package` 10 项通过。新增测试覆盖上述每一条，包括两个管理员同时降级自己、离线期间新增收藏在恢复后不丢、只读调用方不得建记录。

### 2026-09-13：Phase 1 至 Phase 6 完成（代码与本地验证）

`npm test` **154 通过 / 0 失败 / 0 跳过**，退出码 0；`npm run typecheck:mini` 通过；`npm run check:package` 10 项通过。

Phase 7 的部署、配额回读和真机验收**尚未进行**，T069–T077 保持未完成。配额回读需要腾讯云控制台访问权限，由维护者执行。

新增测试文件：`tests/access.test.js`（11）、`tests/users.test.js`（6）、`tests/account.test.js`（11）、`tests/invites.test.js`（13）、`tests/admin.test.js`（13）、`tests/admin-page.test.js`（8）、`tests/favorites.test.js`（13）。`tests/frontend.test.js` 从 11 个用例扩到 25 个。

Phase 3 至 Phase 6 的三处偏差：

4. **`users.js` 的测试独立成文件，不并入 `tests/admin.test.js`。** 原 T051 计划把管理页测试放进 `tests/frontend.test.js`，该文件已超过 400 行，改为新建 `tests/admin-page.test.js`（8 个用例）。
5. **`redeem` 的返回多一个 `code` 字段供审计使用。** 契约规定给客户端的是 `{role, status}`；核销函数额外返回归一化码值，由动作层写入审计后丢弃，`tests/account.test.js` 断言客户端响应里不含码值。
6. **错误码表补了 `NOT_FOUND`。** 管理动作操作一个不存在的账号或码时需要可区分的结果，原契约漏列，已补入 `contracts/account-api.md`。

收藏同步的时机与契约原文略有不同，已在契约中写明取舍：不在 60 秒轮询里同步收藏，只在取得准入时和打开收藏列表时同步，避免把轮询调用量翻倍。

### 2026-09-13：Phase 1 与 Phase 2 完成

`npm test` 89 通过 / 0 失败 / 0 跳过，退出码 0；`npm run check:package` 10 项通过；`npm run prepare:functions` 生成 8 份副本。

与计划的三处偏差，均已落到源码：

1. **`users.js` 成为记录形状的唯一源，`access.js` 单向依赖它。** 原计划让 `access.js` 自带 `ROLES`/`STATUSES`，实现时发现两个模块都在构造用户记录，是重复定义。改为 `users.js` 定义取值集合与记录构造，`access.js` 引用，依赖方向单向无环。代价是 `catalog` 多一个生成副本 `users.js`（副本清单与 `.gitignore` 已同步）。
2. **`authorize()` 返回值带上原始记录。** `me` 动作要返回开通时间，原设计会多一次数据库读。改为返回 `{openId, role, status, record}`，`record` 仅供服务端取字段，不直接回给客户端（`tests/account.test.js` 断言 `me` 的返回恰好三个字段）。
3. **`users.js` 的流转约束提前配了独立测试。** 原计划把它留到 Phase 4 随管理动作覆盖；流转约束属关键逻辑（constitution 原则 III），实现时同步建了 `tests/users.test.js`（6 个用例）。

另外更新了三个既有测试以适配新的权限来源，核心性质未削弱：`tests/catalog.test.js`（未开通由 `FORBIDDEN` 改为 `NOT_REGISTERED`，新增 `SUSPENDED`、拒绝响应无数据泄漏、读取次数三项断言）、`tests/context.test.js`（`authorize` 改异步并接 store，「不继承上次调用身份」的断言保留）、`tests/safety.test.js`（新增「配置里的名单在窗口关闭后不授权」）。

---

## Dependencies & Execution Order

### 阶段依赖

- **Phase 1 Setup**：无依赖，可立即开始
- **Phase 2 Foundational**：依赖 Phase 1；**阻塞全部用户故事**。没有它，新开通用户即使有记录也读不到数据
- **Phase 3 (US1)**：依赖 Phase 2
- **Phase 4 (US2)**：依赖 Phase 2；与 US1 有真实依赖（见下）
- **Phase 5 (US4)**：依赖 Phase 2 与 Phase 4 的 `admin.js`
- **Phase 6 (US3)**：依赖 Phase 2，与 US1／US2／US4 相互独立
- **Phase 7 部署验收**：依赖全部已实施的故事；T069 需在 T075 之前有结论
- **Phase 8 收尾**：依赖 Phase 7

### 故事间的真实依赖

US1 与 US2 **不是完全独立的**：真机上「新用户凭码开通」需要先有码，而码由 admin 生成（US2 的 `createInvite`）。处理方式：

- 单元测试里 US1 的码由测试直接造库，因此 US1 的测试与实现可以先于 US2 完成。
- 真机端到端验证「开通」必须等 US2 的 `createInvite` 可用，或由维护者在控制台手工写一条码文档。
- 因此 MVP 的可演示范围是「Phase 2 + Phase 3 + T044/T046 中的 `createInvite`」，而不是完整的 US2。

US3（收藏）与其余故事无依赖，可并行。

### 阶段内顺序

- 测试先写、先确认失败，再写实现（constitution 原则 III）
- `access.js` 与 `users.js` 先于依赖它们的 `invites.js`、`admin.js`、`favorites.js`
- 服务端动作先于对应的小程序页面改动
- T017、T018、T019 改同一个文件 `queries.js`，必须顺序执行，不可并行

### 并行机会

- Phase 1 中 T002 与 T006 可并行（不同文件）
- Phase 2 的测试 T007–T011 可并行撰写（T007、T008、T009 同属 `access.test.js`，需顺序写入同一文件）
- Phase 3 的 T022、T023、T024、T026、T027 同属 `invites.test.js`，顺序写入；T032 独立文件可并行
- Phase 4 与 Phase 6 在 Phase 2 完成后可由不同人并行推进
- 标 [P] 且分属不同文件的任务可同时进行

---

## Implementation Strategy

### MVP 优先

1. Phase 1 Setup
2. Phase 2 Foundational（**关键，阻塞一切**）
3. Phase 3 User Story 1 + Phase 4 的 `createInvite` 部分
4. **停下验证**：新身份凭码开通并看到内容；未开通身份拿不到任何数据
5. 此时可以给真实用户试用

### 增量交付

1. Setup + Foundational → 权限判定来源已切换
2. + US1 → 自助开通可用（MVP）
3. + US2 → 管理能力完整，不再需要手工写库
4. + US4 → 现有用户平滑迁移，旧机制下线
5. + US3 → 收藏跨设备

每步结束时受影响测试可跑通，不破坏已完成的部分。

### 验证节奏

开发中只跑受影响测试（例如只改邀请码逻辑就只跑 `tests/invites.test.js`）。前端改动补 `npm run typecheck:mini`。全量批次在 T071 的确定提交上跑一次，不在各阶段重复。

---

## Notes

- [P] 表示不同文件、无未完成依赖
- 生成副本（`store.js`、`context.js`、`catalog/lib/access.js`）不直接编辑，改源后跑 `npm run prepare:functions`
- 任何「完成」声明都要带实际结果：命令、退出码、通过／失败／跳过数
- 未运行、失败或未上线的项必须明说，不制造进度
- 同一问题连续三次修复失败时停止补丁，讨论根本原因
