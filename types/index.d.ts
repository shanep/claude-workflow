// Another session in the repo, as the pane lists it.
export type Peer = {
  topic: string | null
  // "in this same checkout", "on branch x" or a folder.
  where: string
  files: string[]
}

// An edit that was paused because another session is changing the file.
export type Pause = { file: string; at: number }

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
}

declare module 'claude-code' {
  interface PluginState {
    'workflow': { repo: Repo | null }
  }
}
