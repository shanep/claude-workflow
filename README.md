# Workflow

A Claude Code plugin that keeps parallel sessions in one git repo out of each
other's files and ports, and keeps their checks from swamping the machine. Run a few sessions at once, in the main checkout or
in worktrees, and each one knows what the others are changing.

It is three hooks and some files in `.git`. There are no timers, no server and
no background fetch, and every hook lets the call through if it breaks, so a
bad check never stops your work.

## Install

```
claude plugin marketplace add shanep/claude-plugins
claude plugin install workflow@shanep
```

## What it does

- **Tells Claude who else is here.** The first prompt in a session, and any
  prompt after a session starts or stops, gets a note listing the other
  sessions in the repo, what each one is working on (its first prompt) and
  the files it is changing.
- **Pauses the first edit to a file another session is changing.** Claude gets
  the reason and can leave the file alone or make the same edit again, which
  goes through.
- **Says when to rebase.** When commits land on origin's default branch that
  change files this session also changed, the next prompt or Bash result says
  so, once per file, while the conflict is still small.
- **Gives each session its own ports.** Every Bash command gets
  `WORKFLOW_PORT_BASE`, the first of 100 ports no other session has (40000,
  40100 and so on), and `WORKFLOW_SLOT`, the slot number. Point dev servers at
  it and two sessions never fight over port 3000. The first prompt says so.
- **Sets up new worktrees.** A worktree with no `node_modules` gets a
  copy-on-write clone of the main checkout's when the lockfiles match, which
  takes a second or two instead of an install. When they differ, Claude is
  told to install. Claude Code itself copies the files `.worktreeinclude`
  names, like `.env`.
- **Takes turns at checks.** When Claude runs a check (`npm test`,
  `make check`, `tsc`, `pytest`, `cargo test`, `git push`, `land` and the
  like), it first waits for one of a few machine-wide check slots, a third of
  the cores by default. A dozen sessions testing at once pushed the load past
  150 on 10 cores and every one crawled, so taking turns gets each done
  sooner. Set `WORKFLOW_CHECK_SLOTS` to change the limit. A check that waits
  over 10 minutes runs anyway, and Claude hears how long it waited.

## How it works

Each session writes what it is changing to
`.git/workflow/sessions/<session id>.json`. All worktrees share that folder,
so every session sees every other one. A session counts while its Claude Code
process runs, and a file left by a session that crashed is removed the next
time another session looks.

In a worktree the changed files come from git: everything the branch changed
since it left the default branch, plus untracked files. In the main checkout
every session shares one working tree, so only the files a session edited
count as its own.

Git runs at most every 30 seconds, on a prompt or after a Bash call. Nothing
fetches. Worktrees share their remote branches, so once any session lands or
fetches, the others see it.

Port slots are folders under `~/.claude/workflow/slots/`. A session claims the
lowest free one with `mkdir`, which only one session can win, and a slot whose
Claude Code process has exited is taken back by the next session that needs
one. `scripts/slot.sh` and `scripts/clone.sh` do the work.

A check slot is held by a small `scripts/turn.sh` process that the hook
starts before the command and kills once it is done. The command itself is
never changed, so your permission rules see it as written. The holder also
exits if Claude Code does, so a crash or Esc never leaves a slot taken.

## For other plugins

The plugin keeps what it knows in `$.state` under `workflow.repo`: the
checkout, the target branch, this session's files, the other sessions, recent
pauses, the upstream files to rebase on, the port base, how the worktree
setup went and how many check slots are busy. `types/index.d.ts` has the shape. Copy the `Repo` type into your
own contract instead of listing `workflow` under `dependencies`, since a
missing dependency turns your whole plugin off. The `/boom` pane in
[drboom](https://github.com/shanep/claude-DrBOOM) does this.

## Checks

```
npm run check
git config core.hooksPath .githooks
```

The second command runs the checks before every push. They validate the JSON,
run shellcheck and the script tests, and where Claude Code is installed,
validate the plugin itself.
