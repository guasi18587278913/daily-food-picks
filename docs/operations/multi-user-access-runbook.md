# 多用户权限运行记录

功能：[003-wechat-login-roles](../../specs/003-wechat-login-roles/spec.md)。本文件记录部署、授权和验收的真实事实。

整理日期：2026-09-13。**本轮只完成本地开发与验证，尚未部署、尚未回读云端配额、尚未迁移。**下面带「待完成」的项都还没有真实结果。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 本地实现与测试 | 已完成。`npm test` 165 通过 / 0 失败 / 0 跳过；`npm run typecheck:mini` 通过；`npm run check:package` 10 项通过 |
| 云端部署 | 已完成（2026-09-13 夜）。`account` 与 `catalog` 均 Active |
| 集合权限设置 | 已完成。5 个新集合均回读确认为 `ADMINONLY` |
| 配额回读 | 已完成。个人版 20 万次调用/月；**现有代码撑不住 100 用户**，见下节 |
| 初始管理员引导 | **待完成**——需要先上传新版小程序体验版，再用维护账号打开一次 |
| 白名单迁移 | **待完成** |
| 真机验收 | **待完成** |
| 独立审查 | 已完成。未发现权限绕过；8 项确认问题已修，详见[任务清单的实施记录](../../specs/003-wechat-login-roles/tasks.md) |

001 的 T032（指定成员真机验收）独立跟踪，不因本功能视为完成或作废，见[001 运行记录](wechat-trial-runbook.md)。

## 配额回读（已完成）

回读时间：2026-09-13 23:10 前后，用 `tcb api tcb ...` 以登录态调用只读接口，未做任何写操作。

### 个人版套餐的额度（`DescribeEnvPlans`，PackageId `baas_personal`，￥39.9/月）

| 项 | 额度 |
| --- | --- |
| 调用次数 | **20 万次/月** |
| 数据库容量 | 3 GB/月 |
| QPS | 500 |
| 云函数资源使用量 | 15 万 GBs/月 |
| 云函数出流量 | 4 GB/月 |
| CDN 流量／回源 | 各 10 GB/月 |
| 静态托管容量 | 1 GB/月 |
| 资源点 | 40000 个/月 |

`DescribeBillingInfo` 复核：`EnableOverrun` 仍为 `true`，`PackageName` 为个人版，`UsageStatus` 正常，`EnvQps` 为 500。资源点扣减目前为 0。

### 当前用量（`DescribeQuotaData`，本计费周期累计）

| 指标 | 累计 |
| --- | --- |
| 数据库读 | 6753 |
| 数据库写 | 2235 |
| 云函数调用 | 1291 |
| 存储读／写 | 37 / 14 |
| CDN 回源流量 | 约 0.5 MB |

### 关键发现：轮询就是成本本身

`DescribeCurveData` 取 9-13 全天、5 分钟粒度，凌晨无人使用的时段有一条**恒定基线**：

- 每 5 分钟 **5 次**云函数调用 = 每分钟 1 次
- 每 5 分钟 **20 次**数据库读 = 每次调用 4 次读

这正是一个打开着的页面在按 001 的 FR-020 做 60 秒轮询，每次 `status` 读 4 个文档。该基线在 12:25 前后归零——页面被关掉的时刻。

**换算：一个一直开着的页面，每天产生 1440 次函数调用和 5760 次数据库读。**

按调用次数口径（函数调用 + 数据库读写 + 存储读写）估算：

| 情形 | 每月调用次数 | 对 20 万配额 |
| --- | --- | --- |
| 1 个页面一直开着 | 约 21.6 万 | **已超** |
| 100 用户，每人每天前台 30 分钟（现状代码） | 约 45 万 | **超 2.2 倍** |
| 100 用户 + `status` 聚合为单文档读 | 约 27 万 | 仍超 |
| 100 用户 + 聚合 + 轮询退避到 3 分钟 | 约 9 万 | 安全 |

**不确定的一点**：官方没有给出"调用次数"的精确构成，上表按"函数调用 + 数据库读写 + 存储读写"合计。即使只算数据库读，单个常开页面也是每月 17.3 万次，同样贴着 20 万的线。

### 结论

1. **当前代码不能支撑 100 用户。** `EnableOverrun=true` 意味着超出直接产生账单，不会被拦下。
2. [research.md 7.5](../../specs/003-wechat-login-roles/research.md) 的第 3 项（`status` 聚合为单文档读）从"可选"变为**必做**。
3. 第 4 项（轮询退避）从"待定"变为**必需**。它会改动 001 已确认的 FR-020（前台每 60 秒检查一次），属于需求变更，**必须先获得用户确认**。
4. 本次已完成的两项读取优化（消除重复读、单次调用内记忆）对轮询路径是净持平——省下的一次快照读恰好被新增的权限读抵消。它们对收藏页仍然有效。

## 部署顺序

每一步完成后回读确认，再进行下一步。不要跳步。

### 1. 创建集合并设权限

