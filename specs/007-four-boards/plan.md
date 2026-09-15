# Implementation Plan: 四个榜单

## Constitution Check

- 同一份事实：规则来自用户 2026-09-15 原话；本 plan 与 spec 同目录。
- 职责边界：榜单判定在 `ranking.js`；粉丝历史与涨粉判定在新模块 `authors.js`；运行器只编排；发布在 `publisher.js`；查询只读；页面只渲染。无新增循环依赖（authors 依赖 budget/config，不依赖 runner）。
- 证据：每条规则先有失败测试；受影响测试、类型检查、包检查后再部署；独立审查后部署。
- 有界消费：回查每轮 ≤8 次，走既有预留与账本；无新付费服务。

## 改动清单

| 模块 | 改动 |
| --- | --- |
| `lib/ranking.js` | `eligibleBoards` 返回 today/week/saves；移除 dark 与 allowUnknownFans |
| `lib/authors.js`（新） | 粉丝观测记录（上限、清理）、涨粉判定、回查名单选择、账号条目组装 |
| `lib/runner.js` | 粉丝阶段对所有有榜单的笔记补查一次粉丝并记录观测；藏赞比；候选轮转队列改为 week/saves/today；常规轮候选完成后回查；收尾组装账号条目；文案改名 |
| `lib/discovery.js` | 移除黑马粉丝缓存排除；公开收藏检查的粉丝写入观测 |
| `lib/author-profiles.js` | 作者资料请求的粉丝写入观测 |
| `lib/publisher.js` | `accounts`、boards 计数、账号 7 天去重引用 |
| `catalog/lib/queries.js` | getRound 返回 `accounts` |
| `miniprogram/lib/view.js`、`pages/index/*`、`types.d.ts` | 四个榜单、账号卡片、排序键 |
| `config/rules.json`、`config/keywords.json` | 规则说明与版本、文案 |

## 数据

- `dfp_results` 新记录类型 `fans_history`：`{ recordType, authorId, author, points:[{at,fans}], recentNotes:[{noteId,title,likes,collected,publishedAt}], lastObservedAt }`，id `fans_<authorId>`。
- `dfp_results` 引用 `rising_published_<authorId>`：`{ snapshotId, at }`。
- 快照 `accounts:[{ authorId, author, fans, fansBefore, fansDelta, observedAt, baselineAt, spanHours, notes }]`。

## 验证

`node --test tests/ranking-boards.test.js tests/authors.test.js tests/rising-board.test.js tests/candidate-opportunities.test.js tests/daily-sweep.test.js tests/publishing.test.js tests/catalog.test.js tests/frontend.test.js`；`npm run typecheck:mini`；`npm test`；`npm run check:package`；独立审查；部署 collectTick、catalog；上传体验版。
