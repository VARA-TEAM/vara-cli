import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'
import { createProposal } from '../core/proposals.js'

type Args = { name: string; scope?: 'user' | 'project'; description: string; body: string; reason: string }

/**
 * `skill_propose`: after finishing a multi-step task the agent may suggest a reusable playbook. It only queues a
 * file for the owner (core/proposals.ts); it installs nothing and does not interrupt the user mid-task. Offered
 * only when `skills.propose` is on, in the owner's own sessions (not sub-agents, not scheduled runs).
 */
export const skillProposeTool: Tool<Args> = {
  name: 'skill_propose',
  description:
    'Suggest a reusable skill (a short playbook) to the owner, who approves or rejects it later; nothing is installed by this call. ' +
    'Use it ONCE, after a task that took many steps and that you would do the same way again, or to improve an existing skill you just found lacking (use its exact name). ' +
    'Not for one-off work, not for facts about this project (that is memory), never with secrets. body: the steps, concise (under 8000 chars); description: one line saying WHEN to use it; reason: what task it came from.',
  readonly: false,
  schema: z
    .object({
      name: z.string().min(1).max(40),
      scope: z.enum(['user', 'project']).optional().describe('user = everywhere (default); project = this folder only'),
      description: z.string().min(1).max(300),
      body: z.string().min(1).max(8000),
      reason: z.string().min(1).max(300),
    })
    .describe('A proposed skill'),
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.admin) return { ok: false, output: "Skill proposals are only taken in the owner's own interactive sessions." }
    try {
      const p = await createProposal({ name: args.name, scope: args.scope ?? 'user', description: args.description, body: args.body, reason: args.reason, cwd: ctx.cwd, sessionId: ctx.sessionId })
      return { ok: true, output: `Proposal ${p.id} ("${p.name}") is waiting for the owner${p.replaces !== 'none' ? ` (it would replace the ${p.replaces} skill of that name)` : ''}. It is not installed. Do not propose again for this task; carry on.` }
    } catch (err) {
      return { ok: false, output: (err as Error).message }
    }
  },
}
