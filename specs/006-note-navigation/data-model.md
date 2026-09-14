# Data model

目录：dfp_state/source_navigation_v1，{version:1, revision:非负整数, entries:{[noteId]:{noteId,shortLink,confirmedAt,expiresAt?}}}。最大100条/120KB。

API note增加sourceNavigation（{noteId,shortLink}或null）、sourceNavigationState（ready/missing/unavailable）。入口只匹配本次笔记编号，无其他笔记链接泄漏。

不透明短链目标无法由本地解析证明，trusted运维导入必须明确确认笔记对应关系。配置的有效性检查不等于小红书永久可访问；客户端成功回调不宣称正文已显示。
