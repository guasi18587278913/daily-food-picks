# Tasks: 单人低成本微信定时选题试用版

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[cost-options.md](cost-options.md)、[data-model.md](data-model.md)、[contracts/cloud-api.md](contracts/cloud-api.md)。

**Status**: 原试用版与 06:00 扫描已部署；2026-09-13 起日上限批准为 150 次、06:00 为 100 次。大芙真机验收和有结果时的跨轮沿用仍未完成。2026-09-14 三条工作线在独立本地分支整合，诊断和部分零结果发布已修复、未上线，见[统一收尾记录](../../docs/operations/2026-09-14-closeout.md)。

**路径约定**：源码路径相对统一项目根；`SPEC` 指 `specs/001-wechat-member-trial/`。运行证据见[运行记录](../../docs/operations/wechat-trial-runbook.md)。

**测试要求**：规格明确要求验证收费、防重、权限及定时更新，以下测试针对这些行为，不为普通文案和样式另写镜像测试。

## Phase 1: Setup

- [x] T001 在 `docs/operations/wechat-trial-runbook.md` 记录用户对 `SPEC/plan.md`、`SPEC/cost-options.md` 的整体确认、采集档位、首轮/日/模型/云资源费用上限；未确认前只做方案及离线准备。
- [x] T002 在实际代码仓库创建隔离分支并建立 `project.config.json`、`.gitignore`；核对已有改动，排除密钥、真实私有配置和原始响应，不修改现有网页。
- [x] T003 在 `config/rules.json`、`config/keywords.json` 固定已确认的 7 篇、5 天、三个板块门槛和获准覆盖；补 `config/cloudbaserc.example.json`，预算缺省为空、采集 disabled，不把建议 50 次当已获授权。
- [x] T004 在 `package.json`、`jsconfig.json` 和两个 `cloudfunctions/*/package.json` 建立依赖锁定、受影响测试和前端类型检查入口，验证 Nodejs20.19 兼容范围。

## Phase 2: Foundational

- [x] T005 在 `cloudfunctions/collectTick/lib/store.js` 建立轮次、请求、预算、不可变快照和指针的存储访问；轮次 `_id` 为北京时间 `YYYYMMDD-HHmm`；快照分片必须小于 180 KiB；状态符合数据模型枚举。
- [x] T006 [P] 在 `cloudfunctions/collectTick/lib/budget.js` 实现请求/单轮/日/首轮额度事务预留；金额必须为非负安全整数，币种分开累计；尝试号只允许 1 或 2；unknown 仍占预算，事务中不得发网络请求。
- [x] T007 [P] 在 `cloudfunctions/catalog/lib/access.js` 从可信微信上下文验证 AppID 和配置白名单，初始为空拒绝数据访问；在 `config/security-rules.json` 定义客户端数据库/存储默认拒绝直接访问；实际规则应用另在 T030 验证。
- [x] T008 在 `tests/safety.test.js` 验证无预算零调用、重复领取、并发额度、结果未知不退费、过期租约不能提交、伪造用户/定时器拒绝；采用模拟存储和录制响应，不调用付费服务。

## Phase 3: US1 — 无人值守新数据 (P1)

**独立验收**：云端真实定时触发，离线本机不参与，自动判断并发布本轮新采集结果；失败/部分覆盖/超额状态准确。

- [x] T009 [P] [US1] 在 `cloudfunctions/collectTick/lib/provider.js` 移植 TikHub 搜索/作者/粉丝/必要详情；编号为 24 位十六进制，指标为非负安全整数或 null，sticky 为 true/false/null；保留会话分页、来源时间和完整正文标记，校验报价后才允许调用。
- [x] T010 [P] [US1] 在 `cloudfunctions/collectTick/lib/ranking.js` 实现 `[start,end)` 时间窗、24 小时至少 1000 赞、7 天至少 10000 赞、5 天至少 300 赞、粉丝至多 5000；参照严格选前 7 篇，不能跳过缺赞条目凑数，中位数取第 4 个，ratio 不允许 Infinity/NaN。
- [x] T011 [US1] 在 `cloudfunctions/collectTick/lib/judge.js` 接入已核验赠额模型；title 至多 2000 字符、desc 至多 12000 字符，超限标不完整；输出 cooking/not_cooking/uncertain/error，证据最长 500 字且必须是输入子串，提示注入不能改变费用或工具。
- [x] T012 [US1] 在 `cloudfunctions/collectTick/lib/runner.js`、`index.js` 组合动态轮次、固定工作租约和分批流程；每批最多 5 请求、并发最多 2、单请求 40 秒，150 秒收尾、180 秒超时；拒绝用户直接触发和无限重试。
- [x] T013 [US1] 在 `cloudfunctions/collectTick/lib/publisher.js` 实现同轮共用与跨轮已发布去重、图片去重、结果分片校验和原子指针切换；partial 必须有说明，未发布草稿不生效为永久去重记录，整体失败保留旧快照。
- [x] T014 [US1] 在 `tests/collector.test.js` 用旧响应和构造边界验证 7 篇、5 天、未知置顶、正文不足、跨轮去重、分页、零结果与失败区别，并对照已有样本解释迁移差异。
- [x] T015 [US1] 在 `config/schedule.json`、`cloudfunctions/collectTick/lib/config.js` 配置三个更新窗口和预算分配；为 cron 生成离线时刻表，验证跨日及窗口结束不会无限补跑，首次消费仍保持关闭。

