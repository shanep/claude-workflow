// How far a session has got and what it cost.
export type Progress = {
  // What the session has cost so far in dollars, as /cost totals it.
  usd: number
  // The most it should spend in dollars, or null without a budget.
  budget: number | null
  // Its task list, or null when it keeps none.
  tasks: { done: number; total: number; current: string | null } | null
  // A rough guess at what is left from the share of the task list done so
  // far, or null before the first task is done.
  left: { usd: number; ms: number } | null
  // How much of the five hour limit is used, in percent, or null without a reading.
  fiveHour: number | null
}

// Another session in the repo, as the pane lists it.
export type Peer = {
  topic: string | null
  // "in this same checkout", "on branch x" or a folder.
  where: string
  files: string[]
  // Null when it runs a workflow from before 0.7.0.
  progress: Progress | null
}

// An edit that was paused because another session is changing the file.
export type Pause = { file: string; at: number }

// What scripts/health.sh found when the session started: when it ran, in
// milliseconds, and its problems. None means the repo is healthy at head.
export type Health = { at: number; problems: string[] }

// One task of a plan, as the pane lists it.
export type PlanTaskView = {
  id: string
  title: string
  state: 'waiting' | 'running' | 'landed' | 'failed' | 'stopped'
  // The landed commit or why it failed, or null.
  note: string | null
  // The background session's name, or null before it starts.
  session: string | null
  // What its session has cost so far in dollars, or null before it starts.
  usd: number | null
}

// A plan the /workflow:plan skill started, newest first in Repo.
export type PlanView = {
  id: string
  goal: string
  state: 'running' | 'done' | 'failed' | 'stopped'
  tasks: PlanTaskView[]
}

// What this session knows about its repo. Other plugins (the drboom pane)
// read it, so a change here is a change to their contract too.
export type Repo = {
  root: string
  // The branch work lands on, or null when origin has no HEAD.
  target: string | null
  branch: string | null
  // Files this session changed, relative to root.
  files: string[]
  peers: Peer[]
  // Newest first.
  paused: Pause[]
  // Files the target changed since this checkout left it that this session also changed.
  upstream: string[]
  // The first of this session's 100 ports, or null when it has no slot.
  ports: number | null
  // What setting up the worktree came to, or null when there was nothing to do.
  setup: string | null
  // How many machine-wide check slots were busy, out of how many, at the last look.
  checks: { busy: number; slots: number } | null
  // Null until health.sh is done.
  health: Health | null
  // The repo's newest plans, newest first.
  plans: PlanView[]
  // This session's own progress.
  progress: Progress | null
  // Whether this session keeps the computer from sleeping.
  isAwake: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'workflow': {
      repo: Repo | null
      // The budget /budget set on this session, in dollars, kept across reloads.
      budget: number | null
    }
  }
}