新建 `dfp_users`、`dfp_invites`、`dfp_favorites`、`dfp_redeem_attempts`、`dfp_access_log`，全部设为 **ADMINONLY**（仅管理端可读写）。回读确认权限已生效——客户端不能直连读写是本功能的底线之一（spec FR-017、FR-018）。

### 2. 部署带迁移窗口的版本（已完成）

实际执行记录见本节末尾的「部署实况」。下面保留步骤说明供重做时参考。

```
npm run prepare:functions    # 刷新生成副本，不要直接改副本
npm run check:package        # 确认副本一致、客户端包无凭据
```

部署 `account` 与 `catalog` 两个云函数。环境变量：

| 变量 | 本步取值 |
| --- | --- |
| `DFP_APP_ID` | `wx8a2388888683b769` |
| `DFP_BOOTSTRAP_ADMIN_OPENID` | 维护账号的 openId |
| `DFP_MIGRATION_FALLBACK` | `true`（窗口开启） |
| `DFP_ALLOWED_OPENIDS` | 保持现有名单不动 |

`DFP_BOOTSTRAP_ADMIN_OPENID` 的值只放在云函数环境变量里，**不写进本文件、不进 Git、不出现在截图或命令行参数中**。本文件只记录"已配置"和核对时间。

窗口开启期间，名单里的身份即使还没有用户记录也能正常使用——现有用户不会因为部署而掉线（spec FR-026）。他们第一次打开时会被懒迁移成正式记录。

### 3. 引导初始管理员

用维护账号打开一次小程序，确认：

- 用户记录被建为 `active`/`admin`，`grantedVia` 为 `bootstrap`。
- 首页出现「管理」入口，member 账号看不到。

### 4. 执行迁移

在管理页或直接调用 `admin.migrateWhitelist`，记录返回的 `{created, skipped, total}`：

| 执行时间 | created | skipped | total |
| --- | --- | --- | --- |
| 待填 | 待填 | 待填 | 待填 |

回读 `dfp_users`，确认原名单里每个身份都已有记录。迁移是幂等的，重复执行不会产生重复记录，也不会覆盖已被改过的角色或状态。

### 5. 关闭窗口

确认第 4 步无遗漏后：

- `DFP_MIGRATION_FALLBACK` 置为 `false`
- `DFP_ALLOWED_OPENIDS` 清空

重新部署并确认已迁移用户仍可正常使用。此后权限判定来源唯一：只看 `dfp_users` 的记录（spec FR-002、FR-027）。

| 窗口开启时间 | 窗口关闭时间 |
| --- | --- |
| 待填 | 待填 |

## 真机验收

按 [quickstart.md](../../specs/003-wechat-login-roles/quickstart.md)「云端验证」逐项执行。**模拟器结果不能替代真机。**

| 项 | 结果 | 时间 |
| --- | --- | --- |
| 引导初始管理员 | 待完成 | — |
| 生成邀请码 | 待完成 | — |
| 未开通账号只看到开通引导，且无选题数据请求发出 | 待完成 | — |
| 输入邀请码后当前会话直接可用 | 待完成 | — |
| 同一码用尽后第三个账号被拒 | 待完成 | — |
| 停用后该账号看到停用提示，恢复后内容与收藏完整 | 待完成 | — |
| 清除本地存储后重进，收藏仍在 | 待完成 | — |
| 尝试停用唯一管理员被拒 | 待完成 | — |

## 真机必须验的两件事（单元测试证明不了）

**一、邀请码并发核销。** 测试用的内存替身把所有事务全局串行化，所以「两人同时用最后一次」这个用例证明的是替身的串行性，没有触碰真实的并发路径。真实 `runTransaction` 的冲突重试、重试后的错误映射都没被覆盖。上线后用两个账号同时提交同一个 `maxUses=1` 的码，确认只有一个成功、`usedCount` 恰好为 1。

**二、`dfp_access_log` 真的有行。** 文档 ID 已改成只含数字字母下划线的形状（定长毫秒数加随机后缀），避开了 ISO 时间串里 `:` 和 `.` 这两个本项目从未验证过的字符。但审计写入失败是被有意吞掉的（主操作已成功，不能回滚），所以上线后必须人工确认：做一次停用操作，然后回读 `dfp_access_log` 确认有记录。如果为空，去函数日志找 `audit write failed`——失败时整条记录会打在那里，可以重建。

## 已实现的安全边界

以下由代码和测试保证，部署后应在真机抽查：

