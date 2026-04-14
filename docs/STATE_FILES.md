# TNS 状态文件

TNS 在目标工作区创建 `.tns/`，核心文件如下：

- `manifest.json`
  - 全局元数据，包含首次启动时间、5h 窗口锚点、产品文档路径。
- `sections.json`
  - section 列表与状态。
- `handoff.md`
  - 每轮执行/验证后的接力笔记。
- `reviews.json`
  - 验证失败后留下的 review 队列。
- `activity.jsonl`
  - runner 的结构化事件流。
- `artifacts.json`
  - section 到产物文件的索引。
- `hook-events.jsonl`
  - 插件 stop hook 观察到的会话退出事件。
- `freeze.json`
  - 冻结原因与下次允许恢复的时间。

`sections.json` 的状态值：

- `pending`
- `in_progress`
- `needs_fix`
- `done`
- `blocked`

TNS 只会在验证通过后把 section 标成 `done`。

`artifacts.json` 记录：

- `section_id`
- `section_title`
- `path`
- `exists`
- `indexed_at`
- `verified`

如果启用了 git，状态目录之外还会在仓库历史里留下：

- loop 开始前 checkpoint
- loop 完成后的提交
- 可选的 loop 独立分支