## Phase 4: US2 — 微信看到更新 (P1)

**独立验收**：授权用户看到真实最新结果和状态；未授权身份不能读取；新快照发布后 60 秒内可见且不重发小程序包。

- [x] T016 [US2] 在 `cloudfunctions/catalog/index.js`、`lib/queries.js` 实现 status/getRound/listRounds/getNotes；页长按契约 1–50 或 1–20、收藏批量最多 50，错误无敏感字段，只签本次授权结果图片。
- [x] T017 [US2] 在 `tests/catalog.test.js` 验证未授权和身份伪造、草稿不可见、稳定分页、任意 fileID 禁止签名、旧快照保留及临时图片地址异常。
- [x] T018 [US2] 在 `miniprogram/app.js`、`app.json`、`app.wxss`、`pages/index/index.json` 建立原生入口及云环境绑定，真实配置由本机提供，前端不包含供应商凭据。
- [x] T019 [US2] 在 `miniprogram/pages/index/index.js`、`index.wxml`、`index.wxss` 和 `lib/api.js` 实现三个板块、真实日期、部分结果/运行/失败/空状态与前台 60 秒检查；新版本读取失败不清空旧内容。
- [x] T020 [US2] 在 `miniprogram/lib/api.js` 和 `tests/frontend.test.js` 验证返回页面立即检查、后台停止轮询、刷新不调用采集函数、网络成功但业务失败不当成功，以及无权访问的提示。

## Phase 5: US3 — 搜索排序往期 (P2，本轮必须完成)

**独立验收**：两轮数据上完成查询、无结果、去重、排序与往期切换，查看往期时不会强制跳到最新。

- [x] T021 [US3] 在 `cloudfunctions/catalog/lib/queries.js` 实现已发布历史搜索，query 为 1–100 字符；关键词作字面匹配，不能注入原始正则或数据库表达式，多词均命中，跨轮按 noteId 去重。
- [x] T022 [US3] 在 `miniprogram/lib/view.js` 实现各板块排序、空值显示、指标和时间格式，未知不是 0，稳定处理相同数值。
- [x] T023 [US3] 在 `miniprogram/pages/index/index.js`、`index.wxml` 加搜索、清空、轮次选择、历史分页和新版本提示，保留当前历史阅读位置。
- [x] T024 [US3] 在 `tests/catalog.test.js`、`tests/frontend.test.js` 验证跨轮最新版本、重复笔记、特殊字符搜索、两种排序、空结果和往期不跳转。

## Phase 6: US4 — 收藏与原文 (P2，本轮必须完成)

**独立验收**：收藏增删与重开正确，来源复制成功/失败提示准确，至少两篇真实链接可核对目标。

- [x] T025 [US4] 在 `miniprogram/lib/favorites.js` 及页面接入本机收藏，安全校验 noteId→时间结构，保存失败不得假成功，历史目标丢失可取消收藏。
- [x] T026 [US4] 在 `miniprogram/pages/index/index.js`、`index.wxml` 实现 HTTPS 来源复制和查看说明，不承诺任意拉起 App 或免登录；缺失链接明确提示。
- [x] T027 [US4] 在 `tests/frontend.test.js` 验证收藏重开、取消、损坏/失败存储、原文复制回调及轮次更新后仍能回看收藏。

## Phase 7: Review and Trial Delivery

