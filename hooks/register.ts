import type { EngineInterface, Register } from 'claude-code'

import type { AuditEntry, Connectors, Health, Pause, PlanTaskView, PlanView, Progress } from '../types'

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
// Progress. Each session works out what it has cost, how far through its own
// task list it is (from its TaskCreate, TaskUpdate and TodoWrite calls) and a
// rough guess at what is left, and shares it with the others. /budget sets a
// spending budget, and a plan can set one for each task. A session that goes
// past its budget says so once, to the person and to the model.
//
// Keep awake. Once a session gets its first prompt, scripts/awake.sh keeps the
// computer from sleeping until its Claude Code process exits, so long work and
// plans finish overnight. The display still turns off. WORKFLOW_KEEP_AWAKE=0
// turns it off.
//
// Audit. Every call auto mode's classifier let through or refused goes in
// ~/.claude/workflow/audit/<session id>.json, so you can look back at what ran
// without you. /audit lists them. See the Audit section below.
//
// Plans. /workflow:plan splits a goal into tasks, and each task runs as a
// background session in its own worktree once the tasks it depends on have
// landed. See the Plans section below.
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
  // This checkout's own git dir, where scripts/health.sh leaves what it found.
  readonly gitDir: string
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
  // Missing from sessions running a workflow from before 0.7.0.
  readonly progress?: Progress | null
}

// One task of a session's own task list.
interface TaskItem {
  readonly subject: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

// Git runs at most this often, since a prompt or Bash call can come every second.
const LOOK_MS = 30_000
// connectors.sh refreshes its list at most this often.
const CONNECTORS_MS = 10 * 60_000
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
const budgetRef = { plugin: 'workflow', key: 'budget' } as const

// The tools a session keeps its own task list with.
const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

// The Claude Code process and its port slot, found once. A slot belongs to
// the process, so /clear keeps it, and slot.sh takes it back once the process exits.
let pidding: Promise<number | null> | undefined
let slotting: Promise<number | null> | undefined
// Whether awake.sh holds the computer awake for the process, asked once.
let awaking: Promise<boolean> | undefined

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
// What scripts/health.sh found when the session started, once it is done.
let health: Health | null = null
// What connectors.sh last found, and whether the session heard about it.
let connectors: Connectors | null = null
let toldConnectors = false
// The set of peers the session was last told about, or null before the first prompt.
let told: string | null = null
// What setting up the worktree came to, for the pane and the first prompt.
let setup: string | null = null
let toldSetup = false
let toldPorts = false
// The repo's newest plans, read when the session looks.
let plans: PlanView[] = []
// The session's task list: TaskCreate and TaskUpdate change it one task at a
// time, and TodoWrite sends the whole list, which then wins.
let tasks = new Map<string, TaskItem>()
let todos: TaskItem[] | null = null
// When the task list started and what the session had cost by then.
let listStart: { at: number; usd: number } | null = null
// When the session last called a tool, so idle time at the end does not count.
let activeAt = 0
let progress: Progress | null = null
// True once the session heard it went past its budget.
let isBudgetTold = false
// The budget its plan task sets, looked up once.
let planBudget: Promise<number | null> | undefined
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
  health = null
  connectors = null
  toldConnectors = false
  told = null
  setup = null
  toldSetup = false
  toldPorts = false
  paused = new Set()
  pauses = []
  noticed = new Set()
  plans = []
  tasks = new Map()
  todos = null
  listStart = null
  activeAt = 0
  progress = null
  isBudgetTold = false
  planBudget = undefined
  asked = new Set()
  auditing = undefined
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

// Keeps the computer awake while the process runs, unless WORKFLOW_KEEP_AWAKE is 0.
async function stayAwake($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('WORKFLOW_KEEP_AWAKE')) === '0') {
    return false
  }
  const pid = await ownPid($)
  const dir = await shared($)
  if (pid === null || dir === null) {
    return false
  }
  return (await run($, '/', ['sh', `${$.plugin.root}/scripts/awake.sh`, `${dir}/awake`, String(pid)])) === 'awake'
}

