# Token Never Sleeps

Token Never Sleeps is a Claude plugin for long-running work from a single `task.md`.

Default behavior:

- reads `workspace/task.md`
- auto-initializes on first `/tns-start run`
- uses a 5 hour refresh window
- keeps git enabled
- rolls back to the latest clean state if Claude hits a usage-limit style error

## Quickstart

### 1. Choose how to install

Option A: Get it from GitHub and load it locally

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
claude --plugin-dir ~/.claude/plugins/local/token-never-sleeps
```

Option B: Install it directly as a Claude plugin

```bash
claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
claude plugin install token-never-sleeps@token-never-sleeps
claude
```

### 2. In your workspace create two files

`tns_config.json`

Minimal example:

```json
{
  "workspace": "/absolute/path/to/your/project"
}
```

`task.md`

```md
# Task

## Section 1
Implement one concrete unit of work with clear acceptance criteria.

## Section 2
Verify the result and document it.
```

### 3. Start TNS inside Claude

```text
/tns-start run --config /absolute/path/to/your/project/tns_config.json
```

You do not need to initialize separately. `run` auto-initializes.

### 4. Check status inside Claude

```text
/tns-status --config /absolute/path/to/your/project/tns_config.json
```

## Config Fields

### Required

- `workspace`
  - Absolute path to the target workspace.

### Optional With Defaults

- `product_doc`
  - Default: `workspace/task.md`
- `refresh_hours`
  - Default: `5`
- `permission_mode`
  - Default: `default`
- `effort`
  - Default: `high`
- `success_interval_seconds`
  - Default: `1`
- `idle_interval_seconds`
  - Default: `60`
- `executor_agent`
  - Default: `tns-executor`
- `verifier_agent`
  - Default: `tns-verifier`
- `max_budget_usd`
  - Default: unset
- `git.enabled`
  - Default: `true`
- `git.default_branch`
  - Default: `master`
- `git.record_all_branches`
  - Default: `false`
- `git.rollback_on_quota_exhaustion`
  - Default: `true`
- `git.auto_init`
  - Default: `true`
- `notifications.email.enabled`
  - Default: `false`
- `notifications.email.method`
  - Default: `local_mail`
- `notifications.email.from`
  - Default: `tns@localhost`
- `notifications.email.subject_prefix`
  - Default: `[TNS]`

### Optional Beta / Advanced

- `refresh_minutes`
  - Overrides `refresh_hours` when set.
- `refresh_seconds`
  - Overrides `refresh_minutes` and `refresh_hours` when set.
- `quota.provider`
  - Supported: `none`, `rolling_usage`, `command`
- `quota.window_token_budget`
- `quota.minimum_remaining`
- `quota.enforce_freeze`
- `quota.freeze_on_unknown`
- `quota.command`
- `notifications.email.smtp.*`
  - SMTP host, port, auth, TLS/SSL options.

## Full Config Template

See [examples/tns_config.json](examples/tns_config.json).

## Install Verification

```bash
claude plugin validate ~/.claude/plugins/local/token-never-sleeps
```

## Files

- [examples/tns_config.json](examples/tns_config.json)
- [examples/task.md](examples/task.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STATE_FILES.md](docs/STATE_FILES.md)
- [docs/PRODUCT_DOC_TEMPLATE.md](docs/PRODUCT_DOC_TEMPLATE.md)