- [x] T028 安排独立审查全部源码及 `config/`、`cloudfunctions/` 收费和权限边界，在 `docs/operations/wechat-trial-runbook.md` 记录问题；修复后仅复查和验证受影响部分直至无阻塞项。
- [x] T029 运行 `package.json` 中当前模块测试与前端类型检查，审查差异、调试残留和敏感信息；在 `docs/operations/wechat-trial-runbook.md` 记录同一源码状态、退出码、通过数、失败数，不重复未变化的同级检查。
- [x] T030 依据 `SPEC/cost-options.md` 先核对成长计划资格、模型到账和期限，再准备获准环境与实际安全配置；在 `docs/operations/wechat-trial-runbook.md` 记录额度及脱敏标识，未获准不购买、续费、升配或设置自动充值。
- [x] T031 按 `SPEC/quickstart.md` 在获准费用内部署并执行真实定时验证，关闭本地采集，抽核内容和费用，记录在 `docs/operations/wechat-trial-runbook.md`；移除临时验收时刻并保留正式三轮。
- [ ] T032 按 `SPEC/quickstart.md` 上传体验版并添加大芙，完成指定成员真机六项与未授权访问核验；在 `docs/operations/wechat-trial-runbook.md` 记录真实结果，不能用模拟器代替，也不自动向他人发送消息。
- [x] T033 在 `docs/operations/wechat-trial-runbook.md` 完成停止/恢复指南、实际接口费用和三天观察指标；所有完成项有证据才勾选，并保留后续两个正式轮次的稳定性观察待办。

## Dependencies & Execution Order

Setup → Foundational → US1 云端新数据 → US2 微信读取 → US3 / US4 → 独立审查及交付。

US2 可使用隔离测试数据先开发，但只有接通 US1 的真实发布才能验收交付。US3、US4 都属于本轮，不得因优先级 P2 留到下轮。T030 的只读账号核验可提前，任何实际消费和部署需先完成对应确认与验证。

## Parallel Examples

- 基础存储契约完成后，T006 预算模块与 T007 读取授权可分别开发。
- US1 的 T009 字段映射与 T010 排名规则互不写同一文件，可在接口固定后并行。
- US2 页面依赖后端协议，可使用测试替身开发；联调和真机必须等待真实后端。
- US3 / US4 都修改首页和前端测试，主 Agent 顺序合并；不为了并行制造同文件冲突。

## Implementation Strategy

先验证低成本预算下的自动采集核心，再接微信读取，最后补齐全部交互与真实定时验收。每步只做受影响测试；不在每步跑全量或生产构建。

纯演示 34 篇旧数据不是本次 MVP。最小有效交付必须同时具备真实定时新数据与微信真机可用，其余已承诺交互也需完成。

任务统计：Setup 4；Foundational 4；US1 7；US2 5；US3 4；US4 3；Review/Delivery 6；合计 33。

实施备注：T011赠额通道已实际运行；T030核验了个人版实际到期、赠额到账及官方6个月期限，单独模型到期时刻未展示，已记录观测限制。T031完成19:08真实验收和20:00正式轮，临时时刻已移除。T033已有停止恢复指南与三天观察指标；两个后续正式轮次保留待观察。T032只完成上传、设体验版、添加成员及模拟器检查，大芙应用身份和真机六项仍未完成。

## Phase 8: 今日新锐 06:00 扫描（2026-09-13 变更）

**依据**：spec 的 FR-002/005/008 修订、FR-025/026 与变更记录；plan 文末同日方案。主要写入者 Claude Code；工作树 `美食博主工作台-today-sweep`，分支 `feature/today-hot-sweep`，基于 main `6943e3a`，改动尚未提交。

