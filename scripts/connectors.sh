#!/bin/sh
# Write what `claude mcp list` says about each MCP server and connector to a
# cache file, at most every 10 minutes. The hook starts it in the background
# and reads the cache, since the list takes a few seconds to check each one.
# Usage: connectors.sh <cache file> <folder>
#
# WORKFLOW_MCP_LIST replaces `claude mcp list`, for the tests.
set -u

out=$1
cwd=$2
list=${WORKFLOW_MCP_LIST:-claude mcp list}
mkdir -p "$(dirname "$out")" || exit 1
[ -n "$(find "$out" -mmin -10 2>/dev/null)" ] && exit 0

# One run at a time. A lock left by a run that died is cleared after 5 minutes.
lock="$out.lock"
[ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ] && rmdir "$lock"
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock"' EXIT

tmp="$out.$$"
(cd "$cwd" && exec sh -c "exec $list") >"$tmp" 2>/dev/null &
job=$!
# A server that never answers would hold the lock forever.
(sleep 60 && kill "$job" 2>/dev/null) &
dog=$!
if wait "$job" && [ -s "$tmp" ]; then
    mv "$tmp" "$out"
else
    rm -f "$tmp"
fi
kill "$dog" 2>/dev/null
wait "$dog" 2>/dev/null
exit 0
