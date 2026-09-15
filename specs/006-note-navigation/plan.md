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

## 夜间交付增补

新增catalog的getContent只读动作：先authorize及既有published索引验证，再按服务端publicNote.firstRoundId定位同篇已完成候选，核对noteId/authorId/roundId，仅白名单输出正文和媒体。不新增集合或付费读取链路。provider保存详情中的配图与配图完整性；publicNote仅新增来源封面与内容可读标记，正文不随列表批量返回。旧数据直接使用已保存的同篇候选，缺配图如实提示。

## 作者主页接入（2026-09-15）

shared/author-navigation提供作者绑定、分享字段校验和固定小程序路由编码，生成副本供collector/catalog/mini使用。collector的author-profiles解析同作者get_user_info.share_link、按租约保存author_profile记录；cover前仅为已入选作品补充，一次10秒，可选失败继续保存作品。catalog只在getContent追加一次对应作者缓存读取，目录失败返回空入口。mini详情作者按钮检查已加载作者身份、重复点击和取消，不采集、不复制。

现有作者补齐使用单独已审查脚本：最多15次/0.15美元，原研究4次不重置，合计研究上限19，共同计入250次/2.50美元日账；逐次核对已发布作者、持有租约且无活动轮次，不重试未知请求，不改快照。上线顺序为定向测试、独立审查、确定提交、catalog/collector代码部署及回读、真实权限UI检查、上传新体验版。

新增原生detail页，卡片“查看内容”及封面/标题进入；正文用text展示，图片可预览，video使用已保存的来源地址。可靠外跳作为详情内附加入口。列表云封面缺失时按同篇已保存信息降级，不发起采集。媒体持久化与失败原因由采集阶段处理，读取不写。

并行修复005首次正文模型错误中止整轮的问题：保留错误证据，连续两次失败后本轮暂停新正文调用；合格视频可使用既有视觉预算继续复核，图文及无法复核内容保持未完成。所有判断都失败时保留旧快照，有可靠结果才发布partial。模型供应商仍为仅消耗赠額的hunyuan-v3，不切付费文本模型。
