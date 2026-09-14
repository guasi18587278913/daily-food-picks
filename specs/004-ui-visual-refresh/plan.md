# Implementation Plan: 选题台界面视觉改版（方向 A · 浅色清爽卡片）

**Branch**: `004-ui-visual-refresh` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-ui-visual-refresh/spec.md`

**Status**: 效果图已于 2026-09-13 17:24 确认；前端代码已实施，自动检查与模拟器核对通过（见 [tasks.md](tasks.md) 验证记录）。代码与文档已提交到 `004-ui-visual-refresh`；上传体验版和真机验收待用户确认。

**效果图**: 本机 `.local/004-ui-mockup/index.html`（含改版前还原、最新一轮、往期、收藏、未开通、全空 6 屏；使用 9 月 12 日真实轮次，不提交 Git）。配色对比度脚本同目录 `contrast.js`，2026-09-13 结果 14 项通过、0 项失败。

## Summary

把首页从“米黄纸本 + 小字 + 装饰”改为方向 A：暖白底、白色圆角卡片、左图右文、单一橙色强调。只改展示层，包括页面结构、样式、图标和少量展示判断。数据读取、轮询、收藏、复制和权限逻辑保持不变，由现有前端行为测试守住。

## Technical Context

**Language/Version**: 原生微信小程序（WXML、WXSS、CommonJS JavaScript）；本地检查使用 Node 20.19+。

**Primary Dependencies**: 不新增依赖。沿用开发依赖 `miniprogram-api-typings`（类型检查）和 `miniprogram-automator`（模拟器截图）。

**Storage**: N/A。本机收藏沿用现有存储键和结构。

**Testing**: `node --test tests/frontend.test.js`（现有 11 项页面行为）与 `npm run typecheck:mini`。若在 `miniprogram/lib/view.js` 新增展示判断，先补行为测试。视觉按效果图和状态截图核对；真机由大芙在体验版验收。

**Target Platform**: 微信 iOS／Android 客户端，常见宽度 320–430pt；电脑版微信只要求不变形。

**Project Type**: 单页面微信小程序 + 云函数；本功能只改小程序。

**Performance Goals**: 首屏不新增网络请求；封面继续懒加载；页面数据量不因改版增加。

**Constraints**: FR-003 字号与对比度下限、FR-004 44pt 点击区域；不用远程字体和装饰图片；WXSS 背景不能引用本地图片文件，图标使用内联 SVG 数据；轻提示样式由系统决定，只能调整确认弹窗按钮颜色。

**Scale/Scope**: 1 个页面、18 种状态（见 [UI 状态契约](contracts/ui-states.md)）；每轮通常 0–10 条选题。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 本功能的做法 | 结论 |
| --- | --- | --- |
| I. 同一份事实 | 004 目录维护需求、方案和任务；001 的行为验收只引用，不复制改写 | 通过 |
| II. 职责与依赖 | 页面结构留在 `pages/index`，展示转换留在 `lib/view.js`，全局样式令牌与图标放 `app.wxss`；不新增依赖，不形成循环 | 通过 |
| III. 证据先于结论 | 保留 11 项前端行为测试；新增展示判断先写测试；模拟器、真机结果分开报告 | 通过 |
| IV. 身份、数据和消费 | 不改云函数、权限和预算；打开、刷新、搜索、收藏的调用保持不变（SC-006） | 通过 |
| V. 双工具与风险 | 在独立工作树开发，不写主工作区功能指针；预计不超过 10 个文件、单模块，按标准任务执行；上传体验版另行确认 | 通过 |

## Project Structure

### Documentation (this feature)

```text
specs/004-ui-visual-refresh/
├── spec.md
├── plan.md
├── research.md
├── quickstart.md
├── contracts/
│   └── ui-states.md
├── checklists/
│   └── requirements.md
└── tasks.md            # 由 /speckit-tasks 生成，尚未创建
```

本功能不改变数据和实体，因此不生成 `data-model.md`。

### Source Code (repository root)

```text
miniprogram/
├── app.json                # 标题栏与下拉刷新区配色
├── app.wxss                # 设计令牌、按钮复位、线性图标类
├── pages/index/
│   ├── index.wxml          # 版面重排；事件名、数据绑定、data-* 参数不变
│   ├── index.wxss          # 方向 A 页面样式
│   └── index.js            # 仅调整复制弹窗按钮颜色；不改数据流程
└── lib/view.js             # 仅在 WXML 难以清楚表达时增加纯展示字段
tests/frontend.test.js      # 保留现有用例；为新增展示字段补测试
```

**Structure Decision**: 沿用现有单页面和 `lib/view.js` 展示转换边界，预计改动 6–8 个文件。不新增页面、组件目录或依赖。若实施中超过 10 个文件，或需要改变页面与云端约定，暂停并按高风险重新确认。

## Implementation Approach

1. **样式令牌**：在 `app.wxss` 定义颜色、字号、圆角、阴影和按钮复位；图标用类名承载内联 SVG 背景，不新增图片文件。取值见 [research.md](research.md)。
2. **页面骨架**：`index.wxml` 依次为状态行、顶部切换（选题台／我的收藏 + 往期）、搜索、新一轮提示条、轮次标题与说明、三个板块、全空状态、继续查看、页脚。
3. **选题卡片**：左侧 3:4 封面 216×288rpx；右侧标题两行、作者与日期、主数字 52rpx 与单位、对比说明；底部收藏和复制原文按钮的点击高度为 88rpx。
4. **空板块**：WXML 按 `board.count === 0` 渲染一行“本轮暂无”；三个板块全空沿用现有空状态分支，改为新样式。
5. **其余状态**：按 [UI 状态契约](contracts/ui-states.md) 逐项替换样式，文案含义不变。
6. **配色收尾**：`app.json` 标题栏与背景改为暖白；复制成功弹窗确认色改为深橙。

## Verification Strategy

- 开发中：`node --test tests/frontend.test.js`、`npm run typecheck:mini`。工作树需要可用依赖，见 [quickstart.md](quickstart.md)。
- 视觉：在模拟器按状态设置页面数据截图，与确认后的效果图对照；再用真实最新轮次截一次。
- 包检查：`npm run check:package`。
- 真机：上传体验版前单独确认；上线后与 001 SC-003 合并，由大芙完成六项验收。
- 审查：标准任务做差异自审；若升级为高风险，安排独立审查并复审。

## Risks & Coordination

- **与 003 并行**：003（微信登录与角色）可能修改 `index.wxml`、`index.js`。实施前查看 003 的方案或改动范围；后合并的一方解决冲突，并让双方行为测试通过。
- **模拟器调用**：打开页面会以开发者工具登录账号调用只读接口，不触发收费采集。若该账号不在名单中，只截未开通状态，不反复打开，避免覆盖首次身份记录。
- **安卓渲染差异**：中文行高和 SVG 背景在安卓可能略有差异；卡片右侧用弹性布局，主数字贴底，并在真机验收时检查图标。
- **封面比例**：横图和方图统一裁切填充；内容类型标签放左下角，不遮挡主体。

## Post-Design Constitution Re-check

设计产物没有引入新依赖、新接口或权限变化；验证层级清楚，风险等级仍为标准。通过。

## Complexity Tracking

无违例。
