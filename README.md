# Token Never Sleeps

Token Never Sleeps is a Claude plugin and runner for long-running task execution with:

- task section tracking from `task.md`
- clean-state handoff between runs
- executor / verifier loop
- built-in git checkpointing
- automatic rollback when Claude hits a usage-limit style error
- default 5 hour refresh window

## Quickstart

1. Clone and locally install the plugin:

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
```

2. In your project workspace, create:

- `task.md`
- `tns.config.json`

Example `tns.config.json`:

```json
{
  "workspace": "/absolute/path/to/your/project"
}
```

Example `task.md`:

```md
# Task

## Section 1
Implement feature A. Define clear acceptance criteria.

## Section 2
Verify feature A and document the result.
```

3. Initialize and run:

```bash
python3 /path/to/token-never-sleeps/scripts/tns_runner.py init --config /absolute/path/to/your/project/tns.config.json
python3 /path/to/token-never-sleeps/scripts/tns_runner.py run --config /absolute/path/to/your/project/tns.config.json
```

4. Check status:

```bash
python3 /path/to/token-never-sleeps/scripts/tns_runner.py status --config /absolute/path/to/your/project/tns.config.json
```

## Install Verification

```bash
claude plugin validate ~/.claude/plugins/local/token-never-sleeps
```

## Default Behavior

- reads task sections from `workspace/task.md`
- uses a 5 hour refresh window
- keeps git enabled
- works on `master` by default
- rolls back to the recent clean git checkpoint if Claude hits a usage-limit style error

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STATE_FILES.md](docs/STATE_FILES.md)
- [docs/PRODUCT_DOC_TEMPLATE.md](docs/PRODUCT_DOC_TEMPLATE.md)
