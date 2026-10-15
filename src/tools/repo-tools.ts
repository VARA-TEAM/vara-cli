import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import { buildIndex, findSymbols, renderMap } from '../core/repomap.js'
import { queryOutput } from '../core/outputs.js'

/**
 * Cheap navigation tools. They exist so the model can find and read the part of
 * the project it needs instead of whole files (see core/repomap.ts).
 */

export const repoMapTool: Tool<{ query?: string; path?: string; budgetTokens?: number }> = {
  name: 'repo_map',
  description:
    'Ranked outline of the project: files with their functions/classes/types and line ranges, best matches for `query` first, within a token budget. Use it FIRST to find where things live instead of listing and reading many files.',
  readonly: true,
  schema: z
    .object({
      query: z.string().max(200).optional().describe('What you are looking for: words from names or paths, e.g. "session store save"'),
      path: z.string().optional().describe('Only files under this folder'),
      budgetTokens: z.number().int().min(200).max(6000).optional().describe('Size of the answer, default 1500'),
    })
    .describe('Outline of the project'),
  async execute(args, ctx): Promise<ToolResult> {
    const idx = await buildIndex(ctx.cwd)
    if (!idx.files.some((f) => f.syms.length)) return { ok: true, output: '(no source symbols found — use list_dir and glob instead)' }
    return { ok: true, output: renderMap(idx, args) }
  },
}

export const readSymbolTool: Tool<{ name: string; path?: string }> = {
  name: 'read_symbol',
  description:
    'Read ONE function/class/type by name — only its lines, numbered — instead of the whole file. Optional `path` narrows to a file or folder. If several definitions match you get each of them (capped).',
  readonly: true,
  schema: z
    .object({
      name: z.string().min(1).max(120).describe('The symbol name, e.g. "buildSystemPrompt"'),
      path: z.string().optional().describe('A file or folder to look in'),
    })
    .describe('Read one symbol'),
  async execute(args, ctx): Promise<ToolResult> {
    const idx = await buildIndex(ctx.cwd)
    const hits = findSymbols(idx, args.name, args.path).slice(0, 3)
    if (!hits.length) return { ok: false, output: `No definition named "${args.name}" in the index. Try repo_map with a query, or grep.` }
    const parts: string[] = []
    for (const h of hits) {
      const abs = resolve(ctx.cwd, h.file)
      if (relative(ctx.cwd, abs).startsWith('..')) continue
      const lines = (await readFile(join(ctx.cwd, h.file), 'utf8')).split(/\r?\n/)
      const start = h.sym.line
      const end = Math.min(h.sym.endLine, start + 220)
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n')
      parts.push(`[${h.file}:${start}-${end}${h.sym.endLine > end ? ' (cut at 220 lines — read the rest with read_file offset/limit)' : ''}]\n${body}`)
    }
    return { ok: true, output: parts.join('\n\n') }
  },
}

export const toolOutputTool: Tool<{ id: string; head?: number; tail?: number; grep?: string; from?: number; to?: number; context?: number }> = {
  name: 'tool_output',
  description:
    'Get more of a tool result that was shortened ("output compressed … id"). Ask for the first/last N lines, a line range, or the lines matching a regex (with context). Cheaper than re-running the command.',
  readonly: true,
  schema: z
    .object({
      id: z.string().min(1).max(100).describe('The id printed in the "output compressed" note'),
      head: z.number().int().min(1).max(400).optional(),
      tail: z.number().int().min(1).max(400).optional(),
      grep: z.string().max(200).optional().describe('Regex to search for'),
      from: z.number().int().min(1).optional().describe('First line of a range'),
      to: z.number().int().min(1).optional().describe('Last line of a range'),
      context: z.number().int().min(0).max(5).optional().describe('Lines around each grep match, default 1'),
    })
    .describe('More of a shortened tool output'),
  async execute(args, ctx): Promise<ToolResult> {
    const full = await ctx.outputs?.get(args.id)
    if (full == null) return { ok: false, output: `No stored output with id "${args.id}" (it may belong to another session).` }
    return { ok: true, output: queryOutput(full, args) }
  },
}
