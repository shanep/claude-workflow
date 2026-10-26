#!/bin/sh
# Checks that the repo a session starts in is healthy at head: no rebase or
# merge is half done, the default branch is level with origin, no branch holds
# work that never landed, CI on the default branch ran on head and is green, and
# a repo without CI passes its own check command at origin's head. A repo with
# neither has an untested head, and that is reported too.
#
# It also checks that the repo is set up for an agent to work in: its git hooks
# actually run, a pre-commit or pre-push hook checks work before it lands, and
# it has a check command. A missing piece fails quietly, so it is reported out
# loud here.
#
# What it finds also goes in workflow-health in the checkout's git dir: the
# time it ran, then the problems, each starting with "- ". The workflow module
# reads it for the drboom pane.
#
# SessionStart runs it async so a fetch or a test run never holds up startup.
# Claude Code hands the JSON it prints to Claude on the next turn, which is
# after the user's first message, and never shows an async hook's systemMessage
# to the user. So Claude is told to open its reply with the problems, since that
# reply is the first the user hears of them. A healthy repo prints nothing.
#
# The check command runs in a detached worktree under ~/.cache/repo-health, not
# in the checkout, so a session's edits cannot break the run and the run cannot
# touch them. Its result is kept per commit, so it runs once per commit however
# many sessions start.

command -v jq >/dev/null || exit 0
top=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" || exit 0

# Never stop to ask for a password or passphrase, there is nobody to answer.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"

state="${XDG_CACHE_HOME:-$HOME/.cache}/workflow-health/$(basename "$top")-$(printf '%s' "$top" | cksum | cut -d' ' -f1)"
mkdir -p "$state"

problems=
note() {
	problems="$problems
- $1"
}

report() {
	found="$(git rev-parse --absolute-git-dir)/workflow-health"
	{ date +%s; printf '%s\n' "$problems" | sed '1d'; } >"$found.$$" && mv "$found.$$" "$found"
	[ -n "$problems" ] || return 0
	printf '%s\n' "$problems" | sed '1d' |
		jq -Rs --arg top "$top" '{hookSpecificOutput: {hookEventName: "SessionStart",
			additionalContext: ("The repo health check for \($top) found problems. Every project should live at head, so open your reply with these and offer to fix them:\n" + .)}}'
}

gitdir=$(git rev-parse --git-dir)
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]
then
	note "A rebase is half done in $top."
fi
if [ -f "$gitdir/MERGE_HEAD" ]
then
	note "A merge is half done in $top."
fi

dirty=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')
if [ "$dirty" -gt 0 ]
then
	note "$dirty tracked file(s) have uncommitted changes. They may belong to another session working in this checkout."
fi

if ! git remote get-url origin >/dev/null 2>&1
then
	note "The repo has no origin remote, so none of its work is backed up."
	sha=$(git rev-parse HEAD)
	default=
