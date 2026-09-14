# Data Model

所有持久对象只在服务端读写。字段长度是本项目保护上限，不是供应商返回承诺；超限输入不得静默当完整数据使用。

## Round

- `_id`: `YYYYMMDD-HHmm`，按北京时间计划触发时刻确定；同一时刻只能有一轮。
- `ruleVersion`: 非空字符串；当前确认规则为 7 篇参照、5 天黑马。
- `scheduledAt`, `startedAt`, `finishedAt`: 带时区的 ISO 时间；完成前后两个实际字段可为空。
- `windows`: today=24 小时、week=7 天、dark=5 天；均为 `[start,end)`。
- `status`: `pending/running/complete/partial/failed/budget_exhausted`。
- `leaseOwner`, `leaseEpoch`, `leaseExpiresAt`: 防重复运行和过期工作者提交。
- `progress`: 已完成逻辑请求及阶段；最多一次自动重试，不从头重买。
- `progress.candidateIds`: 建队列时固定检查顺序。常规轮按本周→低粉→仅今日交错后截取40个；恢复时沿用该序列，不因规则部署重新排序。
- `definition.kind`: `regular`（09/12/20，窗口 20 分钟）或 `sweep`（06:00 今日新锐扫描，窗口 30 分钟）；缺省按 regular 处理。`definition.sweepEnabled` 记录建轮时是否已配置 06:00 扫描额度。
- `coverage`: 关键词、页数、类型、候选数、缺口和停止原因。常规轮发布时另含 `carriedToday`：当天 06:00 快照编号和带上的今日作品数；未启用扫描或 06:30 前的轮次为 null；06:00 缺失、未发布或读取失败时 count 为 0，并用 `errorCode`（SWEEP_MISSING / SWEEP_NOT_PUBLISHED / CORRUPT_SNAPSHOT / NOT_FOUND / CARRY_READ_FAILED）说明；前两种对应本轮缺口 SWEEP_UNAVAILABLE，后三种对应 CARRY_UNAVAILABLE。临时读取失败先在本轮窗口内重试。带上的作品保留首个推荐轮次和原有板块，不新增推荐记录或搜索行。
- `snapshotId`: 校验并发布后才设置；非发布状态为 null。

## RequestAttempt 与 Budget

- 请求键由轮次、用途、规范化参数摘要、尝试号确定；尝试号只允许 1 或 2。
- 状态为 `reserved/inflight/succeeded/failed/unknown`，unknown 仍占用预算。
- 金额必须为非负安全整数；USD 用百万分之一美元，CNY 用微元；币种分开累计，不能直接相加。
- 日预算键按北京时间日期生成；请求同时受单轮、日总额、请求数量和首轮验证上限约束。
- 价格配置必须有来源、核验时间、币种和单位；缺失或失效时拒绝收费。
- 收费网络调用禁止出现在数据库事务回调中；事务失败重试不能带来重复外部调用。

## Candidate 与 Judgment

- `noteId`, `authorId`: 非空供应商编号，当前小红书格式为 24 位十六进制；未知格式先拒绝并记录契约变化。
- `title`: 至多 2000 字符；`desc`: 至多 12000 字符；截断/不完整必须单独记录。
- `bodyComplete`: 详情明确返回完整的字符串标题和正文，且无截断标记或末尾省略号；正文可以是已知空字符串。缺失正文不是空正文，搜索结果始终不能作为完整详情。
- `type`: `video/normal`；其他类型记为不支持，不伪装图文。
- `publishedAt`: 有效带时区时间；未知则不进入时间窗口。
- `likes/collected/comments/shared/fans`: 非负安全整数或 null；未知不是 0。
- `sticky`: `true/false/null`；null 不能当作未置顶。
- `link`: HTTPS 小红书来源链接，保留原始必要参数；不允许任意协议。
- `judgment`: `cooking/not_cooking/uncertain/error`；只有 cooking 且证据有效才推荐。
- `evidence`: 输入标题或正文中的原文片段，最长500字符，模型提示最多120字符；必须验证为实际连续子串，并核对去除标签后的原字段，避免只截出标签中的“教程”。
- `evidenceSource`: title/desc；旧格式未提供时默认为desc，uncertain且无证据时可为null。视频可以引用带制作意图或操作／配方的标题，图文不能只靠标题入选。确定的排除结果同样要求原文证据，菜名不能作为标题排除依据。
- `history`: 候选之前的前 7 篇合格历史编号与点赞；缺失点赞不能跳过该篇改用第 8 篇。
- `baseline`: 7 个值的中位数，即排序后第 4 个值；值为 0 或不足 7 篇时不计算有效 ratio。
- `ratio`: 今日板块对作者前 7 篇中位数的倍率，有限非负数或 null；不能出现 Infinity/NaN。
- `fanRatio`: 黑马板块的点赞/粉丝比；与作者历史倍率分别展示，粉丝为 0 或未知时为 null。

## Snapshot、Recommendation 与 Latest

- 快照内容发布后不可变；各分片控制在 180 KiB 以下，按内容校验摘要。
- 每个快照包括板块 key、真实时间、coverage、状态和有序分片引用。
- `status`: 仅 `complete/partial` 可以成为可用快照；partial 必须携带非空说明。
- 推荐记录以笔记编号为固定键，关联首个发布轮次；未发布草稿对应标记不能造成后续永久去重。
- `Latest`: 固定键，存 snapshotId、revision 与真实发布时间；以事务校验租约后更新。
- 完成的空结果可发布明确空快照；整体失败或零有效数据且取数失败不能发布空成功。

## Access 与 Favorite

- 单用户访问白名单仅在服务端环境配置中保存，包含大芙及必要维护者的 OpenID；初始为空则拒绝数据访问。
- 身份取自微信可信调用上下文，不接受请求传入的身份作为凭证。
- 收藏本机结构为 noteId → 收藏时间；安全解析，结构损坏提示并使用可恢复的空状态。
- 收藏对应作品读取可跨历史轮次；无权限与作品已移除须区分。
- 云存储只存需要的封面；数据库保存 fileID，客户端只获得授权后的短期访问地址。
