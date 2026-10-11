import { z } from 'zod'
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, extname } from 'node:path'
import type { Tool, ToolResult } from './types.js'

const MAX_READ_BYTES = 200_000

/** Resolves a path and refuses anything outside the session working directory. */
function resolveInside(cwd: string, p: string): { path: string } | { error: string } {
  const abs = resolve(cwd, p)
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || resolve(rel) === resolve(cwd) + sep + '..') {
    return { error: `Path escapes the working directory: ${p}` }
  }
  return { path: abs }
}

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    'Read a text file from the working directory. Returns numbered lines. Use offset/limit for large files.',
  readonly: true,
  schema: z
    .object({
      path: z.string().describe('File path relative to the working directory'),
      offset: z.number().int().min(1).optional().describe('1-based line to start from'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max lines to return'),
    })
    .describe('Read a text file'),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, args.path)
    if ('error' in target) return { ok: false, output: target.error }
    try {
      const info = await stat(target.path)
      if (info.size > MAX_READ_BYTES) {
        return { ok: false, output: `File too large (${info.size} bytes). Read a slice with offset/limit.` }
      }
      const content = await readFile(target.path, 'utf8')
      const lines = content.split(/\r?\n/)
      const start = (args.offset ?? 1) - 1
      const end = args.limit ? start + args.limit : lines.length
      const slice = lines.slice(start, end)
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n')
      return { ok: true, output: numbered || '(empty file)' }
    } catch (err) {
      return { ok: false, output: `read_file failed: ${(err as Error).message}` }
    }
  },
}

export const listDirTool: Tool<{ path?: string; depth?: number }> = {
  name: 'list_dir',
  description: 'List directory contents recursively (bounded depth).',
  readonly: true,
  schema: z
    .object({
      path: z.string().optional().describe('Directory relative to the working directory. Default: "."'),
      depth: z.number().int().min(1).max(5).optional().describe('Recursion depth, default 2'),
    })
    .describe('List a directory'),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, args.path ?? '.')
    if ('error' in target) return { ok: false, output: target.error }
    const maxDepth = args.depth ?? 2
    const lines: string[] = []

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > maxDepth || lines.length > 500) return
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
        const full = join(dir, entry.name)
        const rel = relative(ctx.cwd, full) || '.'
        if (entry.isDirectory()) {
          lines.push(`${rel}/`)
          await walk(full, depth + 1)
        } else {
          lines.push(rel)
        }
      }
    }

    try {
      await walk(target.path, 1)
      return { ok: true, output: lines.join('\n') || '(empty directory)' }
    } catch (err) {
      return { ok: false, output: `list_dir failed: ${(err as Error).message}` }
    }
  },
}

export const grepTool: Tool<{ pattern: string; path?: string }> = {
  name: 'grep',
  description: 'Search file contents with a regular expression inside the working directory.',
  readonly: true,
  schema: z
    .object({
      pattern: z.string().describe('Regular expression to search for'),
      path: z.string().optional().describe('Directory or file to search. Default "."'),
    })
    .describe('Search file contents'),
  async execute(args, ctx): Promise<ToolResult> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const target = resolveInside(ctx.cwd, args.path ?? '.')
    if ('error' in target) return { ok: false, output: target.error }
    const isWin = process.platform === 'win32'
    try {
      if (isWin) {
        // No ripgrep guarantee on Windows: fall back to a bounded Node walk.
        return await nodeGrep(args.pattern, ctx.cwd, target.path)
      }
      const { stdout } = await run('rg', ['-n', '--max-count', '5', '-e', args.pattern, target.path], {
        cwd: ctx.cwd,
      })
      return { ok: true, output: stdout.slice(0, 50_000) || 'No matches.' }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      if (e.stdout) return { ok: true, output: e.stdout.slice(0, 50_000) || 'No matches.' }
      return await nodeGrep(args.pattern, ctx.cwd, target.path)
    }
  },
}

async function nodeGrep(pattern: string, cwd: string, target: string): Promise<ToolResult> {
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    return { ok: false, output: `Invalid regex: ${(err as Error).message}` }
  }
  const hits: string[] = []
  const info = await stat(target)
  const files: string[] = []

  async function collect(dir: string, depth: number): Promise<void> {
    if (depth > 6 || files.length > 2000) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await collect(full, depth + 1)
      else files.push(full)
    }
  }

  if (info.isDirectory()) await collect(target, 0)
  else files.push(target)

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf8')
      content.split(/\r?\n/).forEach((line, i) => {
        if (re.test(line) && hits.length < 200) {
          hits.push(`${relative(cwd, file)}:${i + 1}:${line.slice(0, 300)}`)
        }
      })
    } catch {
      /* binary or unreadable */
    }
  }
  return { ok: true, output: hits.join('\n') || 'No matches.' }
}

/** Syntax-check a file right after writing it, so corruption is caught at the
 *  write site instead of surfacing minutes later as a mysterious runtime error.
 *  Returns null when the language has no cheap checker available. */
