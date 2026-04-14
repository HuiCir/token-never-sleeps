# TNS Demo

这个 demo 是一个低风险验证场景：

- 10 个 section
- 每 5 分钟激活一次
- 每次激活前检查 rolling quota
- executor 写 Markdown 交付物
- verifier 检查文件、标题和验收标准

工作区就是本目录：

- `demo-product.md` 是产品文档
- `deliverables/` 是 agent 要产出的内容
- `progress-log.md` 是可观察进度