function awake($: EngineInterface): Promise<boolean> {
  awaking ??= stayAwake($)
  return awaking
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
  const [root, common, gitDir] = lines(
    await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']),
  )
  if (root === undefined || common === undefined || gitDir === undefined) {
    return null
  }
  const head = await run($, root, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const place = {
    root,
    common,
    target: head === null ? null : head.replace(/^origin\//, ''),
    isMain: common === `${root}/.git`,
    gitDir,
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
  health = await readHealth($, place)
  connectors = await readConnectors($, place)
  if (connectors === null || now - connectors.at > CONNECTORS_MS) {
    // The list takes seconds, so it runs on its own and a later look reads it.
    const script = `${$.plugin.root}/scripts/connectors.sh`
    await run($, place.root, ['sh', '-c', 'nohup sh "$0" "$1" "$2" </dev/null >/dev/null 2>&1 &', script, connectorsFile(place), place.root])
  }
  plans = await readPlans($, place)
  checks = busy === undefined || slots === undefined || Number.isNaN(busy) || Number.isNaN(slots) ? null : { busy, slots }
}

// The time health.sh ran, then its problems, each starting with "- " and
// running on over any indented lines after it.
async function readHealth($: EngineInterface, place: Place): Promise<Health | null> {
  const file = `${place.gitDir}/workflow-health`
  if (!(await $.fs.exists(file))) {
    return null
  }
  const [at, ...rest] = (await $.fs.read(file)).split('\n')
  const problems: string[] = []
  for (const line of rest) {
    if (line.startsWith('- ')) {
      problems.push(line.slice(2))
    } else if (line.trim() !== '' && problems.length > 0) {
      problems[problems.length - 1] += `\n${line}`
    }
  }
  const seconds = Number(at)
  return Number.isNaN(seconds) ? null : { at: seconds * 1000, problems }
}

function connectorsFile(place: Place): string {
  return `${place.common}/workflow/connectors.txt`
}

// Reads lines like "claude.ai Gmail: https://... - ✓ Connected". The command
// can hold " - " too, so the status is what follows the last one.
async function readConnectors($: EngineInterface, place: Place): Promise<Connectors | null> {
  const file = connectorsFile(place)
  if (!(await $.fs.exists(file))) {
    return null
  }
  const at = (await $.fs.stat(file)).mtimeMs
  let connected = 0
  const problems: string[] = []
  for (const line of (await $.fs.read(file)).split('\n')) {
    const found = /^(.+?): .* - (.+)$/.exec(line)
    if (found === null) {
      continue
    }
    const status = (found[2] ?? '').replace(/^[^A-Za-z]+/, '').trim()
    if (/^connected/i.test(status)) {
      connected += 1
    } else {
      problems.push(`${found[1] ?? ''}: ${status}`)
    }
  }
  return { at, ready: connected, problems }
}

// What is connected, once a session, with the rule for tasks that need a connector.
function connectorNote(): string | null {
  if (connectors === null || toldConnectors) {
    return null
  }
  toldConnectors = true
  const broken =
    connectors.problems.length === 0 ? '' : ` These are not working: ${connectors.problems.join('; ')}.`
  return (
    `workflow: ${connectors.ready} MCP servers and connectors are connected.${broken} ` +
    'Before a plan or a multi-step task that needs a connector, check that each one it needs works now: its tools are listed and a cheap read-only call succeeds (list_connected_browsers for Chrome). ' +
    'Background tasks and subagents use the same connectors. If one is missing or fails, stop before starting and tell the person which one and how to fix it (/mcp).'
  )
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
  await measure($, place)
  const entry: Entry = { id, pid: await ownPid($), root: place.root, branch, topic, files: myFiles(), seen: await $.clock.now(), progress }
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
    peers: others.map(peer => ({ topic: peer.topic, where: whereOf(peer, place), files: [...peer.files], progress: peer.progress ?? null })),
    paused: pauses,
    upstream: upstream.filter(file => mine.has(file)),
    checks,
    health,
    ports: slot === null ? null : PORT_BASE + slot * PORT_STEP,
    setup,
    plans,
    progress,
    isAwake: await awake($),
    audit: await auditView(),
    connectors,
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

function taskList(): TaskItem[] {
  return todos ?? [...tasks.values()]
}

// Notes a call the session made to its own task tools. Only the main loop's
// list counts, since a subagent's is its own.
async function track($: EngineInterface, tool: string, input: Readonly<Record<string, unknown>>, text: string): Promise<void> {
  const now = await $.clock.now()
  if (listStart === null || taskList().length === 0) {
    listStart = { at: now, usd: (await $.session.usage()).cost?.usd ?? 0 }
  }
  const status = (value: unknown): TaskItem['status'] | null =>
    value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
  if (tool === 'TaskCreate') {
    // TaskCreate answers "Task #3 created successfully: ...".
    const number = /^Task #(\S+) created/.exec(text)?.[1]
    if (number !== undefined && typeof input.subject === 'string') {
      tasks.set(number, { subject: input.subject, status: 'pending' })
    }
  } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const task = tasks.get(input.taskId)
    if (input.status === 'deleted') {
      tasks.delete(input.taskId)
    } else if (task !== undefined) {
      tasks.set(input.taskId, {
        subject: typeof input.subject === 'string' ? input.subject : task.subject,
        status: status(input.status) ?? task.status,
      })
    }
  } else if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    todos = (input.todos as unknown[]).flatMap(item => {
      const todo = (typeof item === 'object' && item !== null ? item : {}) as { content?: unknown; status?: unknown }
      const given = status(todo.status)
      return typeof todo.content === 'string' && given !== null ? [{ subject: todo.content, status: given }] : []
    })
  }
}

// The budget /budget set, or else the one the session's plan task sets.
async function budgetOf($: EngineInterface, place: Place | null): Promise<number | null> {
  const set = (await $.state.get(budgetRef)).value
  if (set !== undefined && set !== null) {
    return set
  }
  if (place === null) {
    return null
  }
  planBudget ??= ownTask($, place).then(async mine => {
    const plan = mine === null ? null : await readPlan($, mine.dir)
    return typeof plan?.taskBudgetUsd === 'number' ? plan.taskBudgetUsd : null
  })
  return planBudget
}

// Reads what the session has cost and works out how far it has got. A share
// of the task list done so far cost so much and took so long, so the rest
// should cost about the same per share. Tasks in progress count as half done.
async function measure($: EngineInterface, place: Place | null): Promise<void> {
  const usage = await $.session.usage()
  const usd = usage.cost?.usd ?? 0
  const items = taskList()
  const done = items.filter(item => item.status === 'completed').length
  const active = items.filter(item => item.status === 'in_progress')
  const share = items.length === 0 ? 0 : (done + active.length / 2) / items.length
  const rest = (1 - share) / share
  const left =
    listStart !== null && done > 0 && share < 1 && activeAt > listStart.at
      ? { usd: Math.max(0, usd - listStart.usd) * rest, ms: Math.round((activeAt - listStart.at) * rest) }
      : null
  progress = {
    usd,
    budget: await budgetOf($, place),
    tasks: items.length === 0 ? null : { done, total: items.length, current: active[0]?.subject ?? null },
    left,
    fiveHour: usage.rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null,
  }
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`
}

// Tells the person and the model once that the session went past its budget.
async function budgetNote($: EngineInterface, place: Place | null): Promise<string | null> {
  if (progress === null || progress.budget === null || progress.usd < progress.budget || isBudgetTold) {
    return null
  }
  isBudgetTold = true
  const spent = `${dollars(progress.usd)}, past its budget of ${dollars(progress.budget)}`
  await $.ui.notify(`This session has cost ${spent}. Claude was asked to wrap up.`, { title: 'workflow: over budget' })
  const isTask = place !== null && (await ownTask($, place)) !== null
  return `workflow: this session has cost ${spent}. Finish the step you are on, commit what works, then stop and say where you got to.${isTask ? ' If the task is not done, land nothing and end with a line FAILED over budget.' : ''}`
}

// Answers /budget: sets this session's budget, clears it with "off", or says what it is.
async function setBudget($: EngineInterface, args: string): Promise<string> {
  const said = args.trim().replace(/^\$/, '')
  if (said === '') {
    const budget = await budgetOf($, await ready($))
    await measure($, await ready($))
    const spent = `This session has cost ${dollars(progress?.usd ?? 0)}`
    return budget === null ? `${spent} and has no budget. Set one with /budget <dollars>.` : `${spent} of its ${dollars(budget)} budget.`
  }
  if (said === 'off') {
    await $.state.set(budgetRef, null)
    isBudgetTold = false
    return 'Cleared the budget.'
  }
  const budget = Number(said)
  if (!Number.isFinite(budget) || budget <= 0) {
    return 'Give the budget in dollars, like /budget 5, or /budget off to clear it.'
  }
  await $.state.set(budgetRef, budget)
  isBudgetTold = false
  return `This session's budget is ${dollars(budget)}. You and Claude hear once when it is past that.`
}

// Plans. The /workflow:plan skill drafts tasks with the person and hands them
// to the plan tool, which saves them under <git common dir>/workflow/plans/<id>/
// and starts each task whose dependencies have landed as a background session
// in its own worktree (claude --bg -w). There is no runner process: the
// session that finishes a task records how it went and starts what that
// unblocked, and any session in the repo starts what is due when it looks. A
// task starts once, since only one session gets to mkdir its marker.
//
// - plan.json holds the goal and the tasks, and is never written again.
// - <task>.started is the marker, and its session file names the session.
// - <task>.tries counts the starts, so a retried task gets a fresh worktree.
// - <task>.json is how it went: landed when the session ends with LANDED <sha>
//   and that commit is on the default branch, failed when it ends with FAILED.
// - stopped means the plan was stopped, and nothing more starts.

interface Task {
  readonly id: string
  readonly title: string
  // What the task's session is told. It sees nothing else of the plan.
  readonly prompt: string
  readonly dependsOn: readonly string[]
  readonly files: readonly string[]
}

interface Plan {
  readonly id: string
  readonly goal: string
  readonly summary: string
  readonly createdAt: number
  readonly tasks: readonly Task[]
  // The budget for each task's session in dollars. Missing before 0.7.0.
  readonly taskBudgetUsd?: number | null
}

interface Outcome {
  readonly state: 'landed' | 'failed'
  readonly sha: string | null
  readonly note: string | null
  readonly at: number
  // What the session had cost by then. Missing before 0.7.0.
  readonly usd?: number | null
}

// The session a task runs in: its background id and its name.
interface Started {
  readonly bg: string | null
  readonly name: string
}

const MAX_TASKS = 12
// The pane shows this many plans.
const MAX_PLANS = 3
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,30}$/
const PLAN_ID = /^[a-z0-9]{1,16}$/

function plansDir(place: Place): string {
  return `${place.common}/workflow/plans`
}

// The main checkout, where task sessions start their worktrees from.
function mainOf(place: Place): string {
  return place.common.endsWith('/.git') ? place.common.slice(0, -'/.git'.length) : place.root
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// The tasks the model gave, or why they do not fit.
function parseTasks(value: unknown): Task[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'tasks must be a list of at least one task.'
  }
  if (value.length > MAX_TASKS) {
    return `A plan has at most ${MAX_TASKS} tasks.`
  }
  const tasks: Task[] = []
  for (const item of value as unknown[]) {
    const task = (typeof item === 'object' && item !== null ? item : {}) as Partial<Record<keyof Task, unknown>>
    const { id, title, prompt } = task
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
      return `Task id ${JSON.stringify(id)} must be short lowercase words with hyphens.`
    }
    if (typeof title !== 'string' || title.trim() === '' || typeof prompt !== 'string' || prompt.trim() === '') {
      return `Task ${id} needs a title and a prompt.`
    }
    tasks.push({ id, title: title.trim(), prompt: prompt.trim(), dependsOn: strings(task.dependsOn), files: strings(task.files) })
  }
  return tidy(tasks)
}

