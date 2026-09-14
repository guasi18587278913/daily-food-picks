# 005 研究与决定

## 已有证据

[首次发现路径实测](../../docs/operations/2026-09-14-discovery-paths.md)和[公开收藏与热点实测](../../docs/operations/2026-09-14-discovery-followup.md)验证六种入口均可取数。热点及附带作品产生候选，其他入口尚无稳定提升证据。三篇周万赞视频中，文字自动通过一篇；另两篇由助手抽帧确认制作。

## 模型事实（2026-09-14）

- [CloudBase 多模态说明](https://docs.cloudbase.net/ai/model/multimodal)明确 hy3 是纯文本模型，传图可能被忽略或报错。
- [TokenHub 模型列表](https://cloud.tencent.com/document/product/1823/130051)有 youtu-vita、hy-vision-2.0-instruct 等视觉通道；Qwen3.5 Flash/Plus 已标记 2026-09-08 下线，不能照旧例使用。
- [价格页](https://cloud.tencent.com/document/product/1823/130055)：YT-VITA 输入 1.2 元/百万 tokens、输出 3.5 元/百万 tokens，拟优先实测。
- [图片理解说明](https://cloud.tencent.com/document/product/1823/136956)支持 image_url 的 URL/Base64 形式；特定模型的多图、输出和计费仍需实际确认。
- 用户已明确允许视觉每日0.50元、每轮3次，首验6次/0.20元；仍须先核对账号、价格和有界输入。

## 成本取舍

优先复用详情附带作品和成功判断，使用有时效的详情/作者缓存；限制发现请求，把额度留给细查。固定词表成为轮换库，热点提供新方向。只给可能入选且文字不足的视频做视觉复核。减少词表遍历改变覆盖，必须如实报告，并以同批候选回放单独证明缓存节省。

## 未完成依赖

研究初期待办为服务凭据、真实视觉评估、Linux FFmpeg包和正式轮次。当前进展见文末与tasks，不能将已完成本地验证称为上线可用。

## 直接VITA取代即将下线的TokenHub路径

[下线公告](https://cloud.tencent.cn/announce/detail/2447)说明TokenHub的youtu-vita将在2026-10-15下线，图像识别服务继续提供VITA。[直接接口](https://cloud.tencent.com/document/api/865/131910)模型为vita-video-3.0，[价格仍为1.2/3.5元每百万tokens](https://cloud.tencent.com/document/product/865/17627)。该接口明确max_tokens为合计、max_completion_tokens为输出，不能沿用TokenHub语义。直接入口没有赠额，Base64未在文档保证，需首验或采用短期签名URL。

## 2026-09-14实施核验

已开通直接VITA并验证Base64可用；6次首验记账0.010813元。Linux固定二进制在Node20.19.5、512MiB/1CPU容器通过三段媒体抽帧。V2视觉仍漏收一锅出，SC-002未通过；V3独立六帧传输仅离线就绪。详见 `docs/operations/005-vision-validation.md`，后续真实调用需要新增次数授权，正式轮次未执行新代码。
