import type { EngineInterface, Register } from 'claude-code'

import type { Pause } from '../types'

// Lets several Claude Code sessions work in one repo at once, ported from
// Overlord and cut down to three hooks with no timers, no server and no fetch.
//
// Coordination. Each session writes what it is changing to
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
// Ports. Each Claude Code process claims a slot (scripts/slot.sh), and every
// Bash command it runs gets WORKFLOW_PORT_BASE, the first of 100 ports no
// other session uses, so dev servers in parallel sessions never collide.
//
// Setup. A worktree with no node_modules gets a copy-on-write clone of the
// main checkout's when the lockfiles match (scripts/clone.sh). Claude Code
// itself copies the files .worktreeinclude names.
//
// Checks. A Bash command that looks like a check (tests, lint, a build, a push
// or a landing) waits its turn at a few machine-wide slots (scripts/turn.sh),
// so a dozen sessions testing at once do not slow every one of them to a
// crawl. The hook waits before the command runs and frees the slot after, so
// the command itself is never changed and permission rules see it as written.
//
// A session counts while its Claude Code process runs. Every hook lets its
// call through when it throws, so a broken check never stops work. What it
// knows also goes in $.state under workflow.repo for the drboom pane.

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
// Slot n gets ports PORT_BASE + n * PORT_STEP and up.
const PORT_BASE = 40_000
const PORT_STEP = 100

// Commands that run a repo's checks, matched where a command starts.
const CHECK =
  /(?:^|[\s;&|(/])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|test|lint|typecheck|build|land)|npx\s+(?:tsc|vitest|jest|eslint|playwright)|(?:make|just)\s+(?:check|test|lint|build|land)|cargo\s+(?:test|build|clippy|check)|go\s+(?:test|build|vet)|git\s+push|pytest|tox|tsc|vitest|jest|eslint|mypy|pyright|land)(?=$|[\s;&|)])/

// A check waits at most this long for a slot, in seconds, then runs anyway.
const TURN_S = 10 * 60

const MAX_FILES = 8
const MAX_PEERS = 8
const MAX_TOPIC = 80
const MAX_PAUSES = 5

const repo = { plugin: 'workflow', key: 'repo' } as const

// The Claude Code process and its port slot, found once. A slot belongs to
// the process, so /clear keeps it, and slot.sh takes it back once the process exits.
let pidding: Promise<number | null> | undefined
let slotting: Promise<number | null> | undefined

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
// How many check slots were busy, out of how many, when the session last looked.
let checks: { busy: number; slots: number } | null = null
// The set of peers the session was last told about, or null before the first prompt.
let told: string | null = null
// What setting up the worktree came to, for the pane and the first prompt.
let setup: string | null = null
let toldSetup = false
let toldPorts = false
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
  checks = null
  told = null
  setup = null
  toldSetup = false
  toldPorts = false
  paused = new Set()
  pauses = []
  noticed = new Set()
}