// Drops duplicate ids and unknown or self dependencies, breaks any loop by
// dropping the dependency that closes it, and orders the tasks so each comes
// after the ones it depends on. Ported from Overlord.
function tidy(given: readonly Task[]): Task[] {
  const seen = new Set<string>()
  const tasks = given.filter(task => {
    const fresh = !seen.has(task.id)
    seen.add(task.id)
    return fresh
  })
  const byId = new Map(tasks.map(task => [task.id, task]))
  const ordered: Task[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (task: Task): void => {
    visiting.add(task.id)
    const dependsOn: string[] = []
    for (const dep of new Set(task.dependsOn)) {
      const dependency = byId.get(dep)
      // Unknown, itself, or a loop back to a task still being visited.
      if (dependency === undefined || visiting.has(dep)) {
        continue
      }
      if (!done.has(dep)) {
        visit(dependency)
      }
      dependsOn.push(dep)
    }
    visiting.delete(task.id)
    done.add(task.id)
    ordered.push({ ...task, dependsOn })
  }
  for (const task of tasks) {
    if (!done.has(task.id)) {
      visit(task)
    }
  }
  return ordered
}

async function readJson($: EngineInterface, file: string): Promise<unknown> {
  try {
    return (await $.fs.exists(file)) ? (JSON.parse(await $.fs.read(file)) as unknown) : null
  } catch {
    // Caught halfway through a write, so it shows next time.
    return null
  }
}

async function readPlan($: EngineInterface, dir: string): Promise<Plan | null> {
  const plan = (await readJson($, `${dir}/plan.json`)) as Partial<Plan> | null
  return plan !== null && typeof plan.id === 'string' && typeof plan.goal === 'string' && Array.isArray(plan.tasks) ? (plan as Plan) : null
}

async function readOutcome($: EngineInterface, dir: string, task: string): Promise<Outcome | null> {
  const outcome = (await readJson($, `${dir}/${task}.json`)) as Partial<Outcome> | null
  return outcome !== null && (outcome.state === 'landed' || outcome.state === 'failed') ? (outcome as Outcome) : null
}

async function readStarted($: EngineInterface, dir: string, task: string): Promise<Started | null> {
  const marker = `${dir}/${task}.started`
  if (!(await $.fs.exists(marker))) {
    return null
  }
  const file = `${marker}/session`
  const [bg, name] = (await $.fs.exists(file)) ? (await $.fs.read(file)).split('\n') : []
  return { bg: bg === undefined || bg === '' ? null : bg, name: name ?? task }
}

// What a task's session is told: its own prompt, then how to finish.
function taskPrompt(plan: Plan, task: Task, target: string): string {
  return `${task.prompt}

This is one task of a larger plan ("${plan.goal}"). Other sessions work on the other tasks at the same time in their own worktrees, so stay within this task.

When it is done and its checks pass, commit it and land it on ${target} the way your instructions say. Then end your last message with a line of its own: LANDED followed by the commit hash on ${target}. If you cannot finish, end with a line FAILED followed by one sentence on why.`
}

// Starts a task's background session, or records that it could not start.
async function launch($: EngineInterface, place: Place, dir: string, plan: Plan, task: Task): Promise<void> {
  const triesFile = `${dir}/${task.id}.tries`
  const tries = 1 + ((await $.fs.exists(triesFile)) ? Number(await $.fs.read(triesFile)) || 0 : 0)
  await $.fs.write(triesFile, String(tries))
  const name = tries === 1 ? `plan-${plan.id}-${task.id}` : `plan-${plan.id}-${task.id}-${tries}`
  const prompt = taskPrompt(plan, task, place.target ?? 'the default branch')
  let said = ''
  try {
    const ran = await $.process.run(['claude', '--bg', '-w', name, '-n', name, prompt], { cwd: mainOf(place), timeoutMs: 60_000 })
    said = `${ran.stdout}\n${ran.stderr}`.trim()
    const bg = ran.exitCode === 0 ? /backgrounded\s+\S+\s+([0-9a-f]+)/.exec(said)?.[1] : undefined
    if (bg !== undefined) {
      await $.fs.write(`${dir}/${task.id}.started/session`, `${bg}\n${name}`)
      return
    }
  } catch (error) {
    said = String(error)
  }
  const why = said.split('\n').find(line => line.trim() !== '') ?? 'no output'
  await writeOutcome($, dir, task.id, { state: 'failed', sha: null, note: `Its session did not start: ${why}`, at: await $.clock.now() })
}

async function writeOutcome($: EngineInterface, dir: string, task: string, outcome: Outcome): Promise<void> {
  await $.fs.write(`${dir}/${task}.json`, JSON.stringify(outcome))
}

// Starts every task of the plan whose dependencies have all landed and that
// has not started yet.
async function advance($: EngineInterface, place: Place, planId: string): Promise<void> {
  const dir = `${plansDir(place)}/${planId}`
  const plan = await readPlan($, dir)
  if (plan === null || (await $.fs.exists(`${dir}/stopped`))) {
    return
  }
  const outcomes = new Map<string, Outcome>()
  for (const task of plan.tasks) {
    const outcome = await readOutcome($, dir, task.id)
    if (outcome !== null) {
      outcomes.set(task.id, outcome)
    }
  }
  for (const task of plan.tasks) {
    const isDue = !outcomes.has(task.id) && task.dependsOn.every(dep => outcomes.get(dep)?.state === 'landed')
    // mkdir fails when the marker is there, so only one session starts the task.
    if (isDue && !(await $.fs.exists(`${dir}/${task.id}.started`)) && (await run($, dir, ['mkdir', `${task.id}.started`])) !== null) {
      await launch($, place, dir, plan, task)
    }
  }
}

// What each live session in the repo has cost, by session id.
async function costs($: EngineInterface, place: Place): Promise<Map<string, number>> {
  const found = new Map((await peers($, place)).flatMap(peer => (peer.progress == null ? [] : [[peer.id, peer.progress.usd] as const])))
  if (progress !== null) {
    found.set(id, progress.usd)
  }
  return found
}

// How a plan stands, for the pane and the plan tool. spent is what live
// sessions have cost, by session id.
async function viewPlan($: EngineInterface, dir: string, plan: Plan, spent: ReadonlyMap<string, number>): Promise<PlanView> {
  const isStopped = await $.fs.exists(`${dir}/stopped`)
  const views: PlanTaskView[] = []
  for (const task of plan.tasks) {
    const outcome = await readOutcome($, dir, task.id)
    const started = await readStarted($, dir, task.id)
    const state = outcome !== null ? outcome.state : isStopped ? 'stopped' : started !== null ? 'running' : 'waiting'
    const note = outcome === null ? null : outcome.state === 'landed' ? (outcome.sha?.slice(0, 7) ?? null) : outcome.note
    const bg = started?.bg ?? null
    const live = bg === null ? undefined : [...spent].find(([session]) => session.startsWith(bg))?.[1]
    views.push({ id: task.id, title: task.title, state, note, session: started?.name ?? null, usd: outcome?.usd ?? live ?? null })
  }
  const state = isStopped
    ? 'stopped'
    : views.every(task => task.state === 'landed')
      ? 'done'
      : views.some(task => task.state === 'failed') && !views.some(task => task.state === 'running')
        ? 'failed'
        : 'running'
  return { id: plan.id, goal: plan.goal, state, tasks: views }
}

// The repo's newest plans, after starting what is due in the running ones.
async function readPlans($: EngineInterface, place: Place): Promise<PlanView[]> {
  const root = plansDir(place)
  if (!(await $.fs.exists(root))) {
    return []
  }
  const ids = (await $.fs.list(root))
    .filter(entry => entry.kind === 'dir' && PLAN_ID.test(entry.name))
    .map(entry => entry.name)
    // Ids are the time they were made in base 36, so they sort by age.
    .sort((a, b) => b.length - a.length || b.localeCompare(a))
    .slice(0, MAX_PLANS)
  const spent = ids.length === 0 ? new Map<string, number>() : await costs($, place)
  const views: PlanView[] = []
  for (const planId of ids) {
    const dir = `${root}/${planId}`
    const plan = await readPlan($, dir)
    if (plan === null) {
      continue
    }
    let view = await viewPlan($, dir, plan, spent)
    if (view.state === 'running') {
      await advance($, place, planId)
      view = await viewPlan($, dir, plan, spent)
    }
    views.push(view)
  }
  return views
}

// The plan task this session runs, found by its session id or worktree name.
async function ownTask($: EngineInterface, place: Place): Promise<{ readonly dir: string; readonly task: string } | null> {
  const root = plansDir(place)
  const folder = place.root.split('/').at(-1) ?? ''
  if (place.isMain || !folder.startsWith('plan-') || !(await $.fs.exists(root))) {
    return null
  }
  for (const planDir of await $.fs.list(root)) {
    if (planDir.kind !== 'dir') {
      continue
    }
    const dir = `${root}/${planDir.name}`
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'dir' || !entry.name.endsWith('.started')) {
        continue
      }
      const task = entry.name.slice(0, -'.started'.length)
      const started = await readStarted($, dir, task)
      if (started !== null && (started.name === folder || (started.bg !== null && id.startsWith(started.bg)))) {
        return { dir, task }
      }
    }
  }
  return null
}

