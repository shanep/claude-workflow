#!/bin/sh
# Claim the lowest free port slot for a Claude Code process and print it.
# Usage: slot.sh <slots dir> <pid>
#
# A slot is a folder, since mkdir either makes it or fails, so two sessions
# never get the same one. Its pid file names the owner. A slot whose owner
# has exited is moved aside first, which only one session can do, then
# claimed like a free one.
set -u

dir=$1
pid=$2
i=0
mkdir -p "$dir" || exit 1
while [ "$i" -lt 100 ]; do
    slot="$dir/slot-$i"
    if mkdir "$slot" 2>/dev/null; then
        echo "$pid" >"$slot/pid"
        echo "$i"
        exit 0
    fi
    owner=$(cat "$slot/pid" 2>/dev/null)
    if [ "$owner" = "$pid" ]; then
        echo "$i"
        exit 0
    fi
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && mv "$slot" "$slot.$pid" 2>/dev/null; then
        rm -rf "$slot.$pid"
        continue
    fi
    i=$((i + 1))
done
echo "all 100 port slots are taken" >&2
exit 1
