# Token Never Sleeps

Token Never Sleeps is a Claude plugin for long-running work from a TaskList `task.md`.

Default behavior:

- reads `workspace/task.md`
- auto-initializes on first `/tns-start run`
- uses a 5 hour refresh window
- keeps git enabled
- rolls back to the latest clean state if Claude hits a usage-limit style error

## Quickstart

### 1. Plugin Install

Install it directly as a Claude plugin

```bash
claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
claude plugin install token-never-sleeps@token-never-sleeps
claude
```

Get it from GitHub and load it locally

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
claude --plugin-dir ~/.claude/plugins/local/token-never-sleeps
```

Install Verification

```bash
claude plugin validate ~/.claude/plugins/local/token-never-sleeps
```

### 2. In your workspace create two files

`tns_config.json`

Full Config Template See [examples/tns_config.json](examples/tns_config.json).

```json
{
  "workspace": "/absolute/path/to/project",
  "product_doc": "/absolute/path/to/project/task.md",
  "refresh_hours": 5,
  "effort": "high",
}
```

`task.md`

```md
# Task

## Section 1
Task 1 ...

## Section 2
Task 2 ...
```

### 3. Check status inside Claude

```text
/tns-status --config tns_config.json
```

### 4. Start TNS inside Claude

```text
/tns-start run --config tns_config.json
```