// Records how this session's plan task went, when its answer says, and
// starts what that unblocked.
async function finish($: EngineInterface, place: Place, answer: string): Promise<void> {
  let said: { sha: string } | { why: string } | null = null
  for (const line of answer.trim().split('\n').reverse()) {
    const landed = /^\W*LANDED\s+([0-9a-f]{7,40})\b/.exec(line)
    const failed = /^\W*FAILED\s+(.+)$/.exec(line)
    said = landed?.[1] !== undefined ? { sha: landed[1] } : failed?.[1] !== undefined ? { why: failed[1].trim() } : null
    if (said !== null) {
      break
    }
  }
  const mine = said === null ? null : await ownTask($, place)
  if (said === null || mine === null || (await readOutcome($, mine.dir, mine.task)) !== null) {
    return
  }
  const at = await $.clock.now()
  await measure($, place)
  const usd = progress?.usd ?? null
  let outcome: Outcome
  if ('why' in said) {
    outcome = { state: 'failed', sha: null, note: said.why, at, usd }
  } else if (place.target === null) {
    outcome = { state: 'failed', sha: said.sha, note: 'origin has no default branch to check the commit against.', at, usd }
  } else {
    await run($, place.root, ['git', 'fetch', '-q', 'origin', place.target], 60_000)
    const isLanded = (await run($, place.root, ['git', 'merge-base', '--is-ancestor', said.sha, `origin/${place.target}`])) !== null
    outcome = isLanded
      ? { state: 'landed', sha: said.sha, note: null, at, usd }
      : { state: 'failed', sha: said.sha, note: `It said it landed ${said.sha.slice(0, 7)}, but that commit is not on ${place.target}.`, at, usd }
  }
  await writeOutcome($, mine.dir, mine.task, outcome)
  await advance($, place, mine.dir.split('/').at(-1) ?? '')
  lookedAt = 0
  await look($, place)
  await publish($, place)
}

