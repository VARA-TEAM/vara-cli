import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Long-running commands the agent started on purpose (a dev server, a watcher, a build in watch mode) and keeps
 * working while they run. Each gets a short id; its output is kept (the last 100 KB) so the agent can read it later
 * with the `process` tool, and `stop` ends it. Everything is killed when VARA exits. Per session: one session cannot
 * see or stop another's processes.
 */
const MAX_LOG = 100_000
const MAX_PER_SESSION = 8

export interface BackgroundProcess {
  id: string
  command: string
  startedAt: number
  child: ChildProcess
  log: string
  exitCode: number | null
  done: boolean
}

const bySession = new Map<string, Map<string, BackgroundProcess>>()
let counter = 0

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else if (child.pid) process.kill(-child.pid, 'SIGTERM') // the whole group: bash and what it started
    else child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

export function startBackground(sessionId: string, command: string, cwd: string, env: Record<string, string>): BackgroundProcess | { error: string } {
  let procs = bySession.get(sessionId)
  if (!procs) bySession.set(sessionId, (procs = new Map()))
  if ([...procs.values()].filter((p) => !p.done).length >= MAX_PER_SESSION) return { error: `Already ${MAX_PER_SESSION} background processes running in this session. Stop one first (process stop <id>).` }
  const isWin = process.platform === 'win32'
  const child = isWin
    ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn('bash', ['-lc', command], { cwd, env, detached: true })
  const p: BackgroundProcess = { id: `bg${++counter}`, command, startedAt: Date.now(), child, log: '', exitCode: null, done: false }
  const add = (d: Buffer): void => {
    p.log += d.toString('utf8')
    if (p.log.length > MAX_LOG) p.log = p.log.slice(-MAX_LOG)
  }
  child.stdout?.on('data', add)
  child.stderr?.on('data', add)
  child.on('error', (e) => {
    p.log += `\n[spawn error] ${e.message}`
    p.done = true
  })
  child.on('close', (code) => {
    p.exitCode = code
    p.done = true
  })
  procs.set(p.id, p)
  return p
}

export function listBackground(sessionId: string): BackgroundProcess[] {
  return [...(bySession.get(sessionId)?.values() ?? [])]
}

export function getBackground(sessionId: string, id: string): BackgroundProcess | undefined {
  return bySession.get(sessionId)?.get(id)
}

export function stopBackground(sessionId: string, id: string): boolean {
  const p = getBackground(sessionId, id)
  if (!p || p.done) return false
  killTree(p.child)
  return true
}

export function stopAllBackground(sessionId?: string): void {
  for (const [sid, procs] of bySession) {
    if (sessionId && sid !== sessionId) continue
    for (const p of procs.values()) if (!p.done) killTree(p.child)
  }
}

process.on('exit', () => stopAllBackground())
