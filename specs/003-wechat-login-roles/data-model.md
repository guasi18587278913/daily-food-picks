# 数据模型：微信登录与多用户权限体系

新增五个集合，均须设为 ADMINONLY，客户端不可直连读写。集合名加入 `cloudfunctions/collectTick/lib/store.js` 的 `COLLECTIONS` 白名单后跑 `npm run prepare:functions`。

现有 9 个集合的结构不变。

## dfp_users

一个微信身份在本产品中的访问资格。**权限判定的唯一来源。**

文档 ID：`openId`（微信平台在本次调用上下文中提供的值，不接受请求参数传入）。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `role` | string | `'admin'` \| `'member'` | 只有两档。缺失或非法值按无权限处理，不默认放宽 |
| `status` | string | `'active'` \| `'suspended'` | 缺失或非法值按无权限处理 |
| `grantedAt` | string | ISO 8601 | 开通时间 |
| `grantedVia` | string | `'invite'` \| `'bootstrap'` \| `'migration'` | 开通来源，用于追溯 |
| `inviteCode` | string \| null | 归一化码值 | `grantedVia` 为 `'invite'` 时必填 |
| `updatedAt` | string | ISO 8601 | 最近一次状态或角色变更时间 |
| `updatedBy` | string \| null | openId | 最近一次变更的操作者；自助开通时为本人 |

**状态流转**：

```
(无记录) ──邀请码核销──> active/member
(无记录) ──引导配置───> active/admin
(无记录) ──迁移────────> active/member 或 active/admin
active ──admin 停用──> suspended
suspended ──admin 恢复──> active
member ──admin 指派──> admin
admin ──admin 降级──> member   （拒绝降到无可用 admin）
```

**不允许的流转**：`suspended` 不能通过提交邀请码回到 `active`（spec Assumptions：被停用用户不能自助恢复）。邀请码核销时若发现已有记录且 `status` 为 `suspended`，拒绝并提示联系管理员，不扣减码次数。

**无记录的含义**：未开通。系统不为每个打开过小程序的人建记录，表现与无权限一致（spec FR-004）。

## dfp_invites

一次可分发的开通凭据。

文档 ID：归一化后的码值（10 位，字符集 `ABCDEFGHJKMNPQRSTVWXYZ23456789`，去掉显示用的分隔符）。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `maxUses` | number | 安全整数，1–100 | 次数上限 |
| `usedCount` | number | 安全整数，≥0，≤`maxUses` | 已用次数。只在事务内递增 |
| `expiresAt` | string | ISO 8601 | 有效期截止。过期后不能核销 |
| `active` | boolean | — | `false` 表示已停用；只影响后续核销 |
| `createdAt` | string | ISO 8601 | 创建时间 |
| `createdBy` | string | openId | 创建者，必须是 admin |
| `note` | string \| null | ≤50 字符 | 备注，便于 admin 记住发给了谁 |
| `revokedAt` | string | ISO 8601 | 只在停用时写入，便于事后追溯何时停的 |

**核销前置条件**（全部满足才扣次数）：`active === true` 且 `Date.now() < expiresAt` 且 `usedCount < maxUses`。任一不满足按 spec FR-012 给出可区分提示。

**不变量**：`usedCount` 永不超过 `maxUses`，永不为负。由事务保证（research.md 第 4 节）。

## dfp_favorites

某个用户收藏的作品集合。

文档 ID：`openId`。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `items` | object | 键为 24 位十六进制 noteId，值为收藏时间戳（正安全整数） | 与现有本机结构一致，便于迁移 |
| `updatedAt` | string | ISO 8601 | 最近一次变更时间 |
| `mergedAt` | string \| null | ISO 8601 | 本机收藏合并完成时间；非空表示该身份已完成迁移 |

**约束**：单文档上限 184000 字节（`store.js` 的 `clean()`）。按每条约 45 字节计可存约 4000 条，设 500 条软上限，接近时提示用户清理。超过硬上限时拒绝新增并明确提示，不静默丢弃。

**隔离**：读写时的文档 ID 一律取自调用上下文的 openId，不从请求参数取（spec FR-022）。

