# Tasks: 选题台界面视觉改版（方向 A · 浅色清爽卡片）

**Input**: Design documents from `specs/004-ui-visual-refresh/`

**Prerequisites**: [plan.md](plan.md)、[spec.md](spec.md)、[research.md](research.md)、[contracts/ui-states.md](contracts/ui-states.md)、[quickstart.md](quickstart.md)

**Tests**: 规格未要求新增自动化测试。现有 `tests/frontend.test.js` 的 11 项作为回归门槛；视觉按 UI 状态契约在模拟器截图核对。若实施中在 `miniprogram/lib/view.js` 增加展示判断，再补测试任务。

**Organization**: 按用户故事分组。四个故事都改 `index.wxml`、`index.wxss`，按优先级顺序实施，不并行改同一文件。

**效果图确认**: 2026-09-13 17:24（北京时间），用户查看 `.local/004-ui-mockup/index.html` 后回复“没问题”（FR-014）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无未完成依赖）
- **[Story]**: 所属用户故事（US1–US4）

## Phase 1: Setup

- [x] T001 在工作树根目录安装依赖（`npm ci`；不可用时临时链接主工作区 `node_modules` 并在交付前移除），再运行 `npm run prepare:functions` 生成被忽略的部署副本，供 `scripts/check-package.js` 使用
- [x] T002 记录改版前基线：`node --test tests/frontend.test.js` 与 `npm run typecheck:mini` 的退出码和通过数，写入本文件“验证记录”

## Phase 2: Foundational

- [x] T003 在 `miniprogram/app.wxss` 定义 research R1 颜色令牌、R2 默认字号、按钮复位与页面底色
- [x] T004 在 `miniprogram/app.wxss` 追加 research R5 的线性图标类（内联 SVG：搜索、清空、往期、展开、收藏空心／实心、复制、提示、锁、刷新、箭头、空状态、封面占位）
- [x] T005 [P] 在 `miniprogram/app.json` 把标题栏与下拉刷新区背景改为 `#F6F4F0`

**Checkpoint**: 令牌与图标可被页面引用。

## Phase 3: User Story 1 - 打开就看清值得做的选题 (Priority: P1) 🎯 MVP

**Goal**: 左图右文卡片，封面放大，字号达标，收藏和复制像按钮。

**Independent Test**: 模拟器中查看含长标题、缺封面、未知指标的卡片；点击收藏与复制（contracts S10、S18）。

- [x] T006 [US1] 在 `miniprogram/pages/index/index.wxml` 重写 `noteCard` 模板：3:4 封面与占位、类型标签、两行标题、作者与日期、主数字与单位、对比说明、收藏胶囊与复制按钮；事件名与 `data-id` 不变
- [x] T007 [US1] 在 `miniprogram/pages/index/index.wxss` 实现卡片样式（research R3、R6：封面 216×288rpx，按钮外框 88rpx）
- [x] T008 [P] [US1] 在 `miniprogram/pages/index/index.js` 把复制成功弹窗确认色改为 `#B8441A`
- [x] T009 [US1] 模拟器核对卡片：长标题两行省略、缺封面占位、未知指标显示“—”、收藏状态切换、复制弹窗（复制弹窗未在模拟器触发，见验证记录）

**Checkpoint**: 卡片可独立核对。

## Phase 4: User Story 2 - 三个板块清楚，空板块不占地方 (Priority: P1)

**Goal**: 有内容的板块完整展示；空板块一行；三个板块全空时只显示统一空状态。

**Independent Test**: 分别设置“三个都有／部分为 0／全部为 0”，并切换排序（contracts S10–S12）。

- [x] T010 [US2] 在 `miniprogram/pages/index/index.wxml` 重写板块区：色标、名称、条数、规则、排序胶囊；`board.count` 为 0 时渲染一行“本轮暂无”（搜索时为“没有匹配”）；`total` 为 0 时不渲染板块
- [x] T011 [US2] 在 `miniprogram/pages/index/index.wxss` 实现板块、排序胶囊（视觉 60rpx、外框 88rpx）、空板块行与全空状态样式
- [x] T012 [US2] 模拟器核对 S10–S12，以及切换排序后的主数字、单位和顺序

**Checkpoint**: 板块结构可独立核对。

## Phase 5: User Story 3 - 顶部精简：状态、搜索、往期和收藏 (Priority: P2)

**Goal**: 顶部只保留状态行、视图切换、往期和搜索；品牌名只在标题栏出现一次。

**Independent Test**: 搜索、无结果、清空；切换往期并出现新一轮提示；进入收藏并取消收藏（contracts S08、S13–S16）。

- [x] T013 [US3] 在 `miniprogram/pages/index/index.wxml` 重写顶部：状态行、分段切换与往期选择、搜索与清空、新一轮提示条、轮次标题与说明块；删除品牌区、印章、“试用”章、板块编号和签名
- [x] T014 [US3] 在 `miniprogram/pages/index/index.js` 的 `checkUpdates` 中按状态设置仅用于展示的 `statusTone`（已更新、部分更新、调用上限、更新未完成），并在 `data` 中初始化
- [x] T015 [US3] 在 `miniprogram/pages/index/index.wxss` 实现顶部样式（状态点、分段外框 88rpx、搜索框、提示条、轮次标题、说明块）
- [x] T016 [US3] 模拟器核对搜索、无结果、清空、往期与新一轮提示、收藏视图

**Checkpoint**: 顶部与视图切换可独立核对。

## Phase 6: User Story 4 - 所有状态统一新风格 (Priority: P3)

**Goal**: 其余状态没有旧样式残留。

