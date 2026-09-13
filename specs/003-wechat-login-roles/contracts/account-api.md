# 云函数接口契约：开通、管理与收藏

本契约描述新增 `account` 云函数的行为约定，以及 `catalog` 在权限判定上的变化。部署、授权和真实验收以[任务清单](../tasks.md)和运行记录为准。

沿用 001 的响应形式：成功 `{ok:true,data:{...}}`，失败 `{ok:false,error:{code,message}}`。小程序不能仅凭网络请求成功认为业务成功。

## 共用的身份与权限约定

所有 action（`redeem` 除外的权限要求见下）都先完成同一套校验，顺序固定：

1. 从本次调用上下文读取 `APPID` 与 `OPENID`。缺失、与配置的 AppID 不符、格式异常或别名冲突 → `UNAUTHENTICATED`。不接受请求参数里的任何身份字段。
2. 读取 `dfp_users/{openId}`。无记录 → `NOT_REGISTERED`；`status` 为 `suspended` → `SUSPENDED`；`role` 或 `status` 缺失或非法值 → 按无权限处理，不放宽。
3. 管理类 action 额外要求 `role === 'admin'`，否则 `FORBIDDEN`。

单次调用内只读一次用户记录，由入口统一向下传递。**不得跨调用缓存权限结果**（constitution 原则 IV）。

错误响应不得携带任何选题作品、图片地址、其他用户信息或邀请码明文。

### 错误码

| 码 | 含义 | 客户端表现 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 身份缺失或不可信 | 提示从微信重新进入 |
| `NOT_REGISTERED` | 尚未开通 | 显示开通引导与邀请码输入 |
| `SUSPENDED` | 已停用 | 提示已停用，联系管理员 |
| `FORBIDDEN` | 已开通但无此操作权限 | 不显示该入口；误触时提示无权限 |
| `INVALID_ARGUMENT` | 入参不合法 | 提示请求内容不正确 |
| `NOT_FOUND` | 目标账号或邀请码不存在 | 提示找不到对象 |
| `CODE_NOT_FOUND` | 码不存在或已停用 | 统一提示邀请码无效 |
| `CODE_EXPIRED` | 码已过期 | 提示邀请码已过期 |
| `CODE_EXHAUSTED` | 码已用尽 | 提示邀请码已被用完 |
| `ALREADY_REGISTERED` | 已开通，无需再次提交 | 直接进入内容 |
| `TOO_MANY_ATTEMPTS` | 错误提交过多 | 提示稍后再试及恢复时间 |
| `LAST_ADMIN` | 会导致无可用管理员 | 提示拒绝原因 |
| `LIMIT_EXCEEDED` | 超出收藏条数上限 | 提示清理后再收藏 |
| `BACKEND_UNAVAILABLE` | 其他失败 | 提示稍后再试，保留原有内容 |

`CODE_NOT_FOUND` 对"不存在"和"已停用"使用同一个码和同一条提示，避免泄露某个码是否曾经存在（spec FR-012）。过期与用尽是已持有有效码的用户需要知道的区别，单独给码。

## account

### redeem（开通）

唯一不要求已有用户记录的 action。

入参：`code`，字符串，去首尾空白并转大写后须匹配 `^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$`（允许输入时含分隔符，服务端剥离）。

行为：

1. 校验身份（上述第 1 步）。
2. 检查 `dfp_redeem_attempts/{openId}`：窗口内失败达 10 次 → `TOO_MANY_ATTEMPTS`，带恢复时间，不读取邀请码。
3. 在一个事务内：读 `dfp_invites/{归一化码值}` → 校验 `active`、未过期、`usedCount < maxUses` → 读 `dfp_users/{openId}` → 按下表决定结果 → 写入。

| 用户现状 | 结果 | 是否扣减码次数 |
| --- | --- | --- |
| 无记录 | 建为 `active`/`member`，`grantedVia='invite'`，记录 `inviteCode` | 是 |
| 已有 `active` 记录 | `ALREADY_REGISTERED` | 否 |
| 已有 `suspended` 记录 | `SUSPENDED` | 否 |

4. 成功：删除 `dfp_redeem_attempts/{openId}`，写 `dfp_access_log`。失败且属于码本身的问题：递增失败计数。

返回：`{role, status}`，不返回码的剩余次数、有效期或其他用户信息。

**不变量**：`usedCount` 永不超过 `maxUses`。并发提交同一个仅剩一次的码，只有一个成功（spec FR-010）。

### me（当前身份）

入参：无。

返回：`{role, status, grantedAt}`。未开通时返回 `NOT_REGISTERED` 而非空对象——客户端据此决定显示开通引导还是选题内容。

此 action 是客户端判断显示哪个界面的唯一依据，不由客户端自行推断。

### favorites.list

入参：无。

返回：`{items: {noteId: timestamp}, mergedAt}`。只返回调用者自己的收藏。

### favorites.toggle

入参：`noteId`，须匹配 `^[0-9a-f]{24}$`。

行为：存在则删除，不存在则添加（值为服务端时间戳）。添加时若已达条数上限 → `LIMIT_EXCEEDED`，不部分写入。

返回：`{selected: boolean, count: number}`。

**写入失败必须返回失败**，客户端不得显示虚假成功（spec FR-024）。

### favorites.merge

入参：`items`，对象，键须匹配 noteId 格式，值须为正安全整数；条数不超过上限。

行为：与云端现有 `items` 取并集，同一 noteId 保留较早时间戳；写入 `mergedAt`。已有 `mergedAt` 时仍可重复调用（幂等，取并集不会丢数据）。

