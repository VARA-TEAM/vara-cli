import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider'
import { nextRun, parseSpec } from '../src/schedule/spec'
import { addJob, dueJobs, getJob, listJobs, readLog, removeJob, updateJob } from '../src/schedule/store'
import { runJob, tick } from '../src/schedule/run'

const limits = { maxJobs: 3, minIntervalMinutes: 5 }
const dir = () => mkdtempSync(join(tmpdir(), 'vara-sched-'))
const at = (s: string) => new Date(s)

class Scripted implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const turn = this.script.shift() ?? { content: 'Nothing new on the branch.', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

describe('schedule specs', () => {
  it('parses intervals and refuses ones that are too short or malformed', () => {
    expect(parseSpec('every 30m').kind).toBe('interval')
    expect(parseSpec('every 2h')).toMatchObject({ kind: 'interval', minutes: 120 })
    expect(parseSpec('every 1d')).toMatchObject({ minutes: 1440 })
    expect(() => parseSpec('every 1m')).toThrow(/shortest/)
    expect(() => parseSpec('every 0h')).toThrow()
    expect(() => parseSpec('whenever')).toThrow(/cron fields/)
    expect(() => parseSpec('61 * * * *')).toThrow(/minute/)
    expect(() => parseSpec('* 25 * * *')).toThrow(/hour/)
    expect(() => parseSpec('0 0 31 2 *')).toThrow(/never fires/)
  })

  it('computes the next cron time in local time (weekday mornings, steps, lists, Sunday as 0 or 7)', () => {
    const wk = parseSpec('0 9 * * 1-5')
    // Fri 2026-10-16 10:00 -> next is Mon 2026-10-19 09:00
    expect(nextRun(wk, new Date(2026, 9, 16, 10, 0))).toEqual(new Date(2026, 9, 19, 9, 0))
    expect(nextRun(wk, new Date(2026, 9, 19, 8, 59))).toEqual(new Date(2026, 9, 19, 9, 0))
    expect(nextRun(wk, new Date(2026, 9, 19, 9, 0))).toEqual(new Date(2026, 9, 20, 9, 0))
    expect(nextRun(parseSpec('*/15 * * * *'), new Date(2026, 9, 16, 10, 7))).toEqual(new Date(2026, 9, 16, 10, 15))
    expect(nextRun(parseSpec('30 8,20 * * *'), new Date(2026, 9, 16, 9, 0))).toEqual(new Date(2026, 9, 16, 20, 30))
    expect(nextRun(parseSpec('0 0 * * 7'), new Date(2026, 9, 16, 9, 0))!.getDay()).toBe(0)
    expect(nextRun(parseSpec('every 90m'), at('2026-10-16T10:00:00Z'))!.toISOString()).toBe('2026-10-16T11:30:00.000Z')
  })
})

describe('job store', () => {
  it('adds, lists, finds, pauses and removes; limits and bad input are refused', () => {
    const cwd = dir()
    const j = addJob({ spec: 'every 1h', prompt: 'review the branch', cwd, name: 'morning' }, limits)
    expect(j.mode).toBe('plan') // read-only unless the owner says --build
    expect(getJob('morning')?.id).toBe(j.id)
    expect(() => addJob({ spec: 'every 1h', prompt: 'x', cwd, name: 'morning' }, limits)).toThrow(/exists/)
    expect(() => addJob({ spec: 'every 1h', prompt: 'x', cwd: join(cwd, 'nope') }, limits)).toThrow(/not found/)
    expect(() => addJob({ spec: 'every 1h', prompt: 'use sk-abcdefghijklmnopqrstuvwxyz123456', cwd }, limits)).toThrow(/secret/)
    expect(() => addJob({ spec: 'every 1h', prompt: '  ', cwd }, limits)).toThrow(/prompt/)
    addJob({ spec: 'every 1h', prompt: 'b', cwd }, limits)
    addJob({ spec: 'every 1h', prompt: 'c', cwd }, limits)
    expect(() => addJob({ spec: 'every 1h', prompt: 'd', cwd }, limits)).toThrow(/At most/)
    updateJob(j.id, { paused: true })
    expect(dueJobs(new Date(Date.now() + 10 * 3_600_000), 20).some((x) => x.id === j.id)).toBe(false)
    for (const x of listJobs()) removeJob(x.id)
    expect(listJobs()).toEqual([])
  })

  it('a job is due once its time has come, never twice at once, and a stale run mark does not block it forever', () => {
    const cwd = dir()
    const j = addJob({ spec: 'every 1h', prompt: 'p', cwd }, { maxJobs: 50, minIntervalMinutes: 5 })
    const later = new Date(Date.now() + 2 * 3_600_000)
    expect(dueJobs(new Date(), 20).some((x) => x.id === j.id)).toBe(false)
    expect(dueJobs(later, 20).some((x) => x.id === j.id)).toBe(true)
    updateJob(j.id, { runningSince: later.toISOString() })
    expect(dueJobs(later, 20).some((x) => x.id === j.id)).toBe(false)
    expect(dueJobs(new Date(later.getTime() + 60 * 60_000), 20).some((x) => x.id === j.id)).toBe(true)
    removeJob(j.id)
  })
})

describe('running jobs', () => {
  const on = { ...DEFAULT_CONFIG, schedule: { ...DEFAULT_CONFIG.schedule, enabled: true } }

  it('runs the prompt headlessly in the job folder, read-only by default, and keeps a log', async () => {
    const cwd = dir()
    const j = addJob({ spec: 'every 1h', prompt: 'summarise open TODOs', cwd, name: 'todos' }, { maxJobs: 50, minIntervalMinutes: 5 })
    const provider = new Scripted([{ content: 'Two TODOs remain.', toolCalls: [] }])
    const r = await runJob(j, on, provider)
    expect(provider.requests[0]!.system).toContain(cwd)
    // read-only: no write tool is offered to a plan-mode run, and publishing is never allowed
    const offered = (provider.requests[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(offered).not.toContain('write_file')
    expect(offered).not.toContain('shell')
    expect(r.ok).toBe(true)
    expect(r.note).toMatch(/^ready/)
    expect(readLog(j.id)).toContain('Two TODOs remain.')
    const after = getJob(j.id)!
    expect(after.runningSince).toBeUndefined()
    expect(after.lastStatus).toBe(r.ok ? 'ok' : 'failed')
    expect(new Date(after.nextAt).getTime()).toBeGreaterThan(Date.now())
    removeJob(j.id)
  })

  it('a provider failure is logged and reported, and the job is released for its next time', async () => {
    const cwd = dir()
    const j = addJob({ spec: 'every 1h', prompt: 'x', cwd }, { maxJobs: 50, minIntervalMinutes: 5 })
    const boom: Provider = {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('provider down')
      },
    }
    const r = await runJob(j, on, boom)
    expect(r.ok).toBe(false)
    expect(getJob(j.id)!.runningSince).toBeUndefined()
    expect(getJob(j.id)!.lastStatus).toBe('failed')
    removeJob(j.id)
  })

  it('tick does nothing while the feature is off, and runs only what is due when on', async () => {
    const cwd = dir()
    const j = addJob({ spec: 'every 1h', prompt: 'x', cwd }, { maxJobs: 50, minIntervalMinutes: 5 })
    let built = 0
    const make = async () => (built++, new Scripted([]))
    expect(await tick(DEFAULT_CONFIG, make, new Date(Date.now() + 10 * 3_600_000))).toEqual([])
    expect(await tick(on, make, new Date())).toEqual([])
    expect(built).toBe(0)
    const ran = await tick(on, make, new Date(Date.now() + 2 * 3_600_000))
    expect(ran.map((x) => x.job)).toContain(j.id)
    removeJob(j.id)
  })
})