**Independent Test**: 按 contracts S01–S18 逐项截图。

- [x] T017 [US4] 在 `miniprogram/pages/index/index.wxml` 与 `miniprogram/pages/index/index.wxss` 改写未开通、加载中、错误提示、收藏为空与失效、继续查看、更早轮次和页脚
- [x] T018 [US4] 用 `miniprogram-automator` 在模拟器按 S01–S18 设置页面数据并截图，保存到 `.local/004-ui-shots/`（不提交），逐项记录结果

## Phase 7: Polish & Cross-Cutting

- [x] T019 运行 `node --test tests/frontend.test.js`、`npm run typecheck:mini`、`npm run check:package`，记录退出码与通过／失败数
- [x] T020 在模拟器测量可点击元素高度（不小于 44px），并扫描 `miniprogram/app.wxss`、`miniprogram/pages/index/index.wxss` 中小于 24rpx 的字号（SC-003）
- [x] T021 差异自审（逻辑、安全、一致、干净），确认未改动 `cloudfunctions/`、数据与权限；更新本文件验证记录、剩余项和 `plan.md` 状态
- [ ] T022 【需用户单独确认后执行】上传新体验版；上线后与 001 SC-003 合并，由大芙完成六项真机验收并写入运行记录

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 → US2 → US3 → US4 → Polish。
- US1–US4 都修改 `index.wxml`、`index.wxss`，按顺序实施；每个故事完成后可单独核对。
- T005、T008 修改独立文件，可与同阶段其他任务并行。
- T022 依赖 T019–T021 全部完成，并需要用户确认。

## Parallel Example

```text
T005 更新 miniprogram/app.json 配色
T008 更新 miniprogram/pages/index/index.js 弹窗确认色
```

## Implementation Strategy

1. 完成 Setup 与 Foundational。
2. 完成 US1、US2 两个 P1 故事，在模拟器核对首页主路径。
3. 完成 US3、US4，按状态契约截图。
4. 运行验证并自审；上传体验版等待用户确认。

## 验证记录

**源码状态**：分支 `004-ui-visual-refresh`，基于 `1820f3f`；以下验证针对提交前的工作区差异 5 个文件（`miniprogram/app.json`、`app.wxss`、`pages/index/index.js`、`index.wxml`、`index.wxss`），+159／−51。该差异与本目录文档在 2026-09-14 按用户要求一起提交，提交后未再改代码。

**环境**：本机 macOS；Node v22.22.2、npm 10.9.7；工作树依赖由 `npm ci` 安装（177 个包）。模拟器为微信开发者工具 v2.02.2608070，机型 iPhone 12/13 (Pro)，窗口 390×753，基础库 3.17.2。

| 阶段 | 命令或方式 | 结果 |
| --- | --- | --- |
| 改版前基线 | `node --test tests/frontend.test.js` | 11 通过、0 失败、0 跳过 |
| 改版前基线 | `npm run typecheck:mini` | 退出码 0 |
| 改版后 | `node --test tests/frontend.test.js` | 退出码 0；11 通过、0 失败、0 跳过 |
| 改版后 | `npm run typecheck:mini` | 退出码 0 |
| 改版后 | `npm run prepare:functions` | 生成 4 份部署副本（均被 Git 忽略） |
| 模拟器第 1 次 | `.local/004-ui-shots/sim-check.js` | 脚本 0 项失败；截图目视发现缺陷：微信 `style: v2` 按钮默认宽 184px、左右外边距自动，导致排序胶囊竖排、“往期”被挤出、搜索框文字被压没、新一轮提示条变窄 |
| 修复 | `miniprogram/app.wxss` 增加 `button:not([size=mini])` 复位（research R10） | 只改样式，JS 未变，因此未重复运行行为测试与类型检查 |
| 模拟器第 2 次 | 同一脚本 | 0 项失败。真实最新轮次 9月13日 12:00（低粉黑马 2 篇，封面正常）；搜索“椰”得 1 篇，清空后恢复；排序切到“赞粉比”显示 5.7倍；收藏开关与收藏页正常，测试收藏已还原。S01–S17 顶部与底部截图与效果图一致；长标题两行省略、长作者省略、未知指标显示“—”；13 类可点击元素最小高度 45px |
| 修复后 | `npm run check:package` | 退出码 0；6 项通过、0 失败；客户端 12 个文件、42,839 字节 |
| 修复后 | 扫描两份 WXSS 的字号 | 38 处声明，0 处小于 24rpx |
| 自审 | `git diff`、`git status` | 只改 5 个前端文件；`cloudfunctions/`、`config/`、`scripts/`、`tests/` 无差异；事件名、数据绑定和 `data-*` 参数保持不变；`statusTone` 只影响状态点颜色 |

**限制**：
- 复制成功弹窗未在模拟器触发；复制行为由 `copy only reports success...` 单元测试覆盖，弹窗颜色只核对了代码差异。
- 未在 375×667 机型实际截图；按 390×753 实测位置推算，最坏情况（有说明块和两个空板块）下首张卡片封面与标题仍在首屏内。320、430 宽度未单独截图。
- 模拟器结果不能替代大芙真机验收。

## 剩余项

- T022 已获用户上传授权，9/14开发版本0.1.2上传成功；设置体验版需要微信后台浏览器连接，大芙真机验收仍未完成。
- 2026-09-14 已在独立本地整合分支解决与 003 的首页冲突，完成受影响前端测试、类型检查与模拟器核对，并补到复制成功弹窗。仍未合并 main／上传体验版；小屏、大屏与安卓图标仍待核对。具体证据见[统一收尾记录](../../docs/operations/2026-09-14-closeout.md)。