返回：`{items, mergedAt, count}`。

### admin.listUsers

要求 `role === 'admin'`。

入参：`cursor` 可空，`limit` 为 1–50（默认 20）。

返回：`{users: [{openId, role, status, grantedAt, grantedVia, inviteCode}], nextCursor}`。

**不返回**手机号、昵称、头像等未采集的资料，也不返回任何用户的收藏内容。

### admin.setUserStatus

要求 `role === 'admin'`。

入参：`openId`（目标身份）、`status`（`'active'` \| `'suspended'`）。

行为：若目标是最后一个 `active` 的 admin 且要停用 → `LAST_ADMIN`，拒绝。包括 admin 对自己的操作（spec FR-018）。成功后写 `dfp_access_log`。

**停用不删除该用户的收藏数据**（spec FR-025）。

### admin.setUserRole

要求 `role === 'admin'`。

入参：`openId`、`role`（`'admin'` \| `'member'`）。

行为：若会导致无可用 admin → `LAST_ADMIN`，拒绝。成功后写 `dfp_access_log`。

### admin.createInvite

要求 `role === 'admin'`。

入参：`maxUses`（1–100）、`expiresInDays`（1–365）、`note` 可空（≤50 字符）。

行为：服务端生成码值（10 位，指定字符集，加密安全随机源）。若生成的码值已存在则重试，最多若干次后报 `BACKEND_UNAVAILABLE`，不覆盖已有码。

返回：`{code, maxUses, expiresAt}`。码值**只在创建时和 listInvites 中返回给 admin**，不返回给其他角色。

### admin.listInvites

要求 `role === 'admin'`。

入参：`cursor` 可空，`limit` 为 1–50。

返回：`{invites: [{code, maxUses, usedCount, expiresAt, active, createdAt, note}], nextCursor}`。

### admin.revokeInvite

要求 `role === 'admin'`。

入参：`code`。

行为：置 `active = false`。**不回收已用该码开通的用户**（spec FR-014）。成功后写 `dfp_access_log`。

### admin.migrateWhitelist

要求 `role === 'admin'`。

入参：无。

行为：读取服务端配置的静态名单，对每个身份：无用户记录 → 建为 `active`/`member`，`grantedVia='migration'`；已有记录 → 跳过，不覆盖角色和状态。

返回：`{created: number, skipped: number, total: number}`。

**幂等**：重复执行结果一致，不产生重复记录（spec FR-026）。

## catalog 的变化

现有 5 个 action（`status`、`listRounds`、`getRound`、`search`、`getNotes`）的入参、返回结构和分页游标语义**全部不变**。

变化只在权限判定：

- 原来校验 `OPENID` 是否在静态名单内，改为读 `dfp_users/{openId}` 判断 `status === 'active'`。
- 未开通返回 `NOT_REGISTERED`（原为 `FORBIDDEN`），已停用返回 `SUSPENDED`。客户端按这两个码分别显示开通引导和停用提示。为兼容旧版本客户端，`FORBIDDEN` 仍保留为其他拒绝场景的码。
- 迁移窗口内，用户记录不存在时回落到静态名单判定。窗口结束后移除回落分支（research.md 第 6 节）。

`getNotes` 不再依赖本机存储作为收藏来源：客户端在取得准入时、以及每次打开收藏列表时调 `account.favorites.list`（必要时先 `favorites.merge`），把结果镜像到本机，再用这些 noteId 调 `catalog.getNotes` 取作品内容。`getNotes` 本身仍只接受合法 noteId 且最多 50 个，不开放任意文件查询。

**同步时机的取舍**：不在每 60 秒的轮询里同步收藏，只在进入小程序和打开收藏列表时同步。这样另一台设备新增的收藏在下次打开收藏页时出现，而不必为此把轮询的调用量乘以二（research.md 第 7 节的用量约束）。

## 客户端约定

### 界面分支

进入小程序后先调 `account.me`：

- `ok` 且 `status === 'active'` → 进入选题内容，`role === 'admin'` 时额外显示管理入口。
- `NOT_REGISTERED` → 只显示开通引导与邀请码输入，不发起任何选题数据请求。
- `SUSPENDED` → 显示停用提示，不发起选题数据请求。
- `UNAUTHENTICATED` → 提示从微信重新进入。

管理入口的显示只是界面便利，不构成权限。服务端对每个管理 action 独立校验（spec FR-006）。

### 收藏迁移

首次进入新版本时，若本机有收藏且云端 `mergedAt` 为空，调用 `favorites.merge` 上传本机条目。合并成功后以云端为权威来源；合并失败保留本机副本并提示，不清空本机数据（spec FR-023）。

### 轮询

沿用 001 约定：进入或返回页面调用 `status`，前台每 60 秒检查，离开或后台取消定时器。未开通和已停用状态下**不得发起轮询**，避免无权限请求持续消耗配额。

刷新动作绝不能调用 `collectTick`。

## 部署配置

新增云函数 `account` 须加入 `config/cloudbaserc.example.json` 的 functions 列表。示例配置中的 `DFP_BOOTSTRAP_ADMIN_OPENID` 必须为空，真实值由安全环境提供。配置项清单见 [data-model.md](../data-model.md) 末尾。

`admin.migrateWhitelist` 的输入是 `DFP_ALLOWED_OPENIDS`，与迁移窗口回落共用同一份名单，但开关是独立的 `DFP_MIGRATION_FALLBACK`。

新增的五个集合须设为 ADMINONLY。`scripts/check-package.js` 的生成副本一致性清单要加入新的共享模块条目。
