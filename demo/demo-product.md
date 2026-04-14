# Token Never Sleeps Demo

这个 demo 用来验证 TNS 的 section 追踪、5 分钟 refresh、quota 追踪和 executor/verifier 双 loop。

## Task 01: 创建概览交付文件
在 `deliverables/01-overview.md` 创建一个 Markdown 文件。
验收标准：
- 标题必须是 `# Demo 01 Overview`
- 必须有 3 个 bullet，分别说明 demo 目标、runner 角色、verifier 角色
- 在 `progress-log.md` 追加一行 `DONE: Task 01`

## Task 02: 创建刷新窗口说明
在 `deliverables/02-refresh-window.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 02 Refresh Window`
- 说明 5 分钟 refresh 的意义
- 至少写出 2 条“为什么需要 clean state”
- 在 `progress-log.md` 追加一行 `DONE: Task 02`

## Task 03: 创建 quota 说明
在 `deliverables/03-quota.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 03 Quota`
- 明确写出 `rolling_usage` 的含义
- 写出 `window_token_budget` 和 `minimum_remaining` 的作用
- 在 `progress-log.md` 追加一行 `DONE: Task 03`

## Task 04: 创建 handoff 说明
在 `deliverables/04-handoff.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 04 Handoff`
- 用编号列表写出 3 步 handoff 流程
- 包含词组 `fresh-context agent`
- 在 `progress-log.md` 追加一行 `DONE: Task 04`

## Task 05: 创建验证标准
在 `deliverables/05-verification.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 05 Verification`
- 明确区分 `pass`、`fail`、`blocked`
- 至少列出 3 条 verifier 应检查的内容
- 在 `progress-log.md` 追加一行 `DONE: Task 05`

## Task 06: 创建冻结说明
在 `deliverables/06-freeze.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 06 Freeze`
- 解释什么时候要冻结 loop
- 包含 `quota_unknown` 和 `quota_low`
- 在 `progress-log.md` 追加一行 `DONE: Task 06`

## Task 07: 创建活动日志说明
在 `deliverables/07-activity-log.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 07 Activity Log`
- 说明 `activity.jsonl` 的作用
- 至少写出 4 个事件名
- 在 `progress-log.md` 追加一行 `DONE: Task 07`

## Task 08: 创建 demo 运行指南
在 `deliverables/08-run-guide.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 08 Run Guide`
- 包含 `init`、`run`、`status` 三个命令
- 明确说明是 5 分钟 cadence
- 在 `progress-log.md` 追加一行 `DONE: Task 08`

## Task 09: 创建结果总结
在 `deliverables/09-summary.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 09 Summary`
- 概括 demo 证明了什么
- 至少写 1 条限制和 1 条后续改进
- 在 `progress-log.md` 追加一行 `DONE: Task 09`

## Task 10: 创建最终检查清单
在 `deliverables/10-final-checklist.md` 创建文档。
验收标准：
- 标题必须是 `# Demo 10 Final Checklist`
- 包含 5 个 markdown checkbox
- 至少一个 checkbox 提到 verifier
- 在 `progress-log.md` 追加一行 `DONE: Task 10`
