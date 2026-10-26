---
name: plan
description: Split a goal into tasks and run each one as a background Claude Code session in its own worktree, starting each task once the tasks it depends on have landed. Also stops a running plan or retries a failed task.
argument-hint: <goal> | stop <plan> | retry <plan> <task>
disable-model-invocation: true
---

The person wants this run as a plan: $ARGUMENTS

The plan tool is `mcp__workflow__plan`. Load it with ToolSearch if it is not listed yet.

## stop or retry

If the arguments start with `stop` or `retry`, call the plan tool with `action` set to that word, `plan` set to the plan id and, for retry, `task` set to the task id. Show what it answers and stop here. The plan ids are in the /boom pane and in the answer that started the plan.

## A new plan

1. Read the repository first (Read, Grep, Glob, or the scout agent for a wide search) so the tasks fit how it is built. Do not edit anything.

2. Split the goal into tasks. Each task runs in its own background session and worktree, at the same time as the others, and lands its own work on the default branch.
   - Each task is something one session can finish, check and land on its own, in about an hour. Use as few tasks as the goal needs, at most 12. One task is fine for a small goal.
   - Write each prompt so it stands on its own: the session sees only its prompt, not the goal or the other tasks. Name the files, functions and behavior involved, and say what done looks like, including the tests.
   - `dependsOn` lists the ids of tasks that must land first, because this task builds on their code or because both would change the same files. Tasks with no dependency between them run in parallel, so only add one when it is needed.
   - `files` lists the files the task will likely change.
   - Ids are short lowercase words with hyphens, unique in the plan.

3. Show the plan: one short paragraph on how you split the work and why, then each task's id, title, what it depends on and the files it will likely change. Keep the prompts out of the chat unless the person asks to see them.

4. Ask with AskUserQuestion whether to start it, with the options Start, Change and Cancel. On Change, ask what to change, redo the plan and ask again. On Cancel, stop.

5. On Start, call the plan tool with `action` "start", `goal` (the goal in the person's words), `summary` (your paragraph) and `tasks`. Show what it answers in a few lines. The tasks land on their own from here, and the /boom pane follows them.