// What the plan tool takes, for the model.
const PLAN_TOOL = {
  name: 'plan',
  description:
    'Runs a plan of tasks as background Claude Code sessions, each in its own git worktree, starting each task once the tasks it depends on have landed. Only call it from the /workflow:plan skill, after the person approved the plan. action "start" takes goal, summary and tasks; "stop" takes plan; "retry" takes plan and task and starts that task again.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'retry'] },
      goal: { type: 'string', description: 'The goal in the person\'s words.' },
      summary: { type: 'string', description: 'One short paragraph on how the work was split.' },
      tasks: {
        type: 'array',
        maxItems: MAX_TASKS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short lowercase words with hyphens, unique in the plan.' },
            title: { type: 'string' },
            prompt: { type: 'string', description: 'Everything the task\'s session needs, since it sees nothing else.' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            files: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title', 'prompt', 'dependsOn', 'files'],
        },
      },
      taskBudgetUsd: { type: 'number', description: 'The most each task\'s session should spend, in dollars, when the person gave one.' },
      plan: { type: 'string', description: 'The plan id, for stop and retry.' },
      task: { type: 'string', description: 'The task id, for retry.' },
    },
    required: ['action'],
  },
  isDeferred: true,
} as const

function planLines(view: PlanView): string {
  return [
    `Plan ${view.id} (${view.state}): ${view.goal}`,
    ...view.tasks.map(
      task =>
        `- ${task.id}: ${task.state}${task.note === null ? '' : ` (${task.note})`}${task.session === null ? '' : `, session ${task.session}`}${task.usd === null ? '' : `, ${dollars(task.usd)}`}`,
    ),
  ].join('\n')
}

