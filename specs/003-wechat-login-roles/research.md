# Phase 0 调研：微信登录与多用户权限体系

调研日期：2026-09-13。本轮只读取源码、配置、[001 运行记录](../../docs/operations/wechat-trial-runbook.md)和公开文档，没有访问云端、修改账号或发起收费调用。

## 1. 微信登录要不要 wx.login

**决定**：不引入 `wx.login` + `code2session` 换取会话，沿用现有机制——云函数从本次调用上下文读取平台注入的 `OPENID` 与 `APPID`。

**依据**：`cloudfunctions/catalog/lib/context.js` 已用 `cloudbase.parseContext(runtimeContext)` 只读本次调用的身份，并对缺失、超长和别名冲突一律拒绝。[运行记录](../../docs/operations/wechat-trial-runbook.md)记载此机制已在真实云端生效，且 6d8c605 已修掉从进程变量继承旧身份的问题。用户说的"微信登录"在小程序云开发里本来就不需要账号密码或授权弹窗：打开即有可信身份。

**代价与替代**：`wx.login` 适用于自建后端需要自己维护会话的场景，会引入 session_key 保管、过期续期和 AppSecret 使用，属于净增风险。被否决。

**影响**："注册"这一步在产品上等于"开通"，不等于"创建账号凭据"。用户不设密码、不填资料，这与 spec FR-007 一致。

## 2. 云函数怎么分工

**决定**：新建 `account` 云函数承担开通、用户与邀请码管理、收藏读写；`catalog` 保持只读选题职责，仅把权限判定来源从静态名单换成用户记录。

**依据**：constitution 原则 II 要求职责清楚、"查询不能暗中扣费或改变权限"。`catalog` 现在是纯读函数，把开通、停用、收藏写入塞进去会让同一入口既读又改权限。两个函数各自独立校验身份，符合 spec FR-006。

**共享代码**：权限判定模块的源放在 `cloudfunctions/account/lib/`，由 `scripts/prepare-functions.js` 复制到 `cloudfunctions/catalog/lib/`，沿用现有生成副本模式（当前 `store.js`、`context.js` 的源在 `collectTick/lib`，复制到 `catalog/lib`）。`account` 是用户与权限的归属模块，放在这里比放进采集函数更合理。`scripts/check-package.js` 的副本一致性清单要同步加入新条目。

**替代方案**：全部塞进 `catalog` 会少一次部署，但混淆读写职责；再拆出第三个管理专用函数会增加部署和冷启动成本，而管理操作与开通操作共用同一套用户记录和校验逻辑，没有拆开的必要。

## 3. 管理入口放哪

**决定**：新增独立页面 `miniprogram/pages/admin/admin`，从首页一个仅 admin 可见的入口 `wx.navigateTo` 进入。不使用 tabBar。

**依据**：`miniprogram/app.json` 目前只有一个页面、没有 tabBar。tabBar 是静态配置，所有用户的包里都有，按角色隐藏只能靠运行时 API，不可靠且会让 member 看到管理入口的痕迹。独立页面 + 条件渲染入口让 member 完全看不到，服务端再独立校验，构成两层。

**注意**：界面隐藏不是权限。spec FR-006 要求每个服务端入口独立校验，未开通用户直接构造请求必须被拒绝——这是测试项，不是实现细节。

## 4. 邀请码设计

**码值格式**：10 位，字符集 `ABCDEFGHJKMNPQRSTVWXYZ23456789`（30 个字符，排除易混的 I、L、O、U、0、1）。组合空间约 5.9×10^14。显示时分两段便于口述，存储和比对时去掉分隔符。提交时去首尾空白并转大写。

**存储与查找**：文档 ID 直接用归一化后的码值，核销时一次 `get` 命中，不扫描集合。码值长度和字符集满足 `store.js` 的 `validate()` 约束（≤150 字符、无 `/` 和控制字符）。

**原子核销**：用现有 `CloudStore.transaction()`（底层 `db.runTransaction`）在一个事务内完成"读码 → 校验 → 读用户 → 扣减次数 → 写用户"。`tests/helpers.js` 的 `MemoryStore.transaction` 已实现串行化语义，可以直接对并发超额写失败测试。

**依据**：spec FR-010 要求并发提交同一个仅剩一次的码只能有一个成功。非事务的"先读后写"在两个请求交错时会双双通过校验，导致 `usedCount` 超过 `maxUses`。现有 `Operations.create` 已经用事务实现"不存在才创建"，模式已验证。

