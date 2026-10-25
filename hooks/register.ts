import type { EngineInterface, Register } from 'claude-code'

import type { Pause } from '../types'

// Keeps sessions in one repo from stepping on each other, ported from
// Overlord's coordinator and cut down to three hooks with no timers, no
// server and no fetch. Each session writes what it is changing to
// <git common dir>/workflow/sessions/<session id>.json, which every worktree
// of the repo shares, and reads the others' files from there:
//
// - The first prompt, and any prompt after the set of sessions changed, tells
//   the session who else works in the repo and what they are changing.
// - The first edit to a file another session is changing is paused with the
//   reason, so the model can steer clear or make the edit again.
// - New commits on origin's default branch that touch files this session
//   changed are passed on with the next prompt or Bash result, so it rebases
//   while the conflict is still small. Worktrees share their remote refs, so
//   a session that lands or fetches updates what every other one sees.
//
// A peer counts while its Claude Code process runs, which Claude Code's own
// sessions/<pid>.json files say. Every hook lets its call through when it
// throws, so a broken check never stops work. What it knows also goes in
// $.state under workflow.repo for the drboom pane.

// Where this session works.
interface Place {
  // The top of this checkout, the main one or a worktree.
  readonly root: string
  // The repo's git dir, shared by all its worktrees.
  readonly common: string
  // The branch work lands on, such as "master", or null when origin has no HEAD.
  readonly target: string | null
  // True in the main checkout, where every session shares the working tree.
  readonly isMain: boolean
  // This session's Claude Code process, or null when the registry has no entry for it.
  readonly pid: number | null
}

// What one session tells the others.
interface Entry {
  readonly id: string
  readonly pid: number | null
  readonly root: string
  readonly branch: string | null
  readonly topic: string | null
  // Changed files, relative to root.
  readonly files: readonly string[]
  readonly seen: number
}

// Git runs at most this often, since a prompt or Bash call can come every second.
const LOOK_MS = 30_000
// An entry with no pid counts this long after it was last written.
const NO_PID_MS = 30 * 60_000

const MAX_FILES = 8
const MAX_PEERS = 8
const MAX_TOPIC = 80
const MAX_PAUSES = 5

const repo = { plugin: 'workflow', key: 'repo' } as const

// Everything below belongs to one session. session.end clears it, since /clear
// starts a new session in the same process.
let placing: Promise<Place | null> | undefined
let id = ''
let topic: string | null = null
let branch: string | null = null
// Files this session edited, relative to root.
let edited = new Set<string>()
// Files a worktree's branch changed since it left the default branch.
let gitFiles: string[] = []
// Files the default branch changed since this checkout left it.
let upstream: string[] = []
let lookedAt = 0
// The set of peers the session was last told about, or null before the first prompt.
let told: string | null = null
// Each file and set of peers already paused once.
let paused = new Set<string>()
// The last few pauses, newest first, for the pane.
let pauses: Pause[] = []
// Upstream files the session already heard about.
let noticed = new Set<string>()

function forget(): void {
  placing = undefined
  id = ''
  topic = null
  branch = null
  edited = new Set()
  gitFiles = []
  upstream = []
  lookedAt = 0
  told = null
  paused = new Set()
  pauses = []
  noticed = new Set()
}

// A command's output, or null when it fails. Git never stops to ask for a password.
async function run($: EngineInterface, cwd: string, argv: readonly string[]): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs: 10_000, env: { GIT_TERMINAL_PROMPT: '0' } })
    return ran.exitCode === 0 ? ran.stdout.trim() : null
  } catch {
    return null
  }
}

function lines(text: string | null): string[] {
  return text === null ? [] : text.split('\n').filter(line => line !== '')
}

function sessionsDir(place: Place): string {
  return `${place.common}/workflow/sessions`
}

// This session's pid from Claude Code's registry of running sessions.
async function ownPid($: EngineInterface, cwd: string): Promise<number | null> {
  const home = await run($, cwd, ['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'])
  const registry = `${home ?? ''}/sessions`
  if (home === null || !(await $.fs.exists(registry))) {
    return null
  }
  for (const file of await $.fs.list(registry)) {
    if (file.kind !== 'file' || !file.name.endsWith('.json')) {
      continue
    }
    try {
      const item = JSON.parse(await $.fs.read(`${registry}/${file.name}`)) as { sessionId?: unknown; pid?: unknown }
      if (item.sessionId === id && typeof item.pid === 'number') {
        return item.pid
      }
    } catch {
      // Caught halfway through a write.
    }
  }
  return null
}

