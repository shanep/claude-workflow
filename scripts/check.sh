#!/bin/sh
# Validate the JSON, lint and test the scripts, and validate the plugin itself
# where Claude Code is installed, which CI is not. Run with: npm run check
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")

for f in "$repo"/.claude-plugin/plugin.json "$repo"/hooks/hooks.json "$repo"/package.json "$repo"/tsconfig.json; do
    jq empty "$f"
done

if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$here"/*.sh
fi
sh "$here/test.sh"

if command -v claude >/dev/null 2>&1; then
    claude plugin validate "$repo"
fi

# Claude Code lays down the types the first time it loads the plugin.
if command -v tsc >/dev/null 2>&1 && [ -d "$repo/.claude-plugin/types" ]; then
    tsc -p "$repo" --noEmit
fi

echo "All checks passed."
