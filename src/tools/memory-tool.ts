import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'
import type { MemorySettings } from '../config/config.js'
import { addNote, MAX_NOTE_CHARS, readNotes, removeNote, replaceNote, type MemoryScope } from '../core/memory.js'

type Args = { action: 'view' | 'add' | 'replace' | 'remove'; scope?: MemoryScope; text?: string; index?: number }

/**
 * `memory`: the agent's access to the notes that survive between sessions (core/memory.ts). Offered only when
 * the owner turned memory on. Reading is free; changing a note follows `memory.agentWrites`: `ask` (default)
 * shows the exact note and waits for a yes (no approver — headless, scheduled, sub-agent — means refused),
 * `auto` writes directly, `off` is read-only. A note that looks like a secret is always refused.
 */
export function makeMemoryTool(settings: () => MemorySettings): Tool<Args> {
  return {
    name: 'memory',
    description:
      'Notes that persist across sessions. action "view" lists them (scope: user | project | omit for both); "add" saves ONE short durable fact ' +
      `(max ${MAX_NOTE_CHARS} chars) such as a stable user preference or a project convention that is not already in the code or its docs; "replace"/"remove" fix or drop note number \`index\`. ` +
      'Save sparingly: never secrets, never one-off task details, never anything easy to re-read from the project. Notes are shown to the user, who can edit them.',
    readonly: false,
    schema: z
      .object({
        action: z.enum(['view', 'add', 'replace', 'remove']),
        scope: z.enum(['user', 'project']).optional().describe('user = about the person, everywhere; project = about this folder'),
        text: z.string().max(1000).optional(),
        index: z.number().int().min(1).optional().describe('1-based note number, from view'),
      })
      .describe('Persistent notes'),
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const cfg = settings()
      if (args.action === 'view') {
        const scopes: MemoryScope[] = args.scope ? [args.scope] : ['user', 'project']
        const out = scopes.map((s) => {
          const notes = readNotes(s, ctx.cwd)
          return `${s}: ${notes.length ? '\n' + notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(none)'}`
        })
        return { ok: true, output: out.join('\n') }
      }
      if (cfg.agentWrites === 'off') return { ok: false, output: 'The owner set memory to read-only for the agent. Tell the user what you would have noted instead.' }
      const scope = args.scope ?? 'project'
      const text = (args.text ?? '').replace(/\s+/g, ' ').trim()
      if (args.action !== 'remove' && !text) return { ok: false, output: 'text is required.' }
      if (args.action !== 'add' && !args.index) return { ok: false, output: 'index is required (see view).' }
      if (cfg.agentWrites === 'ask') {
        if (!ctx.approve) return { ok: false, output: 'This run has nobody to approve a memory change, so it was not saved.' }
        const what = args.action === 'remove' ? `forget note ${args.index}` : args.action === 'replace' ? `change note ${args.index} to: ${text}` : `remember: ${text}`
        const a = await ctx.approve({ action: 'memory', title: `Memory (${scope}): ${what}`.slice(0, 200), detail: what })
        if (!a.approved) return { ok: false, output: `The user declined the memory change.${a.note ? ` Note: ${a.note}` : ''} Do not retry.` }
      }
      try {
        if (args.action === 'add') {
          const r = addNote(scope, ctx.cwd, text)
          return { ok: true, output: r.added ? `Saved (${scope}, ${r.total} notes).` : 'Already noted.' }
        }
        if (args.action === 'replace') {
          replaceNote(scope, ctx.cwd, args.index!, text)
          return { ok: true, output: `Note ${args.index} changed.` }
        }
        return { ok: true, output: `Removed: ${removeNote(scope, ctx.cwd, args.index!)}` }
      } catch (err) {
        return { ok: false, output: (err as Error).message }
      }
    },
  }
}