- [x] T034 在 `tests/daily-sweep.test.js` 先写失败用例：06:00 轮 30 分钟/100 次、未批准不扫描、配置越界拒绝、55 词一天内参数、单次触发 10 个请求、150 次共享日预算、只收今日候选、当天带上与次日不带、06:00 快照损坏时部分覆盖、带上作品不写搜索行与去重引用；更新 `tests/safety.test.js` 越界预算。实现前 11 项中 10 项因功能缺失失败。
- [x] T035 在 `config/keywords.json`、`config/rules.json`、`config/schedule.json`、`config/cloudbaserc.example.json` 写入 55 个关键词、06:00 规则、150/100 上限、每次 10 个请求和新定时表达式；示例额度保持为空。
- [x] T036 在 `cloudfunctions/collectTick/lib/config.js`、`budget.js`、`provider.js` 实现 06:00 轮次、额度校验、硬上限和“不限”笔记类型。
- [x] T037 在 `cloudfunctions/collectTick/lib/runner.js`、`publisher.js` 实现扫描搜索、今日候选接纳、当天 06:00 结果带上（保留原有板块）；06:00 缺失、未发布、损坏或读取出错时标记部分覆盖并说明，判断次数达到上限时单独说明。
- [x] T038 更新 `scripts/check-schedule.js` 离线时刻表。
- [x] T039 运行当前模块测试、时刻表与部署副本检查，记录退出码和通过/失败数。三轮审查修复后的工作树（未提交）：本机 Node 22.22.2 与云端同版本 Node 20.19.5 各跑全部 9 个测试文件，均 83/83 通过（`wx-server-sdk` 经 NODE_PATH 使用主目录依赖）；时刻表 128 项、部署副本与客户端包检查 6 项、`git diff --check` 通过；退出码均为 0。前端未改，未跑前端类型检查。
- [x] T040 安排独立审查收费、调度、发布一致性和测试缺口；修复后复审受影响部分。首轮审查无阻塞；4 项重要问题已修复并补测试：过万赞扫描作品改为同时列入本周并在当天各轮一起带上；金额上限低于次数乘单价时拒绝加载；06:00 缺失或未发布时提示；快照结构损坏或读取出错不再卡住后续轮次。另修复 3 项建议：验收时刻不得与定时窗口重叠、非扫描轮 20 次硬上限、判断次数上限单独提示。复审发现 1 项重要问题（读取 06:00 结果失败一次即定稿），并建议细查后超出今日窗口的作品不再发布；已改为窗口内重试、细查后跳过，并补测试。最后一轮复查无阻塞、无重要问题，按建议补了“带收尾原因或最后 10 秒不重试”用例。未采纳可选建议“带原因收尾时保存原因、下次只重试发布”，影响限于预算或授权收尾恰逢读取失败的那一轮。
- [x] T041 部署前向用户确认：核对 TikHub 单价与余额、云资源用量；与登录任务协调 collectTick 部署内容；设置 `DFP_DAILY_CALLS=150`、`DFP_DAILY_MICRO_USD=1500000`、`DFP_SWEEP_CALLS=100`，更新定时器表达式并保留服务端口令。2026-09-13 22:04 用户选择“提交并现在部署”。核对：TikHub 公开价格页仍为每次 0.01 美元；线上 collectTick 没有残留 `DFP_VALIDATION_AT`，线上环境变量与私有配置一致；余额交由用户在 TikHub 后台确认，未调用接口查询；云资源用量未核对。执行：提交 `2afbedb`；私有配置改为 150 / 1,500,000 / 100，并先用新代码 `loadConfig` 校验；从工作树 `tcb fn deploy collectTick --force` 部署成功（22:07:36 Active，Nodejs20.19、180 秒、512 MiB）；回读线上额度为 150 / 1,500,000 / 100、验收时刻为空；不带口令的伪造定时调用返回 `UNAUTHORIZED_TRIGGER`；定时器回读为 `0 0-30/2 6,9,12,20 * * * *`，口令一致。登录任务日后部署 collectTick 前必须先合并本分支；主目录私有配置已是新额度，旧代码读到会拒绝运行（不会超支）。
- [ ] T042 部署后观察第一次真实 06:00 扫描及当天 09:00 带上结果，在运行记录中记录请求数、费用、今日候选数、入选数和问题。2026-09-14 09:58 首轮观察已记入运行记录：06:00 用 68 次请求找到 13 条今日千赞候选，内容判断全部未通过，入选 0 篇、未发布；09:00 额度用完、入选 0 篇、未发布。“带上”逻辑未被实际触发，仍待有 06:00 结果的日子验证。

## Phase 9：2026-09-14 已确认的视频判断与检查机会优化

- [x] T043 为标题制作意图、空正文、菜名不足、图文边界、证据字段校验与模型失败补行为回归，先确认失败
- [x] T044 修改provider/judge并更新判断证据约定；预算、赠额模型和收费回退边界不变
- [x] T045 为本周/黑马/今日队列交错、重叠去重、有限预算、中断恢复补回归，先确认失败，再修改runner
- [x] T046 更新规则版本与材料，受影响测试83通过、包检查10通过，独立审查无阻塞；赠额抽核18次含1次服务失败，15样本的入选决定一致，1条分类标签偏保守；详见[策略运行记录](../../docs/operations/2026-09-14-collection-strategy.md)
- [x] T047 12:17从整合提交6a3d02f更新collectTick代码；回读Active、配置/触发器保留、预算仍102次，线上13文件一致，1次无口令触发被拒；见[策略运行记录](../../docs/operations/2026-09-14-collection-strategy.md)
- [ ] T048 后续两个正式轮次记录新增入选与未入选原因，不用手动收费补采替代；与既有T042的06:00沿用验收分别记录
