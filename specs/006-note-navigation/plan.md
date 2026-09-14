# Implementation Plan: 查看原笔记

Spec: [spec.md](spec.md)；状态见tasks.md。原生微信小程序、Node20.19/CloudBase，沿用现有SDK与部署工作树。

## Constitution Check

数据与身份隔离不变，读取不触发收费。官方短链已单篇真机验证，但其笔记身份仍未确认；按用户要求由助手继续核实，不以用户逐篇提供链接作为自动化方案。批量来源仍未知。先完成可独立的字段/按钮接线，真实绑定与发布以证据为准，高风险跨模块变更独立审查。

## Architecture

- shared/source-navigation.js：纯校验与链接目录合并，作为前后端共享源；prepare:functions复制到miniprogram/catalog，生成副本不手改。
- dfp_state/source_navigation_v1：单个受大小限制的目录，最多100条，每次读取最多一条文档；值包含noteId、shortLink、confirmedAt、可选expiresAt。只有受信运维工具写入，无客户端修改接口。
- catalog/lib/queries.js：完成原授权与选题查询后，单次读目录，仅装饰返回笔记；缺失/异常以状态表达并保留选题展示，不重写快照。
- miniprogram/lib/source.js与首页：原样传shortLink调用wx.navigateToMiniProgram。取消静默、其他错误仅提示不可直达；按用户新指令删除来源复制入口及实现。卡片展示按已校验的入口选择按钮文字。
- scripts/register-note-links.js：私有JSON输入，校验对应笔记确实已发布、来源确认及目录版本，事务合并；拒绝未确认/重复短码对应不同笔记。只有带明确apply才写，不输出短链或凭据。

单文档最多100条/120KB是初期边界；当前可自动获取的短链接数未知，不建隐含收费的转换服务。目录和写入工具只能解决分发与可靠绑定，不能冒充自动来源。自动来源调查为独立待办。

## Delivery

数据校验/目录并发测试→目录读取与旧接口回归→按钮行为和类型检查→包检查→独立审查→确认真实对应关系→授权范围内更新候选catalog和体验版→正式卡片手机验收。此前独立测试页的成功不能替代最后一步。collectTick不需要更改，不与采集运行抢写。

仅getRound/getNotes/search返回非空笔记时增加一次目录读取；status、listRounds、空结果和拒绝请求不增加读取。每次运维导入最多20条，目录总上限100条，超限不截断也不删除旧数据。

## Open evidence

现有TikHub公开OpenAPI无明确微信笔记shortLink生成端点；已保存图文有mini_program_info.path，视频只有QQ路径，前次构造路径真机失败。原样shortLink可用。尚未证明平台路径能批量生成官方短链，也未确定成功样本是否属于已推荐数据。
