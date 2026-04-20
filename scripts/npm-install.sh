#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

echo "Installing TNS runner..."

# Install dependencies and build
npm install
npm run build

# Link globally for CLI access
npm link

echo ""
echo "TNS runner installed successfully!"
echo ""
echo "Usage:"
echo "  tns init --config /path/to/config.json"
echo "  tns status --config /path/to/config.json"
echo "  tns run --config /path/to/config.json"
echo ""
echo "Or use npx:"
echo "  npx tns status --config /path/to/config.json"
