import { z } from 'zod'
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolResult } from './types.js'
import { scrubAll } from '../security/redact.js'

const run = promisify(execFile)

async function git(args: string[], cwd: string): Promise<ToolResult> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
    return { ok: true, output: scrubAll(stdout.trim() || '(no output)') }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: scrubAll(`${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`.trim()) }
  }
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the working tree status (read-only).',
  readonly: true,
  schema: z.object({}).describe('Git status'),
  execute: (_a, ctx) => git(['status', '--porcelain=v1', '--branch'], ctx.cwd),
}

export const gitDiffTool: Tool<{ staged?: boolean; path?: string }> = {
  name: 'git_diff',
  description: 'Show the diff (read-only). Optionally staged, or limited to a path.',
  readonly: true,
  schema: z
    .object({
      staged: z.boolean().optional().describe('Diff the index instead of the working tree'),
      path: z.string().optional().describe('Limit the diff to one path'),
    })
    .describe('Git diff'),
  execute: (args, ctx) => {
    const cmd = ['diff', ...(args.staged ? ['--staged'] : []), '--', args.path ?? '.']
    return git(cmd, ctx.cwd)
  },
}

export const gitLogTool: Tool<{ limit?: number }> = {
  name: 'git_log',
  description: 'Show recent commits (read-only).',
  readonly: true,
  schema: z.object({ limit: z.number().int().min(1).max(50).optional() }).describe('Git log'),
  execute: (args, ctx) => git(['log', `-${args.limit ?? 10}`, '--oneline', '--decorate'], ctx.cwd),
}

export const gitCommitTool: Tool<{ message: string; paths?: string[] }> = {
  name: 'git_commit',
  description:
    'Stage the given paths (or all changes) and commit. Commit messages must follow Conventional Commits: <type>: <description>.',
  readonly: false,
  schema: z
    .object({
      message: z.string().min(5).describe('Conventional commit message'),
      paths: z.array(z.string()).optional().describe('Paths to stage. Omit to stage all changes.'),
    })
    .describe('Git commit'),
  async execute(args, ctx): Promise<ToolResult> {
    const add = await git(['add', ...(args.paths ?? ['-A'])], ctx.cwd)
    if (!add.ok) return add
    return git(['commit', '-m', args.message], ctx.cwd)
  },
}

export const ghTool: Tool<{ args: string; write?: boolean }> = {
  name: 'gh',
  description:
    'Run the GitHub CLI (gh) with the session token injected as GH_TOKEN. Example args: "repo view", "issue list". ' +
    'Write operations require publishing to be enabled.',
  readonly: false,
  schema: z
    .object({
      args: z.string().min(1).describe('Arguments passed to gh, without the binary name'),
      write: z.boolean().optional().describe('True if this call mutates anything on GitHub'),
    })
    .describe('GitHub CLI'),
  guard: (args, ctx) => {
    if ((args as { write?: boolean }).write && !ctx.allowPublish) {
      return 'GitHub write operations are disabled for this session. Ask the user to enable publishing.'
    }
    return null
  },
  async execute(args, ctx): Promise<ToolResult> {
    return new Promise((resolvePromise) => {
      const child = spawn('gh', args.args.split(/\s+/), {
        cwd: ctx.cwd,
        env: ctx.env,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.on('error', (err) => resolvePromise({ ok: false, output: `gh failed to start: ${err.message}` }))
      child.on('close', (code) =>
        resolvePromise({ ok: code === 0, output: scrubAll(out.trim() || '(no output)').slice(0, 40_000) }),
      )
    })
  },
}
