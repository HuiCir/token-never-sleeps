# Token Never Sleeps

Token Never Sleeps is a Claude plugin and runner for long-running work from a single `task.md`.

Default behavior:

- reads `workspace/task.md`
- auto-initializes on first `run`
- uses a 5 hour refresh window
- keeps git enabled
- rolls back to the latest clean state if Claude hits a usage-limit style error

## Quickstart

### 1. Choose how to get it

Option A: Download from GitHub

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
```

Option B: Install as a Claude plugin

```bash
claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
claude plugin install token-never-sleeps@token-never-sleeps
```

### 2. In your workspace create two files

`tns_config.json`

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

### 3. Run TNS

Direct runner mode:

```bash
python3 /path/to/token-never-sleeps/scripts/tns_runner.py run --config /absolute/path/to/your/project/tns_config.json
```

Claude plugin mode:

```bash
claude --plugin-dir ~/.claude/plugins/local/token-never-sleeps
```

Then inside Claude:

```text
/tns-start run --config /absolute/path/to/your/project/tns_config.json
```

`run` auto-initializes. You do not need to call `init` first.

### 4. Check status

```bash
python3 /path/to/token-never-sleeps/scripts/tns_runner.py status --config /absolute/path/to/your/project/tns_config.json
```

Or inside Claude:

```text
/tns-status --config /absolute/path/to/your/project/tns_config.json
```

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
