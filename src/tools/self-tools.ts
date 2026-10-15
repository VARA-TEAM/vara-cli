import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'

/**
 * Self-management tools: the agent may ask to change its own setup (skills,
 * MCP servers, mode). None of them ever acts on its own: each one shows the
 * user the exact change and waits for a yes. No approval hook (a headless run,
 * a sub-agent) means "no" — nothing here is silent.
 */

type Gate = { ok: true; admin: NonNullable<ToolContext['admin']> } | { ok: false; result: ToolResult }

async function gate(ctx: ToolContext, action: string, title: string, detail: string): Promise<Gate> {
  if (!ctx.admin) return { ok: false, result: { ok: false, output: "Changing the agent's own setup is not available here." } }
  if (!ctx.approve) return { ok: false, result: { ok: false, output: 'This run has nobody to approve the change, so it was not made. Ask the user to do it.' } }
  const answer = await ctx.approve({ action, title, detail })
  if (!answer.approved) {
    return { ok: false, result: { ok: false, output: `The user declined: ${title}.${answer.note ? ` Note: ${answer.note}` : ''} Do not retry; continue without it or ask what they prefer.` } }
  }
  return { ok: true, admin: ctx.admin }
}

async function attempt(run: () => Promise<string>): Promise<ToolResult> {
  try {
    return { ok: true, output: await run() }
  } catch (err) {
    return { ok: false, output: (err as Error).message }
  }
}

export const skillWriteTool: Tool<{ name: string; description: string; body: string; scope?: 'user' | 'project' }> = {
  name: 'skill_write',
  description:
    "Create or replace one of the user's skills (a reusable playbook). The user is shown the full text and must approve it first. " +
    'Use it when you notice a repeatable procedure worth keeping. `description` says WHEN to use the skill; `body` is the markdown steps. ' +
    'scope "project" saves it inside this folder (.vara/skills), "user" for every project.',
  readonly: false,
  schema: z
    .object({
      name: z.string().min(1).describe('lowercase letters, digits, - or _ (max 40)'),
      description: z.string().min(5).describe('One line: when should the agent use this skill?'),
      body: z.string().min(10).describe('The instructions, in markdown'),
      scope: z.enum(['user', 'project']).optional().describe('default: project'),
    })
    .describe('Create or edit a skill (needs approval)'),
  async execute(args, ctx) {
    const scope = args.scope ?? 'project'
    const g = await gate(ctx, 'skill_write', `Write skill "${args.name}" (${scope})`, `${args.description}\n\n${args.body}`)
    if (!g.ok) return g.result
    return attempt(() => g.admin.writeSkill(args.name.trim().toLowerCase(), args.description, args.body, scope))
  },
}

export const skillToggleTool: Tool<{ name: string; enabled: boolean; scope?: 'session' | 'global' }> = {
  name: 'skill_toggle',
  description: 'Turn a skill on or off, for this session only (default) or everywhere. The user must approve.',
  readonly: false,
  schema: z
    .object({
      name: z.string().min(1),
      enabled: z.boolean(),
      scope: z.enum(['session', 'global']).optional().describe('default: session'),
    })
    .describe('Toggle a skill (needs approval)'),
  async execute(args, ctx) {
    const scope = args.scope ?? 'session'
    const g = await gate(ctx, 'skill_toggle', `Turn skill "${args.name}" ${args.enabled ? 'on' : 'off'} (${scope === 'global' ? 'everywhere' : 'this session'})`, '')
    if (!g.ok) return g.result
    return attempt(() => g.admin.setSkillEnabled(args.name.trim().toLowerCase(), args.enabled, scope))
  },
}

export const mcpManageTool: Tool<{ action: 'add' | 'remove' | 'enable' | 'disable'; name: string; command?: string; scope?: 'session' | 'global' }> = {
  name: 'mcp_manage',
  description:
    'Add, remove, enable or disable an MCP server (external tools). Adding RUNS a program on this machine, so the user is shown the exact command line and must approve. ' +
    '`command` is a command line (npx -y @scope/server) or an https URL, only for "add". Secrets cannot be passed here: tell the user to store them in the vault.',
  readonly: false,
  schema: z
    .object({
      action: z.enum(['add', 'remove', 'enable', 'disable']),
      name: z.string().min(1).describe('server name: letters, digits, - or _'),
      command: z.string().optional().describe('only for add: the command line or URL'),
      scope: z.enum(['session', 'global']).optional().describe('only for enable/disable: this session only (default) or saved for everyone'),
    })
    .describe('Manage MCP servers (needs approval)'),
  async execute(args, ctx) {
    if (args.action === 'add' && !args.command?.trim()) return { ok: false, output: '"add" needs a command line or a URL.' }
    const scope = args.action === 'enable' || args.action === 'disable' ? (args.scope ?? 'session') : undefined
    const title = `${args.action[0]!.toUpperCase()}${args.action.slice(1)} MCP server "${args.name}"${scope ? (scope === 'session' ? ' (this session)' : ' (everywhere)') : ''}`
    const g = await gate(ctx, `mcp_${args.action}`, title, args.action === 'add' ? `This will run on your machine:\n${args.command}` : '')
    if (!g.ok) return g.result
    return attempt(() => g.admin.mcp(args.action, args.name, args.command, scope))
  },
}

export const switchModeTool: Tool<{ mode: string; reason: string }> = {
  name: 'switch_mode',
  description:
    'Ask to switch this session to another mode (plan, build, or a custom mode). The user approves or declines. ' +
    'Use it from plan mode when the plan is ready and you need to change files.',
  readonly: true,
  schema: z
    .object({
      mode: z.string().min(1).describe('plan, build, or a custom mode name'),
      reason: z.string().min(3).describe('Why you need it, in one sentence'),
    })
    .describe('Switch mode (needs approval)'),
  async execute(args, ctx) {
    const g = await gate(ctx, 'switch_mode', `Switch mode ${ctx.modePolicy?.name ?? ctx.mode} → ${args.mode}`, args.reason)
    if (!g.ok) return g.result
    return attempt(() => g.admin.setMode(args.mode))
  },
}

export const SELF_TOOL_NAMES = ['skill_write', 'skill_toggle', 'mcp_manage', 'switch_mode'] as const
