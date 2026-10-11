import { z } from 'zod'
import { spawn } from 'node:child_process'
import { resolve, relative, isAbsolute } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import { checkCommandAllowed } from './permissions.js'
import { scrubAll } from '../security/redact.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 40_000

function runCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          env,
          windowsHide: true,
          // Without this, libuv escapes inner quotes as \" which cmd.exe does not
          // understand, silently mangling commands like `node -e "process.exit(1)"`.
          windowsVerbatimArguments: true,
        })
      : spawn('bash', ['-lc', command], { cwd, env })

    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2)
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, output: out + `\n[spawn error] ${err.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, output: out, timedOut })
    })
  })
}

export const shellTool: Tool<{ command: string; cwd?: string; timeoutMs?: number; env?: Record<string, string> }> = {
  name: 'shell',
  description:
    'Run a shell command in the working directory. Session secrets are injected into the child environment automatically; never echo them. ' +
    'Use the cwd argument to run inside a subdirectory — do NOT build "cd /d ..." chains, they break on quoting and paths with spaces. ' +
    'Blocked in plan mode. Publishing commands (git push, gh write, npm publish) are blocked unless the user enabled publishing.',
  readonly: false,
  schema: z
    .object({
      command: z.string().min(1).describe('Command to run'),
      cwd: z
        .string()
        .optional()
        .describe('Subdirectory to run in, relative to the working directory. Preferred over cd/chdir in the command.'),
      timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Timeout, default 120000'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Extra env vars for this command only (do NOT pass secrets literally; use vault names)'),
    })
    .describe('Run a shell command'),
  guard: (args, ctx) => checkCommandAllowed((args as { command: string }).command, ctx).reason || null,
  async execute(args, ctx): Promise<ToolResult> {
    const denial = checkCommandAllowed(args.command, ctx)
    if (denial.denied) return { ok: false, output: denial.reason }

    // Resolve the run directory inside the session working directory.
    let runDir = ctx.cwd
    if (args.cwd) {
      const candidate = isAbsolute(args.cwd) ? args.cwd : resolve(ctx.cwd, args.cwd)
      const rel = relative(ctx.cwd, candidate)
      if (rel.startsWith('..')) {
        return { ok: false, output: `cwd escapes the working directory: ${args.cwd}` }
      }
      runDir = candidate
    }

    const env = { ...ctx.env, ...(args.env ?? {}) }
    const { exitCode, output, timedOut } = await runCommand(
      args.command,
      runDir,
      env,
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    const scrubbed = scrubAll(output.trim() || '(no output)')
    const header = timedOut ? `[timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms]\n` : ''
    return {
      ok: exitCode === 0 && !timedOut,
      output: `${header}[exit ${exitCode}]\n${scrubbed}`.slice(0, MAX_OUTPUT),
    }
  },
}

/** Run a command outside the tool loop — used by the engine for verification. */
export async function runVerificationCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 300_000,
): Promise<{ exitCode: number | null; output: string }> {
  const { exitCode, output } = await runCommand(command, cwd, env, timeoutMs)
  return { exitCode, output: scrubAll(output) }
}
