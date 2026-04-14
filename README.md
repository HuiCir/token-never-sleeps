# Token Never Sleeps

Token Never Sleeps is a Claude plugin plus runner for long-running work:

- tracked product-document sections
- clean-state handoffs across refresh windows
- executor / verifier loop
- rolling quota tracking
- optional git checkpoint / rollback
- optional email notifications

## Repo Layout

```text
token-never-sleeps/
├── .claude-plugin/
├── agents/
├── demo/
├── demo-mail/
├── docs/
├── examples/
├── hooks/
├── scripts/
└── skills/
```

## Privacy / Sanitization

This repository is sanitized for publication:

- no real API keys
- no real SMTP credentials
- no runtime `.tns/` state
- no generated deliverables
- no local task logs from previous runs
- no real recipient addresses

Examples use placeholder paths and placeholder notification addresses.

## One-Click Claude Access

### Option A: Local install

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
```

Then run:

```bash
claude --plugin-dir ~/.claude/plugins/local/token-never-sleeps
```

### Verify The Install

Minimal verification:

```bash
claude plugin validate ~/.claude/plugins/local/token-never-sleeps
```

Agent-level verification in a temporary workspace:

```bash
mkdir -p /tmp/tns_verify/.tns
printf '%s\n' '[{"id":"sec-001","title":"Verify","anchor":"## Verify","status":"pending","attempts":0,"verified_at":null,"last_summary":"","last_review":"","body":"Create a tiny verification note."}]' > /tmp/tns_verify/.tns/sections.json
printf '# TNS Handoff\n' > /tmp/tns_verify/.tns/handoff.md
printf '# Product\n\n## Verify\nCreate a tiny verification note.\n' > /tmp/tns_verify/product.md

claude -p \
  --plugin-dir ~/.claude/plugins/local/token-never-sleeps \
  --agent tns-executor \
  --permission-mode acceptEdits \
  --effort low \
  "Read the local .tns state and summarize what remains to do."
```

### Option B: Marketplace-style install

```bash
claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
claude plugin install token-never-sleeps@token-never-sleeps
```

## Quick Start

Copy the example config and replace placeholder paths:

```bash
cp examples/tns.config.json /path/to/project/tns.config.json
python3 scripts/tns_runner.py init --config /path/to/project/tns.config.json
python3 scripts/tns_runner.py run --config /path/to/project/tns.config.json
python3 scripts/tns_runner.py status --config /path/to/project/tns.config.json
```

## After Install

Typical next steps:

1. Create a product document with clear `##` sections.
2. Copy `examples/tns.config.json` into your project and replace placeholder paths.
3. Decide whether quota should only be monitored or also enforce freezing.
4. Decide whether git should stay on `master` or keep per-loop branches.
5. Run `init`, then `run`, then `status`.

Example:

```bash
cp examples/tns.config.json /workspace/my-project/tns.config.json
python3 scripts/tns_runner.py init --config /workspace/my-project/tns.config.json
python3 scripts/tns_runner.py run --config /workspace/my-project/tns.config.json
```

## Demo

Standard demo:

```bash
python3 scripts/tns_runner.py init --config demo/tns-demo.config.json
python3 scripts/tns_runner.py run --config demo/tns-demo.config.json
```

Mail demo:

```bash
python3 scripts/tns_runner.py init --config demo-mail/tns-mail-demo.config.json
python3 scripts/tns_runner.py run --config demo-mail/tns-mail-demo.config.json
```

## Git Controls

```json
"git": {
  "enabled": true,
  "default_branch": "master",
  "record_all_branches": false,
  "rollback_on_quota_exhaustion": true,
  "auto_init": true
}
```

- `record_all_branches = false`: commit directly on `master`
- `record_all_branches = true`: keep each loop on its own branch, merge back on success
- `rollback_on_quota_exhaustion = true`: revert a full loop if quota is exhausted after the loop

## Notification Controls

```json
"notifications": {
  "email": {
    "enabled": false,
    "method": "smtp",
    "from": "notify@example.com",
    "to": ["you@example.com"]
  }
}
```

Supported methods:

- `smtp`
- `local_mail`

## Common Operating Modes

### Monitor Only

Use this when you want to observe quota but never block execution:

```json
"quota": {
  "provider": "rolling_usage",
  "window_token_budget": 1200000,
  "minimum_remaining": 50000,
  "enforce_freeze": false,
  "freeze_on_unknown": false
}
```

### Hard Quota Gate

Use this when the runner must stop launching new work once budget is low:

```json
"quota": {
  "provider": "rolling_usage",
  "window_token_budget": 1200000,
  "minimum_remaining": 50000,
  "enforce_freeze": true,
  "freeze_on_unknown": true
}
```

### Single-Branch Git

```json
"git": {
  "enabled": true,
  "default_branch": "master",
  "record_all_branches": false,
  "rollback_on_quota_exhaustion": true
}
```

### Per-Loop Branch History

```json
"git": {
  "enabled": true,
  "default_branch": "master",
  "record_all_branches": true,
  "rollback_on_quota_exhaustion": true
}
```

In this mode each loop runs on its own branch, and successful loops are merged back to `master`.

## Background Operation

For long-running use, adapt `examples/tns.service` and run TNS as a user service:

```bash
cp examples/tns.service ~/.config/systemd/user/tns.service
systemctl --user daemon-reload
systemctl --user enable --now tns.service
```

Then monitor with:

```bash
python3 scripts/tns_runner.py status --config /path/to/project/tns.config.json
tail -f /path/to/project/.tns/activity.jsonl
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STATE_FILES.md](docs/STATE_FILES.md)
- [docs/PRODUCT_DOC_TEMPLATE.md](docs/PRODUCT_DOC_TEMPLATE.md)
