import { loadConfig, persistConfig } from '../config/config.js'
import { buildProvider } from '../runtime.js'
import { addJob, getJob, listJobs, readLog, removeJob, updateJob, nextAfter, type Job } from './store.js'
import { runJob, tick } from './run.js'

export const SCHEDULE_USAGE = `vara schedule — recurring headless runs (off until you enable it; only you, at this machine, can add or run jobs)

  vara schedule enable | disable            turn the feature on or off (config: schedule.enabled)
  vara schedule add "<spec>" "<prompt>" [--cwd <dir>] [--name <n>] [--build]
                                            spec: "every 30m" | "every 2h" | "every 1d" | "0 9 * * 1-5" (minute hour day month weekday, local time)
                                            default is read-only (plan mode); --build lets the run change files and run commands (never publish)
  vara schedule list                        jobs, next run, last result
  vara schedule run <id|name>               run one job now
  vara schedule logs <id|name>              the end of its log
  vara schedule pause|resume <id|name>
  vara schedule remove <id|name>
  vara schedule tick                        run whatever is due, once (for cron / Task Scheduler)
  vara schedule daemon                      keep running and check every 30 seconds (Ctrl+C to stop)

Runs have no one to approve anything: whatever needs a yes is refused. Each run is stopped after schedule.maxRunMinutes and is saved as a normal session (vara sessions --all).`

function line(j: Job): string {
  return `${j.id}  ${j.name}  [${j.mode}${j.paused ? ', paused' : ''}]  ${j.spec}  → ${j.paused ? '—' : j.nextAt}\n           ${j.cwd}${j.lastStatus ? `  ·  last: ${j.lastStatus}${j.lastNote ? ` (${j.lastNote})` : ''}` : ''}`
}

export async function scheduleCommand(args: string[]): Promise<void> {
  const sub = args[0]
  const config = await loadConfig()
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const need = (): void => {
    if (!config.schedule.enabled) throw new Error('Scheduling is off. Turn it on with: vara schedule enable')
  }
  const pick = (): Job => {
    const j = args[1] ? getJob(args[1]) : undefined
    if (!j) throw new Error(`No job "${args[1] ?? ''}". See: vara schedule list`)
    return j
  }
  const provider = async () => (await buildProvider(config)).provider

  switch (sub) {
    case 'enable':
    case 'disable':
      await persistConfig({ ...config, schedule: { ...config.schedule, enabled: sub === 'enable' } })
      console.log(sub === 'enable' ? 'Scheduling is on. Add a job with: vara schedule add "every 1d" "<prompt>"' : 'Scheduling is off. Jobs are kept but nothing runs.')
      return
    case 'add': {
      need()
      const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--cwd', '--name'].includes(all[i - 1] ?? ''))
      const [spec, prompt] = positional
      if (!spec || !prompt) throw new Error('Usage: vara schedule add "<spec>" "<prompt>" [--cwd <dir>] [--name <n>] [--build]')
      const job = addJob({ spec, prompt, cwd: flag('--cwd') ?? process.cwd(), ...(flag('--name') ? { name: flag('--name')! } : {}), mode: args.includes('--build') ? 'build' : 'plan' }, config.schedule)
      console.log(`Added.\n${line(job)}`)
      return
    }
    case 'list': {
      const jobs = listJobs()
      console.log(`${config.schedule.enabled ? 'Scheduling is on.' : 'Scheduling is OFF (vara schedule enable).'}${jobs.length ? '\n' + jobs.map(line).join('\n') : '\nNo jobs.'}`)
      return
    }
    case 'run': {
      need()
      const j = pick()
      console.log(`Running ${j.name}…`)
      const r = await runJob(j, config, await provider())
      console.log(`${r.ok ? 'ok' : 'failed'}: ${r.note}\nLog: vara schedule logs ${j.name}`)
      return
    }
    case 'logs': {
      const j = pick()
      console.log(readLog(j.id) || '(no log yet)')
      return
    }
    case 'pause':
    case 'resume': {
      const j = pick()
      updateJob(j.id, sub === 'pause' ? { paused: true } : { paused: false, nextAt: nextAfter(j, new Date()).toISOString() })
      console.log(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${j.name}.`)
      return
    }
    case 'remove': {
      const j = pick()
      removeJob(j.id)
      console.log(`Removed ${j.name}.`)
      return
    }
    case 'tick': {
      need()
      const r = await tick(config, provider)
      console.log(r.length ? r.map((x) => `${x.job}: ${x.ok ? 'ok' : 'failed'} — ${x.note}`).join('\n') : 'Nothing due.')
      return
    }
    case 'daemon': {
      need()
      console.log('VARA scheduler running (checks every 30 s). Ctrl+C to stop.')
      let stop = false
      process.on('SIGINT', () => {
        stop = true
      })
      while (!stop) {
        // Re-read the config each pass so `schedule disable` takes effect without a restart.
        const live = await loadConfig()
        for (const x of await tick(live, provider)) console.log(`${new Date().toISOString()} ${x.job}: ${x.ok ? 'ok' : 'failed'} — ${x.note}`)
        await new Promise((r) => setTimeout(r, 30_000))
      }
      return
    }
    default:
      console.log(SCHEDULE_USAGE)
  }
}