else
	default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
	default=${default#origin/}
	[ -n "$default" ] || default=master
	git fetch -q origin "$default" 2>/dev/null ||
		note "git fetch failed, so the checks below use the last fetched state of origin."
	sha=$(git rev-parse -q --verify "origin/$default") || sha=$(git rev-parse HEAD)
fi

if [ -n "$default" ] && git show-ref -q --verify "refs/heads/$default"
then
	# shellcheck disable=SC2046 # the two counts are meant to split
	set -- $(git rev-list --left-right --count "$default...origin/$default")
	if [ "$1" -gt 0 ]
	then
		note "Local $default has $1 commit(s) that are not on origin. Land them."
	fi
	if [ "$2" -gt 0 ]
	then
		note "Local $default is $2 commit(s) behind origin/$default. Run git pull --rebase before the first edit."
	fi
fi

# git cherry matches commits by patch, so a branch that landed by rebase does
# not show up just because its commits got new hashes.
if [ -n "$default" ]
then
	current=$(git symbolic-ref --short HEAD 2>/dev/null)
	unlanded=
	for branch in $(git for-each-ref --format='%(refname:short)' refs/heads)
	do
		[ "$branch" = "$default" ] || [ "$branch" = "$current" ] && continue
		count=$(git cherry "origin/$default" "$branch" 2>/dev/null | grep -c '^+')
		[ "$count" -gt 0 ] && unlanded="$unlanded $branch ($count)"
	done
	if [ -n "$unlanded" ]
	then
		note "These branches hold commits that never landed on origin/$default, which may be a background session's work in progress:$unlanded"
	fi
fi

# git rev-parse --git-path hooks follows core.hooksPath, so this is the folder
# git really runs hooks from.
hooks=$(git rev-parse --git-path hooks)
if [ -d .githooks ] && [ "$(cd "$hooks" 2>/dev/null && pwd -P)" != "$(cd .githooks && pwd -P)" ]
then
	note "The repo keeps hooks in .githooks, but core.hooksPath does not point there, so they never run. Run git config core.hooksPath .githooks."
	hooks=.githooks
fi
for hook in pre-commit pre-push
do
	if [ -f "$hooks/$hook" ] && [ ! -x "$hooks/$hook" ]
	then
		note "$hooks/$hook is not executable, so git skips it without a word. Run chmod +x $hooks/$hook and commit the mode change."
	fi
done
if [ ! -f "$hooks/pre-commit" ] && [ ! -f "$hooks/pre-push" ]
then
	note "No pre-commit or pre-push hook runs the checks, so work can land without them. Add one to .githooks that runs the check command, and run git config core.hooksPath .githooks."
fi

# The check command an agent runs by name. npm test or a guess from the project
# files does not count, since it may not be the whole check.
explicit_check() {
	if [ -f package.json ] && jq -e '.scripts.check' package.json >/dev/null 2>&1
	then
		echo "npm run check"
		return
	fi
	for file in Makefile makefile GNUmakefile
	do
		if [ -f "$file" ] && grep -q '^check:' "$file"
		then
			echo "make check"
			return
		fi
	done
	for file in justfile Justfile .justfile
	do
		if [ -f "$file" ] && grep -q '^check:' "$file"
		then
			echo "just check"
			return
		fi
	done
}
if [ -z "$(explicit_check)" ]
then
	note "The repo has no npm check script, make check target or just check recipe, so an agent has to guess how to run its checks. Add one that runs everything CI and the hooks run."
fi

# The latest finished run of each workflow on the default branch. One still
# running is not a problem yet, so it is skipped in favor of the last result.
if [ -n "$default" ] && [ -d .github/workflows ] && command -v gh >/dev/null
then
	if runs=$(gh run list --branch "$default" --limit 50 \
		--json workflowName,headSha,status,conclusion,url 2>/dev/null)
	then
		failing=$(printf '%s' "$runs" | jq -r --arg head "$sha" '
			map(select(.status == "completed"))
			| reduce .[] as $r ({}; if has($r.workflowName) then . else .[$r.workflowName] = $r end)
			| .[]
			| select(.conclusion | IN("success", "skipped", "neutral") | not)
			| "\(.workflowName): \(.conclusion)"
				+ (if .headSha == $head then "" else " on an older commit, \(.headSha[0:7])" end)
				+ ", \(.url)"')
		if [ -n "$failing" ]
		then
			note "CI on $default is not green:
$(printf '%s\n' "$failing" | sed 's/^/  - /')"
		fi
		# A workflow that only runs on pull requests or skips some paths can
		# leave head untested without a single failure to show for it.
		if ! printf '%s' "$runs" | jq -e --arg head "$sha" 'any(.[]; .headSha == $head)' >/dev/null
		then
			note "CI has not run on $(git rev-parse --short "$sha"), the head of $default, so head is untested. Check the workflow triggers."
		fi
	else
		note "gh run list failed, so CI was not checked. gh may need gh auth login."
	fi
	report
	exit 0
fi

# Without CI, the repo's own check command stands in for it. npm check or make
# check is the one to add to a repo. Until it has one, npm test, make test or a
# guess from the project files is used, and a guess can be wrong.
check_command() {
	cmd=$(explicit_check)
	if [ -n "$cmd" ]
	then
		echo "$cmd"
		return
	fi
	if [ -f package.json ]
	then
		case $(jq -r '.scripts.test // empty' package.json) in
		"" | *"no test specified"*) ;;
		*)
			echo "npm test"
			return
			;;
		esac
	fi
	if [ -f Makefile ] && grep -q '^test:' Makefile
	then
		echo "make test"
	elif [ -f pyproject.toml ]
	then
		echo "uv run --with pytest pytest"
	elif [ -f requirements.txt ]
	then
		echo "uv run --with-requirements requirements.txt --with pytest pytest"
	elif [ -n "$(find . -maxdepth 1 \( -name '*.sln' -o -name '*.slnx' -o -name '*.csproj' \))" ]
	then
		echo "dotnet test"
	elif [ -f go.mod ]
	then
		echo "go vet ./... && go test ./..."
	elif [ -f Cargo.toml ]
	then
		echo "cargo test"
	elif [ -f CMakeLists.txt ]
	then
		echo "cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure"
	fi
}