**合并规则**：取本机与云端 `items` 的并集；同一 noteId 保留较早的时间戳。合并成功后写 `mergedAt`，客户端据此不再重复上传。合并失败保留本机副本并提示（spec FR-023）。

## dfp_redeem_attempts

开通提交的失败计数，用于限流。

文档 ID：`openId`。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `windowStartedAt` | number | 毫秒时间戳 | 当前计数窗口起点 |
| `failures` | number | 安全整数，≥0 | 窗口内失败次数 |

**规则**：窗口长度 1 小时，上限 10 次失败。窗口过期时重置而非累加。成功开通后删除该文档。达到上限时拒绝并给出恢复时间（spec FR-013）。

**只约束开通提交**：已开通用户的读取不受影响。

## dfp_access_log

权限相关操作的事后核对记录。**不参与任何业务判定。**

文档 ID：`${ISO时间戳}_${随机后缀}`，保证按时间有序且不冲突。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `at` | string | ISO 8601 |
| `actor` | string | 操作者 openId |
| `action` | string | `'redeem'` \| `'suspend'` \| `'restore'` \| `'setRole'` \| `'createInvite'` \| `'revokeInvite'` \| `'migrate'` |
| `target` | string \| null | 被操作对象（openId 或码值）。`migrate` 作用于整份名单而非单一对象，记 `null` |
| `result` | string | `'ok'` \| 失败码 |

**不记录**：不记录任何选题内容、图片地址或邀请码的次数与有效期细节。`target` 里的码值本身是该操作的标识，必须保留才能事后追溯是哪个码被停用。

**文档 ID 的字符集**：用毫秒时间戳加随机后缀（`0001789... _a1b2c3d4`），只含数字、字母和下划线，与现有 9 个集合的 ID 形状一致。**不用 ISO 时间串**——那会把 `:` 和 `.` 引入文档 ID，而本项目从未对平台验证过这两个字符；定长毫秒数同样保证字典序即时间序。

**标识长度的三层约束**：`context.js` 允许至多 256 字符（防超长输入），`store.js` 的文档 ID 上限是 150，`admin.js` 校验客户端传入的 openId 与游标时用 150。三层都是 fail-closed，真实 openId 为 28 字符；最紧的一层（150）决定实际边界。

## 与现有集合的关系

| 现有集合 | 本功能的改动 |
| --- | --- |
| `dfp_state` | 无结构改动。若后续采纳 research.md 7.5 第 3 项（`status` 聚合），`dfp_state/status` 会新增发布状态字段，届时另行确认 |
| `dfp_snapshots`、`dfp_parts`、`dfp_notes`、`dfp_candidates` | 无改动。读取路径只在权限判定来源上变化 |
| `dfp_rounds`、`dfp_attempts`、`dfp_results`、`dfp_budgets` | 无改动。采集与预算逻辑不在本功能范围 |

## 废弃项

`DFP_ALLOWED_OPENIDS` 环境变量在迁移窗口结束后**不再作为业务授权来源**，并从云函数环境变量中清空（spec FR-002、FR-027）。迁移窗口内它是回落来源，窗口起止须写入运行记录。

`DFP_CAPTURE_CALLER_FOR_SETUP` 临时捕捉开关已随 T020 从 `cloudfunctions/catalog/index.js` 移除——新用户通过邀请码自助开通，不需要先捕捉身份再人工加名单。

## 配置项

| 环境变量 | 作用 | 迁移完成后 |
| --- | --- | --- |
| `DFP_APP_ID` | 校验调用方 AppID | 保留 |
| `DFP_BOOTSTRAP_ADMIN_OPENID` | 引导初始管理员；仅在该身份无用户记录时建记录 | 保留（幂等，可留空） |
| `DFP_MIGRATION_FALLBACK` | 迁移窗口开关，只有值为字符串 `true` 才打开 | 置为 `false` |
| `DFP_ALLOWED_OPENIDS` | 迁移窗口内的回落名单，也是 `admin.migrateWhitelist` 的输入 | 清空 |

`DFP_MIGRATION_FALLBACK` 与名单是否为空解耦：窗口可以显式开启和关闭，不会因为名单还在就意外放行（spec FR-027）。