**测试替身与真实语义的脱节（必须知道的限制）**：`tests/helpers.js` 的 `MemoryStore.transaction` 用单条 Promise 把**所有**事务全局串行化，并用整张文档表的快照加全量替换来提交。因此「并发不超卖」这类用例证明的是替身的串行性，**没有触碰真实的并发路径**：冲突重试、冲突后的错误映射、以及事务进行中的非事务写入都未覆盖。`MemoryStore.create` 也是非事务的，与生产 `CloudStore.create` 的原子性不同。

云端侧已核对 `@cloudbase/database` 的实现：服务端错误码经 `processReturn` 会抛出（不会被当成"文档不存在"），`runTransaction` 对 `DATABASE_TRANSACTION_CONFLICT` 会重跑回调最多 3 次。因此四个事务回调（`redeem`、`toggleFavorite`、`mergeFavorites`、`changeAccess`）都必须满足「只含事务操作、无外部副作用」才能安全重跑——当前实现满足这一点，任何后续改动都要保持。

**结论**：这几条不变量的最终证据只能来自真实云端，不能由单元测试代替。quickstart 的云端验证清单已包含对应项。

**限流**：新增集合记录每个身份的失败尝试（窗口开始时间 + 计数），成功开通后清除。默认每小时 10 次错误提交上限，达到后拒绝并说明恢复时间。限流只作用于开通提交，不影响已开通用户的读取（spec FR-013）。

**明文可读的取舍**：码必须能在管理页显示给 admin 复制分发，因此按明文存储，不存哈希。数据库为 ADMINONLY 权限、客户端无法直连，风险集中在服务端，与现有密钥管理边界一致。

## 5. 初始管理员怎么来

**决定**：保留一个服务端配置项 `DFP_BOOTSTRAP_ADMIN_OPENID`。当该身份调用且用户记录中尚无其记录时，创建为 admin；已有记录则不改动。

**依据**：spec FR-019 要求初始管理员由服务端配置引导，不能通过邀请码或客户端请求自取 admin。引导逻辑只负责"系统内无此记录时建记录"，建完之后权限判定仍然只读用户记录，不违反 FR-002 的单一判定来源。

**信任级别**：该配置项与现有 `DFP_ALLOWED_OPENIDS` 同级——只有维护者能改云函数环境变量。误设会导致提权，必须在运行记录中写明当前值的来源和核对时间。

## 6. 从白名单迁移

**决定**：迁移做成 `account` 云函数的一个动作，只有已引导的 admin 可调，幂等：对 `DFP_ALLOWED_OPENIDS` 中每个身份，若无用户记录则建为已开通 member；已有记录一律不覆盖角色和状态。

**依据**：spec FR-026 要求可重复执行且不覆盖已变更的角色或状态。做成云函数动作而非本地脚本，避免在本机引入管理员密钥。

**切换顺序**：先部署带双重判定的版本（用户记录优先，无记录时回落到静态名单）→ 执行迁移 → 回读确认所有白名单身份已有记录 → 再部署去掉回落的版本 → 清空 `DFP_ALLOWED_OPENIDS`。spec FR-027 要求判定来源唯一，所以回落只存在于迁移窗口内，不是最终状态，且必须在运行记录中写明窗口起止。

## 7. 用量与费用（spec FR-028）

### 7.1 必须先核实的事实

