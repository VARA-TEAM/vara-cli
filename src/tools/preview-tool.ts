import { z } from 'zod'
import { resolve, relative, isAbsolute } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import { checkCommandAllowed } from './permissions.js'
import { previews as shared, type PreviewManager } from '../preview/manager.js'
import { scrubAll } from '../security/redact.js'

type Args = { action: 'start' | 'stop' | 'status' | 'logs'; command?: string; cwd?: string; port?: number }

/**
 * `preview`: run the project's dev server in the background and give the user a
 * live view of it (the web UI shows it inside the session; the terminal prints
 * the URL). It exists because `shell` waits for a command to FINISH, and a dev
 * server never does. Not read-only: it runs a command, so it is a build-mode
 * tool and the same command policy as `shell` applies.
 */
export function makePreviewTool(manager: PreviewManager = shared): Tool<Args> {
  return {
    name: 'preview',
    description:
      'Start, stop or inspect a background dev server so the user can see the running app live. ' +
      'action "start" needs a command (e.g. "npm run dev"); the server must listen on the PORT environment variable ' +
      '(or put {port} in the command, e.g. "vite --port {port}"). Returns the URL once it answers. ' +
      'Use this instead of `shell` for anything that keeps running. "logs" shows the server output, "status" its state, "stop" ends it.',
    readonly: false,
    schema: z
      .object({
        action: z.enum(['start', 'stop', 'status', 'logs']),
        command: z.string().min(1).max(500).optional().describe('Command that starts the dev server (action start)'),
        cwd: z.string().optional().describe('Subdirectory to run in, relative to the working directory'),
        port: z.number().int().min(1024).max(65535).optional().describe('Force a port instead of picking a free one'),
      })
      .describe('Control the live preview'),
    guard: (args, ctx) => {
      const a = args as Args
      return a.action === 'start' && a.command ? checkCommandAllowed(a.command, ctx).reason || null : null
    },
    async execute(args, ctx): Promise<ToolResult> {
      const id = ctx.sessionId
      if (args.action === 'status') {
        const i = manager.get(id)
        return { ok: true, output: i ? `${i.state}${i.url ? ` — ${i.url}` : ''}${i.error ? ` — ${i.error}` : ''}` : 'no preview is running for this session' }
      }
      if (args.action === 'logs') return { ok: true, output: scrubAll(manager.logs(id, 80)) || '(no output yet)' }
      if (args.action === 'stop') {
        await manager.stop(id)
        return { ok: true, output: 'preview stopped' }
      }
      if (!args.command) return { ok: false, output: 'action "start" needs a command' }
      const denial = checkCommandAllowed(args.command, ctx)
      if (denial.denied) return { ok: false, output: denial.reason }
      let runDir = ctx.cwd
      if (args.cwd) {
        const candidate = isAbsolute(args.cwd) ? args.cwd : resolve(ctx.cwd, args.cwd)
        if (relative(ctx.cwd, candidate).startsWith('..')) return { ok: false, output: `cwd escapes the working directory: ${args.cwd}` }
        runDir = candidate
      }
      try {
        const info = await manager.start(id, { command: args.command, cwd: runDir, env: ctx.env, ...(args.port ? { port: args.port } : {}) })
        if (info.state !== 'running') {
          return { ok: false, output: `preview did not start: ${info.error ?? info.state}\n${scrubAll(manager.logs(id, 30))}`.trim() }
        }
        return { ok: true, output: `preview running at ${info.url} (dev server on port ${info.port}). The user can watch it in the session; use action "logs" to read its output.` }
      } catch (err) {
        return { ok: false, output: scrubAll((err as Error).message) }
      }
    },
  }
}

export const previewTool = makePreviewTool()
