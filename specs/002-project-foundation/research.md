# Research: 目录与双工具接续

## 唯一主目录

选择当前“美食博主工作台”。用户已经在此工作，规格与规范都在此。迁入既有 Git 元数据可以保留全部历史，不重新初始化仓库。

保留旧英文路径为兼容链接。复制两份代码会继续分叉；仅移动规格到旧目录则需要用户换项目入口。

## Spec Kit 功能选择

本机版本为 1.0.6，common.sh 明确先使用显式功能目录，再读 .specify/feature.json。分支与功能目录独立，不能按旧教程强制改分支名。

feature.json 已由上游忽略规则标记为每个工作区的本地状态。并行任务用显式路径或独立工作树，不共享改写这个指针。

## 工具适配

现有 .agents/skills 和 .claude/skills 都有十个 Spec Kit 入口。差异主要是调用符号和宿主元信息，保留上游适配。

项目自定义 SDD Skill 只维护一份，Claude 侧链接到共同目录。CLAUDE.md 使用官方支持的 @AGENTS.md 导入方式。

依据：[Claude 项目记忆](https://code.claude.com/docs/en/memory)、[Claude Skills](https://code.claude.com/docs/en/skills)、[Codex Skills](https://developers.openai.com/codex/build-skills)。

## 原始资料与旧网页

早期研究、试跑与原始响应放在同一归档组，尽量保持内部相对关系。原始响应及付费试跑默认只保留本机。

旧网页仍使用根目录 index.html、build.py、src、data 和 test。为保护已有预览和发布结构，本次只在导航中标明用途，不改变这些业务文件位置。

## 验证选择

业务代码是位置迁移，内容不变。验证根目录、文件摘要、入口、生成副本、包与类型检查即可覆盖本次影响；不重复收费服务或全量业务测试。
