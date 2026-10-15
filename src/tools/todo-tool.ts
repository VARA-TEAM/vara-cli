import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

type Item = { text: string; status: 'pending' | 'in_progress' | 'done' }
type Args = { items: Item[] }

const MARK: Record<Item['status'], string> = { pending: '[ ]', in_progress: '[~]', done: '[x]' }

/**
 * `todo`: the agent's visible plan for multi-step work. It changes nothing on disk (so it is allowed in plan mode),
 * but it lets the person see what the agent intends and how far it got: the web side panel shows the latest list,
 * and the list is echoed back so the model re-reads its own plan. Send the WHOLE list each time.
 */
export const todoTool: Tool<Args> = {
  name: 'todo',
  description:
    'Keep a short visible checklist for work with 3 or more steps: send the whole list each time with each item "pending", "in_progress" or "done". ' +
    'Only one item should be in_progress. Update it as you go; skip it for small tasks.',
  readonly: true,
  schema: z
    .object({
      items: z
        .array(z.object({ text: z.string().min(1).max(200), status: z.enum(['pending', 'in_progress', 'done']) }))
        .min(1)
        .max(20),
    })
    .describe('The whole checklist'),
  async execute(args): Promise<ToolResult> {
    const doing = args.items.filter((i) => i.status === 'in_progress').length
    const left = args.items.filter((i) => i.status !== 'done').length
    const lines = args.items.map((i) => `${MARK[i.status]} ${i.text}`)
    return { ok: true, output: `${lines.join('\n')}\n${left === 0 ? 'All items are done.' : `${left} left.`}${doing > 1 ? ' Note: more than one item is in progress — finish one first.' : ''}` }
  },
}

/** The latest plan from a transcript (for the interfaces): newest `todo` call wins. */
export function latestPlan(transcript: Array<{ toolCalls?: Array<{ name: string; arguments: string }> }>): Item[] | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    for (const c of [...(transcript[i]?.toolCalls ?? [])].reverse()) {
      if (c.name !== 'todo') continue
      try {
        const parsed = JSON.parse(c.arguments) as { items?: Item[] }
        if (Array.isArray(parsed.items)) return parsed.items.filter((x) => x && typeof x.text === 'string').slice(0, 20)
      } catch {
        /* a cut-off call: keep looking */
      }
    }
  }
  return null
}