// Answers a call to the plan tool with what it did, or throws why it could not.
async function planTool($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<string> {
  const place = await ready($)
  if (place === null) {
    throw new Error('This session is not in a git repository.')
  }
  if (place.target === null) {
    throw new Error('origin has no default branch, so landings cannot be checked. Run git remote set-head origin --auto first.')
  }
  const root = plansDir(place)
  const planId = typeof input.plan === 'string' && PLAN_ID.test(input.plan) ? input.plan : null
  const dir = planId === null ? null : `${root}/${planId}`
  const plan = dir === null ? null : await readPlan($, dir)
  if (input.action === 'start') {
    const tasks = parseTasks(input.tasks)
    if (typeof tasks === 'string') {
      throw new Error(tasks)
    }
    if (typeof input.goal !== 'string' || input.goal.trim() === '') {
      throw new Error('A plan needs a goal.')
    }
    const createdAt = await $.clock.now()
    const budget = typeof input.taskBudgetUsd === 'number' && input.taskBudgetUsd > 0 ? input.taskBudgetUsd : null
    const made: Plan = {
      id: createdAt.toString(36),
      goal: input.goal.trim(),
      summary: typeof input.summary === 'string' ? input.summary : '',
      createdAt,
      tasks,
      taskBudgetUsd: budget,
    }
    await $.fs.write(`${root}/${made.id}/plan.json`, JSON.stringify(made, null, 2))
    await advance($, place, made.id)
    lookedAt = 0
    await look($, place)
    await publish($, place)
    const view = await viewPlan($, `${root}/${made.id}`, made, await costs($, place))
    return `${planLines(view)}\n\nRunning tasks land on their own, and the rest start as the tasks they depend on land. The /boom pane shows the plan.`
  }
  if (dir === null || plan === null) {
    throw new Error(`No plan ${JSON.stringify(input.plan)} in this repository.`)
  }
  if (input.action === 'stop') {
    await $.fs.write(`${dir}/stopped`, '')
    for (const task of plan.tasks) {
      const started = await readStarted($, dir, task.id)
      if (started === null || (await readOutcome($, dir, task.id)) !== null) {
        continue
      }
      if (started.bg !== null) {
        await run($, mainOf(place), ['claude', 'stop', started.bg], 30_000)
      }
      // A retry starts it again from scratch.
      await writeOutcome($, dir, task.id, { state: 'failed', sha: null, note: 'Stopped with the plan.', at: await $.clock.now() })
    }
  } else if (input.action === 'retry') {
    const task = plan.tasks.find(item => item.id === input.task)
    if (task === undefined) {
      throw new Error(`Plan ${plan.id} has no task ${JSON.stringify(input.task)}.`)
    }
    await run($, dir, ['rm', '-rf', `${task.id}.json`, `${task.id}.started`, 'stopped'])
    await advance($, place, plan.id)
  } else {
    throw new Error('action must be start, stop or retry.')
  }
  lookedAt = 0
  await look($, place)
  await publish($, place)
  return planLines(await viewPlan($, dir, plan, await costs($, place)))
}

// Audit. The permission check answers ask for a call no rule or mode settles,
// which puts it to the mode's decider. In auto mode that is the classifier, so
// an asked call that then runs is one auto mode let through. A refusal comes
// as its own event. Each session keeps its own file, so no two write the same
// one, and files older than AUDIT_DAYS are removed.

const MAX_AUDIT = 500
const AUDIT_DAYS = 30
const MAX_WHAT = 160
const PANE_AUDIT = 3

// The calls the permission check put to the mode's decider, by tool_use_id.
let asked = new Set<string>()
// This session's audit, the newest last, loaded on the first entry.
let auditing: Promise<AuditEntry[]> | undefined

// A call's command, file or URL on one short line.
function what(input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const key = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'prompt'].find(name => typeof args[name] === 'string')
  const said = key === undefined ? (JSON.stringify(input) ?? '') : String(args[key])
  const line = said.replace(/\s+/g, ' ').trim()
  return line.length > MAX_WHAT ? `${line.slice(0, MAX_WHAT - 3)}...` : line
}

