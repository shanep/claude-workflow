#!/bin/sh
# Take turns at a few machine-wide check slots, so a dozen sessions running
# their tests at once do not push the load so high that every one crawls.
# Usage: turn.sh <slots dir> hold <pid> <max seconds>
#            wait for a free slot, print how many seconds that took, and hold
#            it until killed or until pid exits. After max seconds with no
#            slot, print "none" and exit.
#        turn.sh <slots dir> count
#            print "<busy> <slots>"
#
# WORKFLOW_CHECK_SLOTS sets how many run at once, a third of the cores by
# default. A slot is a hard link to a ticket that already holds this script's
# pid, so taking one is atomic and never half written. A slot whose holder
# has exited is taken back, so one killed with -9 frees its slot too.
set -u

dir=$1
what=$2
slots=${WORKFLOW_CHECK_SLOTS:-}
if [ -z "$slots" ]; then
    cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 3)
    slots=$((cores / 3))
fi
[ "$slots" -ge 1 ] 2>/dev/null || slots=1

holder() {
    cat "$1" 2>/dev/null
}

case $what in
count)
    busy=0
    i=0
    while [ "$i" -lt "$slots" ]; do
        p=$(holder "$dir/check-$i")
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
            busy=$((busy + 1))
        fi
        i=$((i + 1))
    done
    echo "$busy $slots"
    ;;
hold)
    owner=$3
    most=$4
    mkdir -p "$dir" || exit 1
    ticket="$dir/ticket-$$"
    held=
    trap 'rm -f "$ticket" ${held:+"$held"}' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    echo "$$" >"$ticket" || exit 1
    started=$(date +%s)
    while [ -z "$held" ]; do
        i=0
        while [ "$i" -lt "$slots" ]; do
            slot="$dir/check-$i"
            if ln "$ticket" "$slot" 2>/dev/null; then
                held=$slot
                break
            fi
            p=$(holder "$slot")
            if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null && mv "$slot" "$slot.$$" 2>/dev/null; then
                rm -f "$slot.$$"
                continue
            fi
            i=$((i + 1))
        done
        if [ -z "$held" ]; then
            if [ $(($(date +%s) - started)) -ge "$most" ] || ! kill -0 "$owner" 2>/dev/null; then
                echo none
                exit 0
            fi
            sleep 1
        fi
    done
    rm -f "$ticket"
    echo $(($(date +%s) - started))
    while kill -0 "$owner" 2>/dev/null; do
        sleep 1
    done
    ;;
esac