cmd=$(check_command)
if [ -z "$cmd" ]
then
	note "The repo has no CI and no check command, so nothing tests head. Add an npm check script or a make check target."
	report
	exit 0
fi
if ! command -v "${cmd%% *}" >/dev/null
then
	note "The check command \`$cmd\` needs ${cmd%% *}, which is not installed here, so head was not tested."
	report
	exit 0
fi

short=$(git rev-parse --short "$sha")
result="$state/check-$sha"
log="$state/check-$sha.log"
lock="$state/lock"
tree="$state/tree"
if [ ! -f "$result" ]
then
	if ! mkdir "$lock" 2>/dev/null
	then
		# A run that was killed leaves its lock behind, so take over an old one.
		if [ -n "$(find "$lock" -maxdepth 0 -mmin +30)" ]
		then
			rmdir "$lock"
			mkdir "$lock" 2>/dev/null || exit 0
		else
			exit 0
		fi
	fi
	trap 'rmdir "$lock"' EXIT

	if [ ! -d "$tree" ] || ! git -C "$tree" rev-parse >/dev/null 2>&1
	then
		rm -rf "$tree"
		git worktree prune
		git worktree add -q --detach "$tree" "$sha" >/dev/null 2>&1
	fi
	if git -C "$tree" checkout -q --detach "$sha" 2>/dev/null &&
		git -C "$tree" clean -qfdx -e node_modules -e .venv
	then
		cmd=$(cd "$tree" && check_command)
		# Installing takes longer than most checks, so it is skipped while the
		# lockfile is unchanged.
		install=
		if [ -f "$tree/package-lock.json" ]
		then
			stamp=$(cksum <"$tree/package-lock.json")
			if [ ! -d "$tree/node_modules" ] || [ "$stamp" != "$(cat "$state/lockfile" 2>/dev/null)" ]
			then
				install="npm ci && "
			fi
		elif [ -f "$tree/package.json" ] && [ ! -d "$tree/node_modules" ]
		then
			install="npm install && "
		fi

		# The check and its watchdog each run in their own process group, so
		# a kill stops everything they started, not just the shell.
		set -m
		(cd "$tree" && exec sh -c "$install$cmd") >"$log" 2>&1 </dev/null &
		pid=$!
		(sleep 900 && kill -TERM -"$pid") >/dev/null 2>&1 &
		dog=$!
		set +m
		wait "$pid"
		code=$?
		kill -TERM -"$dog" 2>/dev/null
		wait "$dog" 2>/dev/null

		[ -f "$tree/package-lock.json" ] && cksum <"$tree/package-lock.json" >"$state/lockfile"
		for old in "$state"/check-*
		do
			case $old in
			"$result" | "$log") ;;
			*) rm -f "$old" ;;
			esac
		done
		printf '%s\n%s\n' "$code" "$cmd" >"$result"
	else
		note "The health check could not check out $short in $tree, so the check command was not run."
	fi
fi

if [ -f "$result" ]
then
	code=$(sed -n 1p "$result")
	cmd=$(sed -n 2p "$result")
	if [ "$code" != 0 ]
	then
		if [ "$code" -gt 128 ]
		then
			how="was stopped after 15 minutes"
		elif [ "$code" = 5 ] && [ "${cmd#uv run}" != "$cmd" ]
		then
			how="found no tests to run"
		else
			how="fails (exit $code)"
		fi
		note "\`$cmd\` $how at $short, the head of ${default:-HEAD}. Log: $log"
	fi
fi

report