公开文档**取不到**个人版的确切配额数字：[微信云开发旧配额页](https://developers.weixin.qq.com/minigame/dev/wxcloud/billing/quota.html)已标注废弃，新计费改为"资源点"抽象单位（[CloudBase 价格文档](https://cloud.tencent.com/document/product/876/75213)、[资源点价格](https://cloud.tencent.com/document/product/876/127357)）。

[运行记录](../../docs/operations/wechat-trial-runbook.md)已确认的云端事实：实际套餐为**个人版**，到期 2027-03-12；控制台回读 `EnableOverrun=true`，即**超出套餐按量付费已开启**。

**这是本功能最重要的费用风险**：超配额不会被限流拒绝，而是直接产生账单。因此不能按"超了就停"来假设，必须在对外扩大用户数之前，在控制台回读个人版的云函数调用、数据库读写和存储的实际配额与当前用量。该核实列为实施任务，不在本文档推断数字。

### 7.2 当前实现的单次请求读取次数

按 `cloudfunctions/catalog/lib/queries.js` 逐行数：

| 动作 | 数据库读次数（现状） | 说明 |
| --- | --- | --- |
| `status` | 4 | `dfp_state/latest` 1 + `dfp_state/status` 1 + `published()` 2 |
| `listRounds` | 1 | 一次 list |
| `getRound` | 1 + 分片数 | snapshot 1 + 每个 part 1 |
| `getNotes`（N 篇） | 3N | 每篇 `dfp_candidates` 1 + `published()` 1 + `dfp_notes` 1 |
| `search` | 每页 1 + 命中行各 2 | list 1 + 每个候选 `published()` 1 + `dfp_candidates` 1 |

`status` 的 4 次里有 2 次是**同一个文档被读两遍**：

```js
revision: latest && await published(latest.snapshotId) ? latest.revision : null,
snapshotId: latest && await published(latest.snapshotId) ? latest.snapshotId : null
```

`published()` 每次都发起一次 `store.get`，两个三元表达式各调一次。这是纯浪费，且 `status` 是被每 60 秒轮询的接口，放大倍数最高。

### 7.3 加入权限判定后的增量

每个需要权限的入口都要读一次用户记录，这是 spec FR-002 的必然成本，不可省（不能跨调用缓存——constitution 原则 IV 禁止沿用上次调用状态）。但在**同一次调用内**只读一次，由入口统一传递。

收藏上云后 `getNotes` 路径还要加 1 次读（读该用户的收藏文档）。

### 7.4 估算（需用实测配额校验，不作为结论）

按单用户每天 3 次打开、每次约 4 分钟前台、收藏 20 篇估算：

| 项 | 每人每天调用 | 每人每天读次数（优化前） |
| --- | --- | --- |
| `status` 轮询（每 60 秒） | 12 | 12 × (4+1) = 60 |
| 首次加载 `getRound` + `listRounds` | 6 | 3 × (1+2+1+1) ≈ 15 |
| 收藏页 `getNotes` 20 篇 | 3 | 3 × (1+1+60) = 186 |
| 合计 | 21 | 约 261 |

**加入权限判定后的修正**：每个需要权限的入口多读一次 `dfp_users`，所以上表每次调用各 +1 次读。`status` 动作因为同时去掉了重复的快照读取，净变化持平（原 4 次 → 现 3 次业务读 + 1 次权限读）。收藏改为云端后，同步时多一次 `dfp_favorites` 读。按 100 用户估算从约 26000 次/天升到约 28000 次/天，量级不变，但 FR-028 的配额核实要按这个修正值判断。

100 用户：约 2100 次云函数调用/天、26000 次数据库读/天，折合每月约 6.3 万次调用、78 万次读。**数据库读是主要成本，热点是收藏页和轮询。**

### 7.5 降低用量的措施

按成本效益排序，前两项本次必做：

1. **消除 `status` 的重复 `published()` 调用**——4 读降到 3 读。纯修浪费，改动在 `queries.js` 内，无行为变化。
2. **`published()` 在单次调用内按 snapshotId 记忆**——`getNotes` 20 篇收藏通常只涉及 3–5 个轮次，该路径从 3N 降到约 2N + 轮次数（20 篇从 60 读降到约 45 读）。记忆只在一次调用的生命周期内，不跨调用，不违反 constitution 原则 IV。
3. **`status` 聚合为单文档读**——把发布状态和 revision 冗余写进 `dfp_state/status`，`status` 从 3 读降到 1 读（加权限共 2 读）。需要改 `collectTick` 的发布流程，范围更大。**建议等 7.1 的实测配额出来再决定**，不在没有数字的情况下先扩大改动面。
4. **轮询退避**——无更新时把间隔从 60 秒延长。这会改变 001 的 FR-020（"前台每 60 秒检查一次更新"），属于需求变更，必须先获得确认，不在本功能内擅自改动。列为待决项。

## 8. 新增数据集合

`dfp_users`、`dfp_invites`、`dfp_favorites`、`dfp_redeem_attempts`、`dfp_access_log`。字段定义见 [data-model.md](data-model.md)。

`cloudfunctions/collectTick/lib/store.js` 的 `COLLECTIONS` 白名单要加入这五个集合（源文件在 `collectTick/lib`，改完跑 `npm run prepare:functions` 刷新副本）。该白名单的作用是防拼写错误和路径注入，不是函数间的权限隔离——服务端函数本来都以 ADMIN 身份访问数据库。新集合同样必须设为 ADMINONLY，客户端不可直连。

## 9. 待决项

以下需要用户确认后才能推进，不在实施中自行决定：

- **轮询间隔是否允许退避**（7.5 第 4 项）。涉及修改 001 的 FR-020。
- **`status` 是否本次就做聚合优化**（7.5 第 3 项）。取决于控制台实测配额。
- **收藏条数上限**。单文档上限 184000 字节（`store.js` 的 `clean()`），按每条约 45 字节可存约 4000 条。建议设 500 条软上限并在接近时提示，避免文档膨胀影响读取性能。