- 身份只取自本次云函数调用的平台上下文；请求参数里的 `OPENID`／`APPID` 一律忽略（`tests/access.test.js`、`tests/context.test.js`）。
- 未开通、已停用账号在 `catalog` 的 5 个 action 上全部被拒，且响应不含选题内容、图片地址或轮次信息（`tests/catalog.test.js`）。
- 邀请码核销在事务内完成：并发提交仅剩一次的码只有一个成功，`usedCount` 不会超过 `maxUses`（`tests/invites.test.js`）。
- 连续 10 次错误提交后限流，且限流期间不再读取邀请码文档；已开通账号的重复提交不计入（`tests/invites.test.js`）。
- 系统始终保留至少一个可用管理员，包括拒绝管理员停用或降级自己（`tests/admin.test.js`）。
- 收藏按身份隔离，请求参数传他人 openId 无效（`tests/favorites.test.js`）。
- 管理操作全部写入 `dfp_access_log`；被拒的操作不写（`tests/admin.test.js`）。
- 权限变更在事务内完成：两个管理员同时操作同一账号不会互相覆盖，同时降级自己不会把管理员清零（`tests/admin.test.js`）。
- `catalog` 的查询路径**不能**创建权限记录，即使被误配了初始管理员变量也铸不出管理员（`tests/access.test.js`）。
- 云端收藏不可用时页面落回本机模式，恢复后本机新增的收藏会合并上去而不是被覆盖（`tests/frontend.test.js`）。

## 本轮顺带修掉的读取浪费

`catalog` 的 `status` 动作原先对同一个快照文档发起两次读取（`revision` 与 `snapshotId` 两个三元表达式各调一次 `published()`）。`status` 是被每 60 秒轮询的接口，放大倍数最高，已改为求值一次后复用。

`published()` 另外加了单次调用内的记忆：收藏页一次取 20 篇、来自 3–5 个轮次时，对 `dfp_snapshots` 的读取从 20 次降到轮次数。记忆容器随调用结束释放，不跨调用保留（constitution 原则 IV）。

两项都有读取次数断言覆盖，返回值与优化前逐字段相同（`tests/catalog.test.js`）。

## 注意事项

- 生成副本（`catalog/lib/access.js`、`catalog/lib/users.js`、两个函数的 `store.js` 与 `context.js`）不要直接编辑；改源后跑 `npm run prepare:functions`。
- 本功能不触发任何收费采集。开通、管理和收藏读写都只访问已保存数据。
- 个人主体不能开通微信支付，本次不做付费能力。要收费需先变更主体资质，属独立决策。
- 不要用历史付费脚本验证本功能。


## 部署实况（2026-09-13 夜）

全程用 `tcb` 的登录态执行，未使用 `tccli`（未配置密钥）。

### 已完成

1. **集合**：`CreateTable` 建出 5 个集合，`ModifyDatabaseACL` 设为 `ADMINONLY`，逐个 `DescribeDatabaseACL` 回读确认。
2. **函数**：`account`（新建）与 `catalog`（覆盖）均部署成功，状态 Active，Nodejs20.19 / 30s / 256MB。
3. **环境变量**（回读确认）：
   - `account`：`DFP_APP_ID`、`DFP_ENV_ID`、`DFP_BOOTSTRAP_ADMIN_OPENID`（已设置）、`DFP_MIGRATION_FALLBACK=true`、`DFP_ALLOWED_OPENIDS`（已设置）
   - `catalog`：同上但无 bootstrap 项；`DFP_CAPTURE_CALLER_FOR_SETUP` 已随本次清除
4. **未部署 `collectTick`**：它在 22:07 被另一条工作线部署过（`feature/today-hot-sweep` 改了 `budget`/`config`/`provider`/`publisher`/`runner`）。本功能只改了它的 `store.js` 集合白名单，而采集本身不读写新集合，因此跳过它不影响功能，也避免回退别人的部署。
5. **无身份调用被拒**：用 CLI（管理员身份、无微信上下文）调用 `account.me`、`account.redeem`、`account.admin.listUsers`、`catalog.status`，全部返回 `UNAUTHENTICATED`。这复核了 001 记录里提过的那个旧问题没有复发。

### 部署中发现并修掉的一个回归

按独立审查给 `authorize` 加 `mayProvision` 开关时，把迁移窗口的**放行判定**也一起挡住了。后果：白名单里但尚无用户记录的身份，通过 `catalog`（只读、不传该开关）会被判成 `NOT_REGISTERED`——**现有用户会在这次部署的瞬间掉线**，违反 spec FR-026。

修法：`mayProvision` 只决定能否**写**记录，不决定能否通过。迁移窗口内，只读调用方对名单内身份放行且始终按 `member` 处理，不写记录、也永远拿不到 admin 角色。已加回归测试（`tests/access.test.js`「deploying the migration window does not sign existing users out of the read path」），修复版本已重新部署并复验。

### 下一步（需要在微信开发者工具里做）

云端已就绪，但小程序前端还是旧版本，它不会调用 `account` 函数。因此：

1. 用微信开发者工具打开本项目，上传新版本并设为体验版。
2. 用**维护账号**打开一次——这会触发 `account.me`，按 `DFP_BOOTSTRAP_ADMIN_OPENID` 建出 admin 记录，首页出现「管理」入口。
3. 在管理页生成邀请码，或先执行一次 `admin.migrateWhitelist` 把白名单身份转成正式记录。
4. 确认无遗漏后，把 `DFP_MIGRATION_FALLBACK` 置为 `false`、清空 `DFP_ALLOWED_OPENIDS` 并重新部署，让权限判定来源唯一。

在第 4 步完成前，旧版小程序仍可正常使用——迁移窗口就是为此开着的。
