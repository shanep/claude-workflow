// Another session in the repo, as the pane lists it.
export type Peer = {
  topic: string | null
  // "in this same checkout", "on branch x" or a folder.
  where: string
  files: string[]
}

// An edit that was paused because another session is changing the file.
export type Pause = { file: string; at: number }

// What scripts/health.sh found when the session started: when it ran, in
// milliseconds, and its problems. None means the repo is healthy at head.
export type Health = { at: number; problems: string[] }

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
}

declare module 'claude-code' {
  interface PluginState {
    'workflow': { repo: Repo | null }
  }
}
