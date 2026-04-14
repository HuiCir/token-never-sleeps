#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.claude/plugins/local/token-never-sleeps"

mkdir -p "$(dirname "${TARGET_DIR}")"
ln -sfn "${REPO_ROOT}" "${TARGET_DIR}"

cat <<EOF
Installed Token Never Sleeps for local Claude usage.

Local symlink:
  ${TARGET_DIR} -> ${REPO_ROOT}

Run Claude with:
  claude --plugin-dir "${TARGET_DIR}"

Or add this repo as a marketplace:
  claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
  claude plugin install token-never-sleeps@token-never-sleeps
EOF
