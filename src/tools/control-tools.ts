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
