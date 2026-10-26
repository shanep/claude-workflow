#!/bin/sh
# Test slot.sh, clone.sh, turn.sh and awake.sh in a scratch folder. Run by check.sh.
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

checks="$work/checks"
export WORKFLOW_CHECK_SLOTS=1
sh "$here/turn.sh" "$checks" hold "$$" 60 >"$work/first" &
first=$!
sleep 1
expect "a hold with a free slot waits 0s" "$(cat "$work/first")" 0
expect "a hold takes the only slot" "$(sh "$here/turn.sh" "$checks" count)" "1 1"
sh "$here/turn.sh" "$checks" hold "$$" 60 >"$work/second" &
second=$!
sleep 2
expect "a second hold waits" "$(cat "$work/second")" ""
kill "$first"
wait "$first"
sleep 2
expect "the waiting hold gets the slot once the first is killed" "$(cut -c1 "$work/second" | grep -c '[1-9]')" 1
kill -9 "$second"
wait "$second" 2>/dev/null
expect "a holder killed with -9 does not count as busy" "$(sh "$here/turn.sh" "$checks" count)" "0 1"
sleep 60 &
owner=$!
sh "$here/turn.sh" "$checks" hold "$owner" 60 >"$work/third" &
third=$!
sleep 1
expect "a slot whose holder died is taken back" "$(cat "$work/third")" 0
kill "$owner"
wait "$owner" 2>/dev/null
sleep 2
expect "a hold ends when its owner exits" "$(kill -0 "$third" 2>/dev/null && echo running)" ""
expect "and frees its slot" "$(sh "$here/turn.sh" "$checks" count)" "0 1"
sh "$here/turn.sh" "$checks" hold "$$" 60 >/dev/null &
fourth=$!
sleep 1
expect "a hold that waits too long gives up" "$(sh "$here/turn.sh" "$checks" hold "$$" 1)" none
kill "$fourth"
wait "$fourth"
expect "no tickets are left behind" "$(find "$checks" -name 'ticket-*')" ""
unset WORKFLOW_CHECK_SLOTS

# Only macOS is sure to have a holder, since systemd-inhibit needs logind.
if command -v caffeinate >/dev/null 2>&1; then
    awake="$work/awake"
    sleep 60 &
    owner=$!
    expect "awake.sh holds the computer awake" "$(sh "$here/awake.sh" "$awake" "$owner")" awake
    holder=$(cat "$awake/$owner")
    expect "a second call says awake" "$(sh "$here/awake.sh" "$awake" "$owner")" awake
    expect "and keeps the same holder" "$(cat "$awake/$owner")" "$holder"
    kill "$owner"
    wait "$owner" 2>/dev/null
    sleep 1
    expect "the holder exits with its owner" "$(kill -0 "$holder" 2>/dev/null && echo running)" ""
    sh "$here/awake.sh" "$awake" "$$" >/dev/null
    expect "the dead owner's file is removed" "$([ -e "$awake/$owner" ] && echo left)" ""
fi

exit "$failed"
