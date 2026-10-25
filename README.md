# Workflow

A Claude Code plugin that keeps parallel sessions in one git repo out of each
other's files. Run a few sessions at once, in the main checkout or in
worktrees, and each one knows what the others are changing.

It is three hooks and some files in `.git`. There are no timers, no server and
no background fetch, and every hook lets the call through if it breaks, so a
bad check never stops your work.

## Install

```
/plugin marketplace add shanep/claude-plugins
/plugin install workflow@shanep
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

## How it works

Each session writes what it is changing to
`.git/workflow/sessions/<session id>.json`. All worktrees share that folder,
so every session sees every other one. A session counts while its Claude Code
process runs (from Claude Code's own `~/.claude/sessions` files), and a file
left by a session that crashed is removed the next time another session looks.

In a worktree the changed files come from git: everything the branch changed
since it left the default branch, plus untracked files. In the main checkout
every session shares one working tree, so only the files a session edited
count as its own.

Git runs at most every 30 seconds, on a prompt or after a Bash call. Nothing
fetches. Worktrees share their remote branches, so once any session lands or
fetches, the others see it.

## For other plugins

The plugin keeps what it knows in `$.state` under `workflow.repo`: the
checkout, the target branch, this session's files, the other sessions, recent
pauses and the upstream files to rebase on. `types/index.d.ts` has the shape.
List `workflow` under `dependencies` in your `plugin.json` to read it. The
`/boom` pane in [drboom](https://github.com/shanep/claude-DrBOOM) does.

## Checks

```
npm run check
git config core.hooksPath .githooks
```

The second command runs the checks before every push. They validate the JSON,
and where Claude Code is installed, the plugin itself.
