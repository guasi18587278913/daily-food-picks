# 数据约定

新增后台资料放入现有 `dfp_results` 的独立前缀；客户端目录仍只读已发布作品。

| recordType | 键前缀 | 主要内容 |
| --- | --- | --- |
| reusable_result | reuse_ | 请求及参数摘要、结果、采样时间、到期时间、版本 |
| content_judgment | judgment_ | 内容/视频摘要、模型、版本、判定与证据、有效期 |
| discovery_source | source_ | 类型、真实参数、父线索、到期与冷却、最近检查 |
| discovery_statistics | source_stats_ | 请求、独立候选、实际检查、通过与失败计数 |
| vision_attempt | vision_ | 轮次/日期、内容摘要、人民币预留、状态、实际用量与证据 |

轮次 progress 增加发现任务及进度、来源统计和视觉次数，保留旧模式已有字段。恢复不改变已持久化顺序。

dfp_budgets 增加独立币种的视觉日账和首验账，不改数据请求旧账或关闭的研究账。事务校验租约，未知结果保持占额。

候选 origins 最多 8 项，分别保存文字和视觉结果。视频定位信息、原始画面和密钥不进入发布白名单。
