#!/bin/sh
# Test slot.sh and clone.sh in a scratch folder. Run by check.sh.
set -u

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0

expect() {
    if [ "$2" = "$3" ]; then
        echo "ok: $1"
    else
        echo "FAIL: $1: expected '$3', got '$2'"
        failed=1
    fi
}

# A pid that has exited.
dead=$(sh -c 'echo $$')
slots="$work/slots"
expect "a first claim gets slot 0" "$(sh "$here/slot.sh" "$slots" "$$")" 0
expect "the same pid keeps its slot" "$(sh "$here/slot.sh" "$slots" "$$")" 0
sleep 60 &
live=$!
expect "another live pid gets the next slot" "$(sh "$here/slot.sh" "$slots" "$live")" 1
kill "$live"
wait "$live" 2>/dev/null
expect "a slot whose owner exited is taken back" "$(sh "$here/slot.sh" "$slots" "$dead")" 1
expect "the taken back slot names its new owner" "$(cat "$slots/slot-1/pid")" "$dead"

main="$work/main"
wt="$work/wt"
mkdir -p "$main/node_modules/pkg/.bin" "$wt"
echo hi >"$main/node_modules/pkg/index.js"
echo lock >"$main/package-lock.json"
echo other >"$wt/package-lock.json"
expect "a lockfile that differs is reported" "$(sh "$here/clone.sh" "$main" "$wt")" differs
echo lock >"$wt/package-lock.json"
expect "matching lockfiles clone node_modules" "$(sh "$here/clone.sh" "$main" "$wt")" cloned
expect "the clone holds the files" "$(cat "$wt/node_modules/pkg/index.js")" hi
expect "an existing node_modules is left alone" "$(sh "$here/clone.sh" "$main" "$wt")" ""
rm "$main/package-lock.json" "$wt/package-lock.json"
rm -rf "$wt/node_modules"
expect "no lockfile means nothing to do" "$(sh "$here/clone.sh" "$main" "$wt")" ""
expect "no temporary copy is left behind" "$(find "$wt" -name '.node_modules.workflow-*')" ""

exit "$failed"