async function syntaxCheck(path: string): Promise<{ ok: boolean; message: string } | null> {
  const ext = extname(path).toLowerCase()
  if (ext === '.json') {
    try {
      JSON.parse(await readFile(path, 'utf8'))
      return { ok: true, message: 'json parse ok' }
    } catch (err) {
      return { ok: false, message: `json parse failed: ${(err as Error).message}` }
    }
  }
  if (ext === '.py') {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    try {
      await run('python', ['-m', 'py_compile', path], { windowsHide: true })
      return { ok: true, message: 'py_compile ok' }
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string }
      return { ok: false, message: `py_compile failed: ${(e.stderr ?? e.stdout ?? (err as Error).message).slice(0, 2000)}` }
    }
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    try {
      await run(process.execPath, ['--check', path], { windowsHide: true })
      return { ok: true, message: 'node --check ok' }
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string }
      return { ok: false, message: `node --check failed: ${(e.stderr ?? e.stdout ?? (err as Error).message).slice(0, 2000)}` }
    }
  }
  return null
}

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a text file inside the working directory. Creates parent directories. ' +
    'After writing, the engine reads the file back, verifies the bytes match, and syntax-checks ' +
    'known languages (.py, .js/.mjs/.cjs, .json) — a syntax failure is reported immediately.',
  readonly: false,
  schema: z
    .object({
      path: z.string().describe('File path relative to the working directory'),
      content: z.string().describe('Full file content'),
    })
    .describe('Write a file'),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, args.path)
    if ('error' in target) return { ok: false, output: target.error }
    try {
      await mkdir(dirname(target.path), { recursive: true })
      await writeFile(target.path, args.content, 'utf8')

      // P0: read the file back and compare — proves the write actually landed.
      const readBack = await readFile(target.path, 'utf8')
      const bytes = Buffer.byteLength(readBack, 'utf8')
      if (readBack !== args.content) {
        return {
          ok: false,
          output:
            `WRITE VERIFICATION FAILED: file on disk differs from what was requested. ` +
            `Requested ${args.content.length} chars, read back ${readBack.length} chars. ` +
            `Do not trust this file; re-read it and rewrite it.`,
        }
      }

      const check = await syntaxCheck(target.path)
      if (check && !check.ok) {
        return {
          ok: false,
          output: `Wrote ${bytes} bytes to ${args.path}, but SYNTAX CHECK FAILED — ${check.message}`,
        }
      }
      return {
        ok: true,
        output: `Wrote ${bytes} bytes to ${args.path} (read-back verified${check ? `, ${check.message}` : ''})`,
      }
    } catch (err) {
      return { ok: false, output: `write_file failed: ${(err as Error).message}` }
    }
  },
}

export const editFileTool: Tool<{ path: string; oldString: string; newString: string; replaceAll?: boolean }> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. oldString must match exactly once unless replaceAll is true. Prefer this over rewriting whole files.',
  readonly: false,
  schema: z
    .object({
      path: z.string().describe('File path relative to the working directory'),
      oldString: z.string().describe('Exact text to find (must be unique unless replaceAll)'),
      newString: z.string().describe('Replacement text'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence'),
    })
    .describe('Edit a file by exact match'),
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, args.path)
    if ('error' in target) return { ok: false, output: target.error }
    try {
      const content = await readFile(target.path, 'utf8')
      const count = content.split(args.oldString).length - 1
      if (count === 0) return { ok: false, output: 'oldString not found in file.' }
      if (count > 1 && !args.replaceAll) {
        return { ok: false, output: `oldString matched ${count} times. Make it unique or set replaceAll.` }
      }
      const next = args.replaceAll ? content.split(args.oldString).join(args.newString) : content.replace(args.oldString, args.newString)
      await writeFile(target.path, next, 'utf8')

      // Read back and confirm the bytes on disk equal the intended result.
      const readBack = await readFile(target.path, 'utf8')
      if (readBack !== next) {
        return { ok: false, output: `EDIT VERIFICATION FAILED: ${args.path} on disk differs from the intended edited content.` }
      }
      const check = await syntaxCheck(target.path)
      if (check && !check.ok) {
        return { ok: false, output: `Edit applied but SYNTAX CHECK FAILED — ${check.message}` }
      }
      return {
        ok: true,
        output: `Replaced ${args.replaceAll ? count : 1} occurrence(s) in ${args.path} (read-back verified${check ? `, ${check.message}` : ''})`,
      }
    } catch (err) {
      return { ok: false, output: `edit_file failed: ${(err as Error).message}` }
    }
  },
}

export const deleteFileTool: Tool<{ path: string }> = {
  name: 'delete_file',
  description: 'Delete a file or an empty directory inside the working directory.',
  readonly: false,
  schema: z.object({ path: z.string().describe('Path relative to the working directory') }).describe('Delete a path'),
  guard: (args) => {
    const p = (args as { path: string }).path
    if (!p || p === '.' || p === './') return 'Refusing to delete the working directory root.'
    return null
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveInside(ctx.cwd, args.path)
    if ('error' in target) return { ok: false, output: target.error }
    try {
      await rm(target.path, { recursive: false })
      return { ok: true, output: `Deleted ${args.path}` }
    } catch (err) {
      return { ok: false, output: `delete_file failed: ${(err as Error).message}` }
    }
  },
}
