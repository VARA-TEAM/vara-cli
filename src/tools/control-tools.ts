import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

/**
 * Control tools. `ask_user` pauses the session in `waiting_user` and preserves it
 * so a follow-up message resumes exactly where it stopped. `complete` is the only
 * way the model may end a session — and the engine verifies the claim afterwards,
 * so "تم بنجاح" typed by the model is never enough.
 */

export const askUserTool: Tool<{ question: string; options?: string[] }> = {
  name: 'ask_user',
  description:
    'Stop and wait for the user when a decision is required. The session is saved and resumes as soon as the user replies. ' +
    'Use this instead of guessing when a choice affects architecture, scope, or credentials.',
  readonly: true,
  schema: z
    .object({
      question: z.string().min(5).describe('The decision needed, stated precisely'),
      options: z.array(z.string()).optional().describe('Suggested options, if any'),
    })
    .describe('Ask the user for a decision'),
  async execute(args): Promise<ToolResult> {
    const options = args.options?.length ? `\nOptions: ${args.options.join(' | ')}` : ''
    return { ok: true, output: 'Session paused; waiting for the user.', pauseForUser: args.question + options }
  },
}

export const completeTool: Tool<{
  summary: string
  verificationPlan: string
  verifiedRequirements: string[]
  changedFiles?: string[]
}> = {
  name: 'complete',
  description:
    'Declare that the objective is fully met. List EVERY active requirement number you verified (the engine numbers ' +
    'them in the system prompt) in verifiedRequirements — the claim is rejected if any active requirement is missing, ' +
    'including requirements added by later follow-up messages. The engine independently re-runs verification ' +
    '(verification command exit code, git state) before the session actually ends.',
  readonly: false,
  schema: z
    .object({
      summary: z.string().min(10).describe('What was accomplished, in plain language'),
      verificationPlan: z
        .string()
        .min(5)
        .describe('The exact commands you ran and their results that prove each acceptance condition'),
      verifiedRequirements: z
        .array(z.string())
        .min(1)
        .describe('Numbers (as strings) of ALL active requirements covered, e.g. ["1","2"]'),
      changedFiles: z.array(z.string()).optional().describe('Files you created or modified'),
    })
    .describe('Claim completion'),
  async execute(args): Promise<ToolResult> {
    return {
      ok: true,
      output: 'Completion claim recorded. The engine is now verifying the evidence.',
      completeClaim: {
        summary: args.summary,
        verificationPlan: args.verificationPlan,
        verifiedRequirements: args.verifiedRequirements,
      },
    }
  },
}

export const escalateTool: Tool<{ to: 'task' | 'goal'; objective: string; reason: string }> = {
  name: 'escalate',
  description:
    'The conversation turned out to need REAL WORK. Call this when the user asks you to change files, run/build/fix/create ' +
    'something (to: "task"), or to keep doing something over time — monitor, watch, keep green (to: "goal"). ' +
    'Do not ask for permission first when the request is clear. Do NOT call it for greetings, questions or explanations.',
  readonly: true,
  schema: z
    .object({
      to: z.enum(['task', 'goal']).describe('"task" = bounded work that ends verified; "goal" = ongoing work'),
      objective: z.string().min(3).describe('The work, restated as one clear, self-contained objective'),
      reason: z.string().describe('Which words of the user show that work is wanted'),
    })
    .describe('Switch from conversation to work'),
  async execute(args): Promise<ToolResult> {
    return {
      ok: true,
      output: `Switched to ${args.to.toUpperCase()} mode. Objective: ${args.objective}. Start the work now.`,
      escalate: { to: args.to, objective: args.objective },
    }
  },
}

export const skillTool: Tool<{ name: string }> = {
  name: 'skill',
  description:
    'Load the full instructions of one of the available skills (listed in the system prompt) and follow them. ' +
    'Use it when a skill matches what the user asked.',
  readonly: true,
  schema: z.object({ name: z.string().min(1).describe('Skill name exactly as listed') }).describe('Load a skill'),
  async execute(args, ctx): Promise<ToolResult> {
    const wanted = args.name.trim().toLowerCase()
    const skill = ctx.skills?.find((s) => s.name === wanted)
    if (!skill) {
      const names = ctx.skills?.map((s) => s.name).join(', ') || 'none'
      return { ok: false, output: `No skill named "${args.name}". Available: ${names}` }
    }
    return { ok: true, output: `# Skill: ${skill.name}\n${skill.body.slice(0, 20_000)}` }
  },
}

type DelegateTask = { id?: string; title: string; prompt: string; kind?: 'explore' | 'work'; role?: string; dependsOn?: string[] }

export const delegateTool: Tool<{ tasks: DelegateTask[] }> = {
  name: 'delegate',
  description:
    'Run a small swarm of sub-agents, each with its own fresh context, and get ONE merged report back. ' +
    'Use it for broad research (several areas of the codebase at once) or for independent pieces of work (never give two agents the same file). ' +
    'Name a `role` for each task: researcher / reviewer (read-only), implementer / tester (may change files). ' +
    'Give a task an `id` and let others list it in `dependsOn` to run them in order (the later task receives the earlier report). ' +
    'Every sub-agent sees the whole task list, so say who does what. At most 4 tasks, 3 at a time, within a shared call budget. ' +
    'Each prompt must be self-contained: the sub-agent sees nothing of this conversation. Sub-agents cannot delegate further.',
  readonly: true,
  schema: z
    .object({
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe('short id (e.g. "impl"), only needed when another task depends on it'),
            title: z.string().min(2).describe('Short label shown to the user'),
            prompt: z.string().min(10).describe('Complete, self-contained instructions, including the paths to look at and the exact report you want back'),
            role: z.string().optional().describe('researcher | reviewer | implementer | tester (or a role the user defined)'),
            kind: z.enum(['explore', 'work']).optional().describe('explore = read-only (default); work = may change files. A role already sets this.'),
            dependsOn: z.array(z.string()).optional().describe('ids of tasks that must finish first'),
          }),
        )
        .min(1)
        .max(4)
        .describe('1-4 tasks'),
    })
    .describe('Run a swarm of sub-agents'),
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.spawn) return { ok: false, output: 'Sub-agents are not available here (a sub-agent cannot delegate).' }
    const output = await ctx.spawn(args.tasks)
    return { ok: !output.startsWith('Swarm plan rejected'), output }
  },
}
