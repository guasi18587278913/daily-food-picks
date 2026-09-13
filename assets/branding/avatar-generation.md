# 小程序头像生成记录

- 用途：深夜食堂选题台的小程序头像。
- 工具：内置 image_gen，没有调用额外 CLI/API。
- 成品：[food-picks-avatar.png](food-picks-avatar.png)，1254 × 1254，1,357,314 字节，满足后台 2 MiB 上限。
- 已通过小程序后台普通头像上传流程上传，随基本资料一起提交；没有更改其他图片。
- 原始输出保留在生成工具目录；当前工作区副本为后续引用文件。

## 完整提示词

```text
Use case: logo-brand. Asset type: square PNG avatar for a WeChat mini program called 深夜食堂选题台, a personal cooking-content idea finder. Create one finished 1:1 icon, full-bleed warm ivory background. A friendly, distinctive illustrated ceramic noodle bowl with a pair of chopsticks and a single small curl of steam; warm vermilion red and deep charcoal accents, subtle hand-painted ceramic texture, simple bold silhouette readable at 144x144 pixels. Center the bowl with generous margin so nothing is cropped in circular avatars. Calm warm editorial food-workbench aesthetic. No text, no letters, no watermark, no gradient background, no UI mockup, no frame, no photorealism, no extra icons. Deliver a clean raster PNG suitable for upload, preferably below 2 MB.
```

