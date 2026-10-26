#!/bin/sh
# Keep this computer from sleeping while a Claude Code process runs, and print
# "awake" once it is held. The display can still turn off.
# Usage: awake.sh <awake dir> <pid>
#
# The holder (caffeinate on macOS, systemd-inhibit on Linux) exits with the
# Claude Code process, so a crash never leaves the computer awake. Its pid
# goes in <awake dir>/<pid>, so a second call for the same process starts no
# second holder.
set -u

dir=$1
pid=$2
mkdir -p "$dir" || exit 1
holder=$(cat "$dir/$pid" 2>/dev/null)
if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo awake
    exit 0
fi
# Files left by processes that have exited.
for file in "$dir"/*; do
    [ -f "$file" ] || continue
    kill -0 "$(basename "$file")" 2>/dev/null || rm -f "$file"
done
if command -v caffeinate >/dev/null 2>&1; then
    # -i blocks idle system sleep and leaves display sleep alone.
    nohup caffeinate -i -w "$pid" </dev/null >/dev/null 2>&1 &
    holder=$!
elif command -v systemd-inhibit >/dev/null 2>&1; then
    # A sleep lock held by logind until the process is gone.
    # shellcheck disable=SC2016 # $1 is the inner shell's, not this one's.
    nohup systemd-inhibit --what=sleep --who=workflow --why="Claude Code is working" --mode=block \
        sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 30; done' sh "$pid" </dev/null >/dev/null 2>&1 &
    holder=$!
    # Without logind or the right to block sleep it exits at once.
    sleep 1
    kill -0 "$holder" 2>/dev/null || exit 0
else
    exit 0
fi
echo "$holder" >"$dir/$pid"
echo awake
