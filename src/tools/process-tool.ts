import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { getBackground, listBackground, stopBackground } from './process-registry.js'
import { scrubAll } from '../security/redact.js'

type Args = { action: 'list' | 'log' | 'stop'; id?: string; tail?: number }

const age = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)

/** `process`: look at, read the output of, or stop the commands started with `shell` + background:true. */
export const processTool: Tool<Args> = {
  name: 'process',
  description:
    'Manage background commands started with shell {background:true}: "list" shows them, "log" reads the latest output of one (tail = lines, default 40), "stop" ends one. ' +
    'Use it to check that a dev server is up or why it failed.',
  readonly: false,
  schema: z
    .object({
      action: z.enum(['list', 'log', 'stop']),
      id: z.string().optional().describe('Process id such as bg1 (for log and stop)'),
      tail: z.number().int().min(1).max(400).optional().describe('How many last lines of output (log only)'),
    })
    .describe('Background processes'),
  async execute(args, ctx): Promise<ToolResult> {
    if (args.action === 'list') {
      const all = listBackground(ctx.sessionId)
      if (!all.length) return { ok: true, output: 'No background processes in this session.' }
      return { ok: true, output: all.map((p) => `${p.id}  ${p.done ? `exited (${p.exitCode})` : 'running'}  ${age(Date.now() - p.startedAt)}  ${p.command.slice(0, 100)}`).join('\n') }
    }
    if (!args.id) return { ok: false, output: 'Give the process id (see action "list").' }
    const p = getBackground(ctx.sessionId, args.id)
    if (!p) return { ok: false, output: `No background process ${args.id} in this session.` }
    if (args.action === 'stop') {
      if (p.done) return { ok: true, output: `${p.id} had already exited (${p.exitCode}).` }
      stopBackground(ctx.sessionId, p.id)
      return { ok: true, output: `Stopping ${p.id} (${p.command.slice(0, 80)}).` }
    }
    const lines = p.log.split(/\r?\n/)
    const tail = lines.slice(-(args.tail ?? 40)).join('\n')
    return { ok: true, output: scrubAll(`${p.id} ${p.done ? `exited (${p.exitCode})` : 'running'}\n${tail || '(no output yet)'}`) }
  },
}
