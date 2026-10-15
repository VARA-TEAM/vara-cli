import { z } from 'zod'
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, extname } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import { outlineOf } from '../core/repomap.js'

const MAX_READ_BYTES = 200_000
/** A file longer than this, read without a range, comes back as an outline + its first lines (the model asks for slices). */
export const OUTLINE_OVER_LINES = 1_000
export const OUTLINE_MARK = '[outline mode:'

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
      if (!args.offset && !args.limit && lines.length > OUTLINE_OVER_LINES && ctx.smartRead !== false) {
        const outline = outlineOf(args.path, content)
        if (outline) {
          const first = lines
            .slice(0, 60)
            .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
            .join('\n')
          return {
            ok: true,
            output:
              `[File: ${args.path} — ${lines.length} lines total] ${OUTLINE_MARK} the file is long, so you got its structure and first 60 lines. ` +
              `Read a part with offset/limit, or one symbol with read_symbol. Pass limit=2000 to force the whole file.]\n` +
              `Outline (start-end signature):\n${outline}\n\nFirst 60 lines:\n${first}`,
          }
        }
      }
      const start = (args.offset ?? 1) - 1
      const end = args.limit ? start + args.limit : lines.length
      const slice = lines.slice(start, end)
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n')
      const header = `[File: ${args.path} — ${lines.length} lines total${args.offset || args.limit ? `, showing lines ${start + 1}-${Math.min(end, lines.length)}` : ''}]\n`
      return { ok: true, output: header + (numbered || '(empty file)') }
    } catch (err) {
      return { ok: false, output: `read_file failed: ${(err as Error).message}` }
    }
  },
}

const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'build',
  'out',
  '.vscode',
  '.idea',
  '__pycache__',
  '.pytest_cache',
])

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
        if (IGNORED_NAMES.has(entry.name)) continue
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
      let oldStr = args.oldString
      let newStr = args.newString
      let count = content.split(oldStr).length - 1

      // Newline-resilient matching (handles Windows CRLF vs Unix LF mismatches)
      if (count === 0) {
        if (content.includes('\r\n') && !oldStr.includes('\r\n')) {
          const crlfOld = oldStr.replace(/\r?\n/g, '\r\n')
          const crlfNew = newStr.replace(/\r?\n/g, '\r\n')
          const crlfCount = content.split(crlfOld).length - 1
          if (crlfCount > 0) {
            oldStr = crlfOld
            newStr = crlfNew
            count = crlfCount
          }
        } else if (!content.includes('\r\n') && oldStr.includes('\r\n')) {
          const lfOld = oldStr.replace(/\r\n/g, '\n')
          const lfNew = newStr.replace(/\r\n/g, '\n')
          const lfCount = content.split(lfOld).length - 1
          if (lfCount > 0) {
            oldStr = lfOld
            newStr = lfNew
            count = lfCount
          }
        }
      }

      if (count === 0) return { ok: false, output: 'oldString not found in file.' }
      if (count > 1 && !args.replaceAll) {
        return { ok: false, output: `oldString matched ${count} times. Make it unique or set replaceAll.` }
      }
      const next = args.replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr)
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
