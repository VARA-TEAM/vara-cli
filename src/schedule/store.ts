import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { scheduleLogsDir, schedulesFile } from '../config/paths.js'
import { scrubSystem } from '../security/redact.js'
import { nextRun, parseSpec } from './spec.js'

/**
 * Scheduled jobs live in one small JSON file in VARA_HOME, written only by the local `vara schedule` command
 * (there is no web route and no agent tool for it: only the person at this machine can add or run a job).
 */

export interface Job {
  id: string
  name: string
  /** Spec text, re-parsed on load (the source of truth is the text the owner typed). */
  spec: string
  prompt: string
  cwd: string
  /** plan = read-only (default); build = may change files and run commands, never publish. */
  mode: 'plan' | 'build'
  paused: boolean
  createdAt: string
  nextAt: string
  lastStartedAt?: string
  lastFinishedAt?: string
  lastStatus?: 'ok' | 'failed' | 'skipped'
  lastNote?: string
  /** Set while a run is in progress; a mark older than the run limit is treated as stale. */
  runningSince?: string
}

function read(): Job[] {
  try {
    return existsSync(schedulesFile) ? (JSON.parse(readFileSync(schedulesFile, 'utf8')) as { jobs: Job[] }).jobs ?? [] : []
  } catch {
    return []
  }
}

function write(jobs: Job[]): void {
  mkdirSync(dirname(schedulesFile), { recursive: true })
  const tmp = `${schedulesFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, schedulesFile)
}

export const listJobs = (): Job[] => read()
export const getJob = (idOrName: string): Job | undefined => read().find((j) => j.id === idOrName || j.name === idOrName)

export interface NewJob {
  spec: string
  prompt: string
  cwd: string
  name?: string
  mode?: 'plan' | 'build'
}

export function addJob(input: NewJob, limits: { maxJobs: number; minIntervalMinutes: number }, now = new Date()): Job {
  const jobs = read()
  if (jobs.length >= limits.maxJobs) throw new Error(`At most ${limits.maxJobs} jobs (schedule.maxJobs). Remove one first.`)
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('A job needs a prompt.')
  if (prompt.length > 4000) throw new Error('The prompt is limited to 4000 characters.')
  if (scrubSystem(prompt) !== prompt) throw new Error('The prompt contains something that looks like a secret. Store it with `vara secret set` instead and describe where to find it.')
  const cwd = resolve(input.cwd)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Folder not found: ${cwd}`)
  const spec = parseSpec(input.spec, limits.minIntervalMinutes)
  const id = randomUUID().slice(0, 8)
  const name = (input.name ?? id).trim().slice(0, 40) || id
  if (jobs.some((j) => j.name === name)) throw new Error(`A job named "${name}" exists.`)
  const next = nextRun(spec, now)!
  const job: Job = { id, name, spec: spec.text, prompt, cwd, mode: input.mode ?? 'plan', paused: false, createdAt: now.toISOString(), nextAt: next.toISOString() }
  write([...jobs, job])
  return job
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const jobs = read()
  const i = jobs.findIndex((j) => j.id === id)
  if (i < 0) return undefined
  jobs[i] = { ...jobs[i]!, ...patch }
  write(jobs)
  return jobs[i]
}

export function removeJob(idOrName: string): boolean {
  const jobs = read()
  const keep = jobs.filter((j) => j.id !== idOrName && j.name !== idOrName)
  if (keep.length === jobs.length) return false
  write(keep)
  return true
}

/** Jobs whose time has come. One run per job per tick, however many ticks were missed (no catch-up burst). */
export function dueJobs(now: Date, maxRunMinutes: number): Job[] {
  return read().filter((j) => {
    if (j.paused || new Date(j.nextAt).getTime() > now.getTime()) return false
    if (j.runningSince && now.getTime() - new Date(j.runningSince).getTime() < (maxRunMinutes + 5) * 60_000) return false
    return true
  })
}

const LOG_CAP = 200_000

export function logFile(id: string): string {
  return join(scheduleLogsDir, `${id}.log`)
}

/** Append to a job's log (scrubbed). When it grows past the cap only its newest half is kept. */
export function appendLog(id: string, text: string): void {
  mkdirSync(scheduleLogsDir, { recursive: true })
  const file = logFile(id)
  appendFileSync(file, scrubSystem(text), 'utf8')
  try {
    if (statSync(file).size > LOG_CAP) writeFileSync(file, readFileSync(file, 'utf8').slice(-LOG_CAP / 2), 'utf8')
  } catch {
    /* the log is a convenience, never a failure */
  }
}

export function readLog(id: string, tail = 6000): string {
  try {
    return readFileSync(logFile(id), 'utf8').slice(-tail)
  } catch {
    return ''
  }
}

/** Where a job should run next after it started at `from`. */
export function nextAfter(job: Job, from: Date): Date {
  return nextRun(parseSpec(job.spec, 1), from) ?? new Date(from.getTime() + 86_400_000)
}