// A command's output, or null when it fails. Git never stops to ask for a password.
async function run($: EngineInterface, cwd: string, argv: readonly string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
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

// The Claude Code process, the parent of every command $.process.run starts.
function ownPid($: EngineInterface): Promise<number | null> {
  pidding ??= run($, '/', ['sh', '-c', 'echo $PPID']).then(out => (out === null || out === '' ? null : Number(out)))
  return pidding
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

// Claims a port slot and hands its ports to every Bash command from here on.
// Where workflow keeps what all sessions on this machine share, or null without a home.
async function shared($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return home === '/.claude' ? null : `${home}/workflow`
}

async function claim($: EngineInterface): Promise<number | null> {
  const pid = await ownPid($)
  const dir = await shared($)
  if (pid === null || dir === null) {
    return null
  }
  const out = await run($, '/', ['sh', `${$.plugin.root}/scripts/slot.sh`, `${dir}/slots`, String(pid)])
  const slot = out === null || out === '' ? NaN : Number(out)
  if (!Number.isInteger(slot)) {
    return null
  }
  await $.env.set('WORKFLOW_SLOT', String(slot))
  await $.env.set('WORKFLOW_PORT_BASE', String(PORT_BASE + slot * PORT_STEP))
  return slot
}

// The process's port slot, claimed once. Null when slot.sh could not claim one.
function slotted($: EngineInterface): Promise<number | null> {
  slotting ??= claim($)
  return slotting
}

// Clones the main checkout's node_modules into a worktree that has none.
async function setUp($: EngineInterface, place: Place): Promise<void> {
  if (place.isMain || !place.common.endsWith('/.git')) {
    return
  }
  const main = place.common.slice(0, -'/.git'.length)
  try {
    const ran = await $.process.run(['sh', `${$.plugin.root}/scripts/clone.sh`, main, place.root], { timeoutMs: 5 * 60_000 })
    const said = ran.stdout.trim()
    if (ran.exitCode !== 0) {
      setup = `Copying node_modules from the main checkout failed: ${ran.stderr.trim().split('\n')[0] ?? ''}. Install packages before you build or test.`
    } else if (said === 'cloned') {
      setup = 'Copied node_modules from the main checkout, since the lockfiles match, so packages are already installed.'
    } else if (said === 'differs') {
      setup = 'This worktree has no node_modules and its lockfile differs from the main checkout\'s, so install packages before you build or test.'
    }
  } catch (error) {
    setup = `Copying node_modules from the main checkout failed: ${String(error)}. Install packages before you build or test.`
  }
}

async function locate($: EngineInterface): Promise<Place | null> {
  id = await $.session.id()
  const cwd = await $.session.cwd()
  const [root, common] = lines(await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']))
  if (root === undefined || common === undefined) {
    return null
  }
  const head = await run($, root, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const place = {
    root,
    common,
    target: head === null ? null : head.replace(/^origin\//, ''),
    isMain: common === `${root}/.git`,
  }
  await setUp($, place)
  return place
}

// The session's place, found and set up once. Null outside git.
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
  const dir = await shared($)
  const count = dir === null ? null : await run($, '/', ['sh', `${$.plugin.root}/scripts/turn.sh`, `${dir}/checks`, 'count'])
  const [busy, slots] = (count ?? '').split(' ').map(Number)
  checks = busy === undefined || slots === undefined || Number.isNaN(busy) || Number.isNaN(slots) ? null : { busy, slots }
}

// A check slot this session holds, and how long it waited for it.
interface Turn {
  readonly waited: number
  // Frees the slot by ending the process that holds it.
  readonly give: () => Promise<void>
}

// Waits for a check slot. A turn.sh process holds it until the loop that
// reads it ends, which kills it, and it ends by itself if Claude Code exits,
// so no slot outlives its check. Null when there is no slot to be had within
// TURN_S, and the check runs anyway.
async function takeTurn($: EngineInterface): Promise<Turn | null> {
  const dir = await shared($)
  const pid = await ownPid($)
  if (dir === null || pid === null) {
    return null
  }
  const turn = `${$.plugin.root}/scripts/turn.sh`
  const [busy, slots] = ((await run($, '/', ['sh', turn, `${dir}/checks`, 'count'])) ?? '').split(' ').map(Number)
  const isFull = busy !== undefined && slots !== undefined && busy >= slots
  if (isFull) {
    await $.ui.status('workflow: waiting for a check slot')
  }
  const pieces = $.process.spawn({ argv: ['sh', turn, `${dir}/checks`, 'hold', String(pid), String(TURN_S)] })[Symbol.asyncIterator]()
  const give = async (): Promise<void> => {
    await pieces.return?.({ code: null, signal: 'SIGTERM' })
  }
  try {
    let said = ''
    while (!said.includes('\n')) {
      const piece = await pieces.next()
      if (piece.done === true || !('text' in piece.value)) {
        return null
      }
      if (piece.value.stream === 'stdout') {
        said += piece.value.text
      }
    }
    const waited = Number(said.trim())
    if (Number.isNaN(waited)) {
      await give()
      return null
    }
    return { waited, give }
  } catch (error) {
    await give()
    throw error
  } finally {
    if (isFull) {
      await $.ui.status(undefined)
    }
  }
}

function myFiles(): string[] {
  return [...new Set([...gitFiles, ...edited])].sort()
}

async function save($: EngineInterface, place: Place): Promise<void> {
  const entry: Entry = { id, pid: await ownPid($), root: place.root, branch, topic, files: myFiles(), seen: await $.clock.now() }
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
  // Without kill every entry falls back to its age, and none is removed.
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
  const slot = await slotted($)
  await $.state.set(repo, {
    root: place.root,
    target: place.target,
    branch,
    files,
    peers: others.map(peer => ({ topic: peer.topic, where: whereOf(peer, place), files: [...peer.files] })),
    paused: pauses,
    upstream: upstream.filter(file => mine.has(file)),
    checks,
    ports: slot === null ? null : PORT_BASE + slot * PORT_STEP,
    setup,
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

// This session's ports, the first time only.
async function portNote($: EngineInterface): Promise<string | null> {
  const slot = await slotted($)
  if (slot === null || toldPorts) {
    return null
  }
  toldPorts = true
  const base = PORT_BASE + slot * PORT_STEP
  return `workflow: this session's ports are ${base} to ${base + PORT_STEP - 1}, and $WORKFLOW_PORT_BASE holds ${base}. Start dev servers and anything else that listens on a port there, so sessions running side by side never collide.`
}

// What setting up the worktree came to, the first time only.
function setupNote(): string | null {
  if (setup === null || toldSetup) {
    return null
  }
  toldSetup = true
  return `workflow: ${setup}`
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
    // A session that never looked has nothing to remove and nothing to set up.
    const place = placing === undefined ? null : await placing
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
    if (e.isMeta === true) {
      return next(e)
    }
    const notes = [await portNote($)]
    const place = await ready($)
    if (place !== null) {
      topic ??= topicOf(e.text)
      await look($, place)
      await save($, place)
      notes.push(setupNote(), await peerNote($, place), landingNote(place))
    }
    const given = notes.filter((note): note is string => note !== null)
    return given.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...given] })
  }).catch(($, e, next) => next(e))

  // Pauses an edit to a file another session is changing and remembers the
  // edits that went through. After a Bash call, which is how commits, rebases
  // and landings happen, it looks at git again and passes on a landing, since
  // a background session seldom gets a second prompt.
  on('tool.call', async ($, e, next) => {
    const file = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    if (e.tool === 'Bash') {
      // The ports, for a session that started before the plugin loaded.
      await slotted($)
    }
    const place = file === null && e.tool !== 'Bash' ? null : await ready($)
    const relative = place === null || file === null ? null : relativeTo(place.root, file)
    if (place !== null && relative !== null) {
      const warning = await pause($, place, relative)
      if (warning !== null) {
        return { deny: warning }
      }
    }
    // A background command returns as soon as it starts, so a slot would not cover it.
    const turn = e.tool === 'Bash' && e.run_in_background !== true && CHECK.test(e.command) ? await takeTurn($) : null
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      await turn?.give()
    }
    const waitNote =
      turn === null || turn.waited === 0 ? null : `workflow: this command waited ${turn.waited}s for a check slot, since other sessions' checks held all of them.`
    if (ran.deny !== undefined) {
      return ran
    }
    if (place === null) {
      return waitNote === null ? ran : { ...ran, context: [...(ran.context ?? []), waitNote] }
    }
    if (relative !== null) {
      edited.add(relative)
    } else {
      await look($, place)
    }
    await save($, place)
    const notes = [waitNote, landingNote(place)].filter((note): note is string => note !== null)
    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))
}
