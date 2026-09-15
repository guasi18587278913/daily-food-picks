# Tasks: 四个榜单

- [ ] T001 ranking：saves 规则、移除 dark；更新 collector/candidate-opportunities/daily-sweep 测试
- [ ] T002 authors.js：观测记录、涨粉判定、回查选择、账号条目；tests/authors.test.js
- [ ] T003 runner/discovery/author-profiles：观测接入、粉丝阶段、回查、收尾组装；tests/rising-board.test.js
- [ ] T004 publisher/catalog：accounts、boards 计数、去重引用；tests/publishing、catalog
- [ ] T005 小程序：四个榜单、账号卡片、排序、类型；tests/frontend；typecheck
- [ ] T006 配置与文案、规格文档、运行记录
- [ ] T007 全量测试、包检查、独立审查、部署 collectTick 与 catalog、上传体验版、回读

## 实际完成情况（2026-09-15）

- [x] T001 ranking：saves 规则、移除 dark 与粉丝上限
- [x] T002 authors.js：观测记录、涨粉判定、回查选择与尝试标记、账号条目
- [x] T003 runner/discovery/author-profiles：观测接入、回查、收尾组装
- [x] T004 publisher/catalog：accounts、boards 计数、七天去重引用
- [x] T005 小程序：四个榜单、账号卡片、排序、类型
- [x] T006 配置与文案、规格文档、运行记录
- [x] T007 全量测试 393 通过、类型检查、包检查、调度检查、独立审查无阻塞、部署两个云函数并回读一致、上传 0.1.5
- [ ] T008 微信后台把 0.1.5 选为体验版，并在真机确认四个榜单显示
- [ ] T009 观察 20:00 与次日 06:00／09:00 轮：回查次数、粉丝历史增长、黑马榜单首次出现账号的时间与内容

证据见 [四个榜单上线记录](../../docs/operations/2026-09-15-four-boards.md)。
- [x] T010 2026-09-15 傍晚按用户结论修订：热榜不改；黑马改为涨粉率 ≥10% 且 ≥500；收藏榜换互动榜（评论+转发 ≥ 点赞 15%）；判定改三档并把未确认作品带标签上榜。证据见 `docs/operations/2026-09-15-four-boards.md` 的追加记录。
