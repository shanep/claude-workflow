#!/bin/sh
# Copy the main checkout's node_modules into a worktree that has none, when
# their lockfiles match. Prints "cloned", "differs" when the lockfiles do not
# match, or nothing when there is nothing to do.
# Usage: clone.sh <main checkout> <worktree>
#
# The copy is copy-on-write where the file system can (APFS, btrfs, XFS), so
# it takes seconds. On macOS, clonefileat(2) clones the whole tree in one call,
# about a second where cp -c takes ten: 462 is SYS_clonefileat and -2 is
# AT_FDCWD. The copy is built beside the worktree and moved in whole, so a
# session there never sees half of it.
set -u

main=$1
here=$2
src="$main/node_modules"
dst="$here/node_modules"
[ -d "$src" ] && [ ! -e "$dst" ] || exit 0

matched=0
for lock in package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do
    if [ -e "$main/$lock" ]; then
        if ! cmp -s "$main/$lock" "$here/$lock"; then
            echo differs
            exit 0
        fi
        matched=1
    fi
done
[ "$matched" -eq 1 ] || exit 0

tmp="$here/.node_modules.workflow-$$"
if [ "$(uname)" = Darwin ]; then
    # shellcheck disable=SC2016 # perl reads $ARGV and $!, not the shell
    /usr/bin/perl -e 'syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 or die "clonefileat: $!\n"' "$src" "$tmp" 2>/dev/null ||
        { rm -rf "$tmp" && cp -Rc "$src" "$tmp" 2>/dev/null; } ||
        { rm -rf "$tmp" && cp -R "$src" "$tmp"; }
else
    cp -R --reflink=auto "$src" "$tmp" 2>/dev/null || { rm -rf "$tmp" && cp -R "$src" "$tmp"; }
fi || { rm -rf "$tmp"; exit 1; }

if [ ! -e "$dst" ] && mv "$tmp" "$dst"; then
    echo cloned
fi
rm -rf "$tmp"