async function auditDir($: EngineInterface): Promise<string | null> {
  const dir = await shared($)
  return dir === null ? null : `${dir}/audit`
}

// The audit so far, read back after a reload. Old files go first.
async function loadAudit($: EngineInterface, dir: string, file: string): Promise<AuditEntry[]> {
  await run($, '/', ['mkdir', '-p', dir])
  await run($, dir, ['find', '.', '-name', '*.json', '-mtime', `+${AUDIT_DAYS}`, '-exec', 'rm', '-f', '{}', '+'])
  const found = await readJson($, file)
  return Array.isArray(found) ? (found as AuditEntry[]) : []
}

// Adds an entry and writes the file. Entries chain, so parallel calls never
// drop one another's.
async function record($: EngineInterface, entry: AuditEntry): Promise<void> {
  const dir = await auditDir($)
  if (dir === null) {
    return
  }
  const file = `${dir}/${await $.session.id()}.json`
  auditing = (auditing ?? loadAudit($, dir, file)).then(async list => {
    const kept = [...list, entry].slice(-MAX_AUDIT)
    try {
      await $.fs.write(file, JSON.stringify(kept))
    } catch {
      // The next entry writes the whole list again.
    }
    return kept
  })
  await auditing
  const place = await ready($)
  if (place !== null) {
    await publish($, place)
  }
}

async function auditView(): Promise<{ allowed: number; denied: number; recent: AuditEntry[] } | null> {
  if (auditing === undefined) {
    return null
  }
  const list = await auditing
  const allowed = list.filter(entry => entry.decision === 'allow').length
  return { allowed, denied: list.length - allowed, recent: list.slice(-PANE_AUDIT) }
}

