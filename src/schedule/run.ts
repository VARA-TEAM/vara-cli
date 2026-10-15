import type { VaraConfig } from '../config/config.js'
import { budgetFor } from '../config/config.js'
import type { Provider } from '../llm/provider.js'
import { Engine } from '../core/engine.js'
import { createSession, CreateSessionInput } from '../core/session.js'
import { saveSession } from '../core/store.js'
import { scrubAll } from '../security/redact.js'
import { appendLog, dueJobs, nextAfter, updateJob, type Job } from './store.js'

/**
 * Runs one scheduled job headlessly: a normal task session in the job's folder, no approver (so anything that
 * needs a yes is refused, never auto-approved), never allowed to publish, stopped after
 * `schedule.maxRunMinutes`. The session is saved like any other, so it shows up in `vara sessions --all`; the
 * log holds the final answer and a one-line outcome.
 */
export async function runJob(job: Job, config: VaraConfig, provider: Provider, now = new Date()): Promise<{ ok: boolean; note: string }> {
  const started = now.toISOString()
  updateJob(job.id, { runningSince: started, lastStartedAt: started })
  appendLog(job.id, `\n=== ${started} · ${job.name} · ${job.mode} ===\n`)
  let ok = false
  let note = ''
  try {
    const session = createSession(
      CreateSessionInput.parse({ kind: 'task', mode: job.mode, objective: job.prompt, cwd: job.cwd, auto: true, allowPublish: false, model: config.provider.model }),
      config,
    )
    session.config.allowPublish = false
    session.config.budget = { ...budgetFor('task', config), maxDurationMs: config.schedule.maxRunMinutes * 60_000 }
    await saveSession(session)
    let text = ''
    const engine = new Engine({
      session,
      provider,
      onEvent: (e) => {
        if (e.type === 'text') text += e.delta
        else if (e.type === 'completed') text = `${e.summary}\n`
      },
    })
    const timer = setTimeout(() => engine.stop(), config.schedule.maxRunMinutes * 60_000 + 5_000)
    try {
      await engine.run()
    } finally {
      clearTimeout(timer)
      await saveSession(session)
    }
    ok = ['completed', 'idle', 'ready'].includes(session.state)
    note = `${session.state}${session.stateReason ? `: ${session.stateReason}` : ''} (session ${session.id})`
    appendLog(job.id, `${scrubAll(text).trim().slice(-4000)}\n-- ${note}\n`)
  } catch (err) {
    note = `error: ${(err as Error).message}`
    appendLog(job.id, `-- ${note}\n`)
  }
  const finished = new Date()
  updateJob(job.id, {
    runningSince: undefined as unknown as string,
    lastFinishedAt: finished.toISOString(),
    lastStatus: ok ? 'ok' : 'failed',
    lastNote: scrubAll(note).slice(0, 300),
    nextAt: nextAfter(job, finished).toISOString(),
  })
  return { ok, note }
}

/** One pass: run every due job, one after the other (never in parallel: limits and cost stay predictable). */
export async function tick(config: VaraConfig, provider: () => Promise<Provider>, now = new Date()): Promise<Array<{ job: string; ok: boolean; note: string }>> {
  if (!config.schedule.enabled) return []
  const results: Array<{ job: string; ok: boolean; note: string }> = []
  for (const job of dueJobs(now, config.schedule.maxRunMinutes)) {
    const r = await runJob(job, config, await provider(), now)
    results.push({ job: job.name, ...r })
  }
  return results
}
