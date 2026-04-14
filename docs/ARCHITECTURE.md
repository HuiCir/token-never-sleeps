# TNS 架构

Token Never Sleeps 由两层组成：

1. Claude 插件层
   - 提供 `tns-executor` / `tns-verifier` 两个 agent。
   - 提供 `/tns-start` 与 `/tns-status` 命令入口。
   - 通过 stop hook 记录会话结束事件，帮助诊断接力行为。

2. 外部 harness 层
   - `scripts/tns_runner.py` 负责真正的长程自动化。
   - 维护 `.tns/` 状态文件。
   - 按 5 小时窗口做 refresh。
   - 选择未完成 section。
   - 调用 executor。
   - 在 clean state 后调用 verifier。
   - 根据 quota provider 的结果决定继续还是冻结。
   - 可选用 git 做 checkpoint、分支记录与回退。

## 为什么必须有外部 runner

Claude 插件可以扩展命令、agent、hook 和 MCP，但它本身不会在 5 小时后自动“重启一个新 Claude 会话”。跨窗口接力必须由外部调度器重新调用 `claude -p`。这正是 TNS runner 存在的原因。

## 对齐 Anthropic 长程 harness 的设计点

参考 Anthropic《Effective harnesses for long-running agents》（2025-11-26）中的关键实践，TNS 采用：

- 首次运行建立可持续环境，而不是直接做大而全的实现。
- 用结构化 section 列表替代松散待办。
- 每轮只推进一个 section。
- 每轮结束都要求 clean state。
- 通过 handoff 文件与 git 历史让下一轮 fresh-context agent 快速接力。
- 把验证 agent 从执行 agent 分离，避免“自己写、自己乐观通过”。
- 通过 `artifacts.json` 建立 section 到交付物的反向索引。
- 通过 git checkpoint 让“资源枯竭后回退一个完整 loop”成为可执行操作。

## token / quota 监控

Claude Code 本地环境当前没有稳定、通用、可直接读取的“剩余 plan token”接口。TNS 因此提供两类 quota provider：

- `provider = rolling_usage`
  - 使用 runner 记录的当前 window 内真实 usage 累计值。
  - 用 `window_token_budget - used_tokens` 推导剩余额度。
- `provider = command`
  - 运行一个外部命令，返回 JSON。
- `freeze_on_unknown = true`
  - 如果拿不到可靠额度，直接冻结，不启动新 section。

这意味着：

- TNS 可以监控 quota，同时由 `enforce_freeze` 决定是否阻断。
- 如果你没有官方额度接口，也可以先用 `rolling_usage` 做窗口预算控制。
- 真正的平台账户剩余额度查询，仍需要你接入自己的 `command` provider。

推荐 provider 输出：

```json
{
  "ok": true,
  "remaining": 182000,
  "unit": "tokens",
  "observed_at": "2026-04-14T08:00:00Z",
  "reason": "minimax quota api"
}
```