// The pids that still run, or null when the check did not run. kill -0 asks
// one pid at a time, since ps -p prints nothing on macOS when any pid is out of range.
async function alive($: EngineInterface, cwd: string, pids: readonly number[]): Promise<Set<number> | null> {
  if (pids.length === 0) {
    return new Set()
  }
  const script = 'for p in "$@"; do kill -0 "$p" 2>/dev/null && echo "$p"; done; echo done'
  const out = await run($, cwd, ['sh', '-c', script, 'sh', ...pids.map(String)])
  const said = lines(out)
  return said.at(-1) === 'done' ? new Set(said.slice(0, -1).map(Number)) : null
}

async function locate($: EngineInterface): Promise<Place | null> {
  id = await $.session.id()
  const cwd = await $.session.cwd()
  const [root, common] = lines(await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']))
  if (root === undefined || common === undefined) {
    return null
  }
  const head = await run($, root, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return {
    root,
    common,
    target: head === null ? null : head.replace(/^origin\//, ''),
    isMain: common === `${root}/.git`,
    pid: await ownPid($, root),
  }
}

// The session's place, found once. Null outside git.
function ready($: EngineInterface): Promise<Place | null> {
  placing ??= locate($)
  return placing
}

// Reads what git says this checkout changed and what landed upstream, at most every LOOK_MS.
async function look($: EngineInterface, place: Place): Promise<void> {
  const now = await $.clock.now()
  if (now - lookedAt < LOOK_MS) {
    return
  }
  lookedAt = now
  branch = await run($, place.root, ['git', 'branch', '--show-current'])
  const base = place.target === null ? null : await run($, place.root, ['git', 'merge-base', 'HEAD', `origin/${place.target}`])
  // The main checkout's changes belong to whichever session made them, so only its own edits count there.
  if (!place.isMain && base !== null) {
    gitFiles = [
      ...lines(await run($, place.root, ['git', 'diff', '--name-only', base])),
      ...lines(await run($, place.root, ['git', 'ls-files', '--others', '--exclude-standard'])),
    ]
  }
  upstream = base === null ? [] : lines(await run($, place.root, ['git', 'diff', '--name-only', base, `origin/${place.target}`]))
}

function myFiles(): string[] {
  return [...new Set([...gitFiles, ...edited])].sort()
}

async function save($: EngineInterface, place: Place): Promise<void> {
  const entry: Entry = { id, pid: place.pid, root: place.root, branch, topic, files: myFiles(), seen: await $.clock.now() }
  await $.fs.write(`${sessionsDir(place)}/${id}.json`, JSON.stringify(entry))
  await publish($, place)
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const item = value as Partial<Entry>
  return typeof item.id === 'string' && typeof item.root === 'string' && typeof item.seen === 'number' && Array.isArray(item.files)
}

// The other sessions in the repo whose process still runs. Files left by
// sessions that ended without saying so are removed here.
async function peers($: EngineInterface, place: Place): Promise<Entry[]> {
  const dir = sessionsDir(place)
  if (!(await $.fs.exists(dir))) {
    return []
  }
  const entries: Entry[] = []
  for (const file of await $.fs.list(dir)) {
    if (file.kind !== 'file' || !file.name.endsWith('.json') || file.name === `${id}.json`) {
      continue
    }
    try {
      const entry: unknown = JSON.parse(await $.fs.read(`${dir}/${file.name}`))
      if (isEntry(entry)) {
        entries.push(entry)
      }
    } catch {
      // Caught halfway through a write, so it shows next time.
    }
  }
  const now = await $.clock.now()
  const live = await alive($, place.root, entries.flatMap(entry => (entry.pid === null ? [] : [entry.pid])))
  // Without ps every entry falls back to its age, and none is removed.
  const found = entries.filter(entry => (entry.pid === null || live === null ? now - entry.seen < NO_PID_MS : live.has(entry.pid)))
  const gone = entries.filter(entry => !found.includes(entry)).map(entry => `${entry.id}.json`)
  if (live !== null && gone.length > 0) {
    await run($, dir, ['rm', '-f', ...gone])
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

// Puts what this session knows where the pane reads it.
async function publish($: EngineInterface, place: Place): Promise<void> {
  const files = myFiles()
  const mine = new Set(files)
  const others = await peers($, place)
  await $.state.set(repo, {
    root: place.root,
    target: place.target,
    branch,
    files,
    peers: others.map(peer => ({ topic: peer.topic, where: whereOf(peer, place), files: [...peer.files] })),
    paused: pauses,
    upstream: upstream.filter(file => mine.has(file)),
  })
}

// The first line of a prompt, cut to fit a list item.
function topicOf(text: string): string | null {
  const line = text.trim().split('\n', 1)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (line === '') {
    return null
  }
  return line.length > MAX_TOPIC ? `${line.slice(0, MAX_TOPIC - 3).trimEnd()}...` : line
}

// Files as "a, b and 3 more".
function fileList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_FILES).join(', ')
  const rest = files.length - MAX_FILES
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

function whereOf(peer: Entry, place: Place): string {
  return peer.root === place.root ? 'in this same checkout' : peer.branch === null ? `in ${peer.root}` : `on branch ${peer.branch}`
}

function describe(peer: Entry, place: Place, files: readonly string[] = peer.files): string {
  const who = peer.topic === null ? 'A session' : `"${peer.topic}"`
  const changes = files.length === 0 ? 'no changes yet' : `changing ${fileList(files)}`
  return `- ${who} ${whereOf(peer, place)}, ${changes}`
}

// Who else works in the repo, when that changed since the session last heard.
async function peerNote($: EngineInterface, place: Place): Promise<string | null> {
  const others = await peers($, place)
  const print = others.map(peer => `${peer.id}\u0001${peer.topic ?? ''}`).join('\u0000')
  const before = told
  told = print
  if (others.length === 0 || before === print) {
    return null
  }
  const listed = others.slice(0, MAX_PEERS).map(peer => describe(peer, place))
  if (others.length > MAX_PEERS) {
    listed.push(`- and ${others.length - MAX_PEERS} more`)
  }
  return [
    'workflow: other Claude Code sessions are working in this repository right now, and their changes have not landed on the default branch yet. If you change the same files, you overwrite each other in a shared checkout, or whoever lands second hits a merge conflict.',
    ...listed,
    'Stay out of the files they are changing when your task allows it, and keep any change to them small. Your first edit to a file another session is changing gets paused.',
  ].join('\n')
}

// New commits on the default branch that touch files this session changed, the first time only.
function landingNote(place: Place): string | null {
  if (place.target === null) {
    return null
  }
  const mine = new Set(myFiles())
  const fresh = upstream.filter(file => mine.has(file) && !noticed.has(file))
  if (fresh.length === 0) {
    return null
  }
  for (const file of fresh) {
    noticed.add(file)
  }
  return [
    `workflow: new commits landed on ${place.target} that change files you have also changed here: ${fileList(fresh)}.`,
    `Rebase onto it soon so the conflict stays small: commit your work in progress, run git fetch origin ${place.target} && git rebase origin/${place.target}, then check that your changes still fit the new code.`,
  ].join('\n')
}

function relativeTo(root: string, file: string): string | null {
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null
}

// Why an edit to a file another session is changing was paused, or null to let it through.
async function pause($: EngineInterface, place: Place, relative: string): Promise<string | null> {
  const others = (await peers($, place)).filter(peer => peer.files.includes(relative))
  if (others.length === 0) {
    return null
  }
  const key = [relative, ...others.map(peer => peer.id)].join('\u0000')
  if (paused.has(key)) {
    return null
  }
  paused.add(key)
  pauses = [{ file: relative, at: await $.clock.now() }, ...pauses].slice(0, MAX_PAUSES)
  await publish($, place)
  return [
    `workflow paused this edit once. Another session in this repository is also changing ${relative} and has not landed it yet:`,
    ...others.map(peer => describe(peer, place, [relative])),
    `If your task needs this change, make the same edit again and it will go through. Otherwise leave ${relative} to the other session.`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.end', async ($, e, next) => {
    const place = await ready($)
    if (place !== null) {
      await run($, place.root, ['rm', '-f', `${sessionsDir(place)}/${id}.json`])
    }
    forget()
    return next(e)
  }).catch(($, e, next) => {
    forget()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const place = e.isMeta === true ? null : await ready($)
    if (place === null) {
      return next(e)
    }
    topic ??= topicOf(e.text)
    await look($, place)
    await save($, place)
    const notes = [await peerNote($, place), landingNote(place)].filter((note): note is string => note !== null)
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e))

  // Pauses an edit to a file another session is changing and remembers the
  // edits that went through. After a Bash call, which is how commits, rebases
  // and landings happen, it looks at git again and passes on a landing, since
  // a background session seldom gets a second prompt.
  on('tool.call', async ($, e, next) => {
    const file = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    const place = file === null && e.tool !== 'Bash' ? null : await ready($)
    const relative = place === null || file === null ? null : relativeTo(place.root, file)
    if (place !== null && relative !== null) {
      const warning = await pause($, place, relative)
      if (warning !== null) {
        return { deny: warning }
      }
    }
    const ran = await next(e)
    if (place === null || ran.deny !== undefined) {
      return ran
    }
    if (relative !== null) {
      edited.add(relative)
    } else {
      await look($, place)
    }
    await save($, place)
    const note = landingNote(place)
    return note === null ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