// How long ago, as "5m", "3h 20m" or "2d". The plugin has no time zone to print a clock time in.
function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`
}

function auditLine(entry: AuditEntry, now: number): string {
  const when = `${ago(now - entry.at)} ago`
  const verb = entry.decision === 'allow' ? 'let through' : 'refused'
  const by = entry.agent === null ? '' : ` (subagent ${entry.agent})`
  const why = entry.reason === null ? '' : `\n    ${entry.reason.split('\n')[0]}`
  return `${when} ${verb} ${entry.tool}${by}: ${entry.what}${why}`
}

// Answers /audit: this session's entries, or with "all" every session's from the last day.
async function listAudit($: EngineInterface, args: string): Promise<string> {
  const dir = await auditDir($)
  if (dir === null) {
    return 'The audit has no folder, since HOME is not set.'
  }
  const now = await $.clock.now()
  let entries: AuditEntry[]
  if (args.trim() === 'all') {
    const files = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
    const lists = await Promise.all(
      files.filter(file => file.name.endsWith('.json') && now - file.mtimeMs < 24 * 3_600_000).map(file => readJson($, `${dir}/${file.name}`)),
    )
    entries = lists.flatMap(list => (Array.isArray(list) ? (list as AuditEntry[]) : [])).filter(entry => now - entry.at < 24 * 3_600_000)
  } else {
    entries = auditing === undefined ? await loadAudit($, dir, `${dir}/${await $.session.id()}.json`) : await auditing
  }
  const shown = entries.sort((a, b) => a.at - b.at).slice(-40)
  if (shown.length === 0) {
    return args.trim() === 'all' ? 'Auto mode decided nothing in the last day.' : 'Auto mode has decided nothing in this session yet. /audit all lists the last day across sessions.'
  }
  const more = entries.length - shown.length
  return [...(more > 0 ? [`${more} older entries not shown.`] : []), ...shown.map(entry => auditLine(entry, now))].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(PLAN_TOOL)
    await $.command.register({ name: 'audit', description: 'List what auto mode let through or refused', argumentHint: '[all]' })
    await $.command.register({ name: 'budget', description: 'Set this session\'s spending budget in dollars, or clear it', argumentHint: '<dollars> | off' })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'budget' }, async ($, e) => ({ text: await setBudget($, e.args) }))
  on('command.run', { command: 'audit' }, async ($, e) => ({ text: await listAudit($, e.args) }))

  // Notes the calls the permission check put to the mode's decider. A
  // plugin's ask goes to a person instead, so it is left out.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && verdict.plugin === undefined && e.tool_use_id !== undefined) {
      // Calls that never finish would pile up otherwise.
      if (asked.size > 1000) {
        asked = new Set()
      }
      asked.add(e.tool_use_id)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // An asked call that ran in auto mode is one the classifier let through.
  on('classic.PostToolUse', async ($, e, next) => {
    if (asked.delete(e.tool_use_id) && e.permission_mode === 'auto') {
      await record($, { at: await $.clock.now(), tool: e.tool_name, what: what(e.tool_input), decision: 'allow', reason: null, agent: e.agent_id ?? null, cwd: e.cwd })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    asked.delete(e.tool_use_id)
    await record($, { at: await $.clock.now(), tool: e.tool_name, what: what(e.tool_input), decision: 'deny', reason: e.reason, agent: e.agent_id ?? null, cwd: e.cwd })
    return next(e)
  }).catch(($, e, next) => next(e))

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
    await awake($)
    const notes = [await portNote($)]
    const place = await ready($)
    if (place !== null) {
      topic ??= topicOf(e.text)
      await look($, place)
      await save($, place)
      notes.push(setupNote(), connectorNote(), await peerNote($, place), landingNote(place), await budgetNote($, place))
    }
    const given = notes.filter((note): note is string => note !== null)
    return given.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...given] })
  }).catch(($, e, next) => next(e))

  // Pauses an edit to a file another session is changing and remembers the
  // edits that went through. After a Bash call, which is how commits, rebases
  // and landings happen, it looks at git again and passes on a landing, since
  // a background session seldom gets a second prompt. It also answers the
  // plan tool, here and not under a matcher of its own, since the types only
  // name the tools the session had when the mod was last saved.
  on('tool.call', async ($, e, next) => {
    // The cast widens the known tool names to compare with the plan tool's.
    if ((e.tool as string) === `mcp__workflow__${PLAN_TOOL.name}`) {
      try {
        return { result: await planTool($, e) }
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    }
    const file = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    if (e.tool === 'Bash') {
      // The ports, for a session that started before the plugin loaded.
      await slotted($)
    }
    const place = file === null && e.tool !== 'Bash' && !TASK_TOOLS.has(e.tool) ? null : await ready($)
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
    if (e.agentId === undefined) {
      activeAt = await $.clock.now()
      if (TASK_TOOLS.has(e.tool)) {
        await track($, e.tool, e, ran.text ?? '')
      }
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
    const notes = [waitNote, landingNote(place), await budgetNote($, place)].filter((note): note is string => note !== null)
    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  // A plan task's session records how its task went when its turn ends.
  on('turn.complete', async ($, e, next) => {
    const place = e.agentId === undefined && !e.isAborted ? await ready($) : null
    if (place !== null) {
      await finish($, place, e.answer)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
