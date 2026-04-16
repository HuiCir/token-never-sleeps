#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.claude/plugins/local/token-never-sleeps"
TARGET_PARENT="$(dirname "${TARGET_DIR}")"
STAGING_DIR="$(mktemp -d "${TARGET_PARENT}/token-never-sleeps.XXXXXX")"

cleanup() {
  rm -rf "${STAGING_DIR}"
}
trap cleanup EXIT

mkdir -p "${TARGET_PARENT}"

python3 - "${REPO_ROOT}" "${STAGING_DIR}" "${TARGET_DIR}" <<'PY'
import shutil
import sys
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
staging_dir = Path(sys.argv[2]).resolve()
target_dir = Path(sys.argv[3]).expanduser()

ignore = shutil.ignore_patterns(
    ".git",
    ".gitignore",
    "__pycache__",
    "*.pyc",
    "*.pyo",
    ".DS_Store",
)

shutil.copytree(repo_root, staging_dir, dirs_exist_ok=True, ignore=ignore)

# Render install-time absolute paths only in executable plugin entrypoints
# so the plugin does not rely on CLAUDE_PLUGIN_ROOT being injected by the host
# environment.
render_targets = [staging_dir / "hooks" / "hooks.json", *staging_dir.glob("skills/*/SKILL.md")]
for path in render_targets:
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    rendered = text.replace("${CLAUDE_PLUGIN_ROOT}", str(target_dir))
    if rendered != text:
        path.write_text(rendered, encoding="utf-8")
PY

rm -rf "${TARGET_DIR}"
mv "${STAGING_DIR}" "${TARGET_DIR}"
trap - EXIT

cat <<EOF
Installed Token Never Sleeps for local Claude usage.

Installed plugin directory:
  ${TARGET_DIR}

Source repository:
  ${REPO_ROOT}

This install renders absolute hook/skill commands into the installed copy,
so it does not depend on CLAUDE_PLUGIN_ROOT existing on the target machine.

Run Claude with:
  claude --plugin-dir "${TARGET_DIR}"

Or add this repo as a marketplace:
  claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
  claude plugin install token-never-sleeps@token-never-sleeps
EOF
