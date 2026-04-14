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

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STATE_FILES.md](docs/STATE_FILES.md)
- [docs/PRODUCT_DOC_TEMPLATE.md](docs/PRODUCT_DOC_TEMPLATE.md)
