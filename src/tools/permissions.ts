import type { Mode } from '../core/types.js'
import type { Tool, ToolContext } from './types.js'
import { commandPolicyDenial, toolPolicyDenial } from '../core/modes.js'

/**
 * Permission enforcement.
 *
 * Plan mode must be enforced at the tool/command level, not by asking the model
 * nicely. A shell command is the escape hatch that would defeat a write-tool
 * ban, so plan mode denies the shell tool entirely and offers read-only
 * dedicated tools instead (read/list/grep/git_status/git_diff/git_log).
 */

export const PLAN_DENIED_TOOL_HINT =
  'Plan mode is read-only. Only read/list/grep/git-status/diff/log tools are available. ' +
  'The session switches to build mode when the user allows it.'

/** Commands that must never run unless the user explicitly enabled publishing. */
const PUBLISH_COMMANDS = /\b(git\s+push|gh\s+repo\s+(create|edit|delete)|gh\s+api\s+.*(POST|PATCH|DELETE)|npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+push)\b/i

/** Destructive commands we refuse outright. */
const FORBIDDEN_COMMANDS = /\b(rm\s+-rf\s+\/(\s|$)|rm\s+-rf\s+~|mkfs|format\s+[cCdD]:|del\s+\/[fsq]\s+[cCdD]:\\|Remove-Item\s+-Recurse\s+-Force\s+[cCdD]:\\)/i

export interface Denial {
  denied: boolean
  reason: string
}

export function checkToolAllowed(tool: Tool<never>, mode: Mode): Denial {
  if (mode === 'plan' && !tool.readonly) {
    return { denied: true, reason: PLAN_DENIED_TOOL_HINT }
  }
  return { denied: false, reason: '' }
}

/** A user-defined mode can only add refusals on top of plan/build — see core/modes.ts. */
export function checkModePolicy(tool: Tool<never>, ctx: ToolContext): Denial {
  const reason = toolPolicyDenial(tool.name, ctx.modePolicy)
  return reason ? { denied: true, reason } : { denied: false, reason: '' }
}

/** Shell-level policy. Used by the shell tool itself and by any command runner. */
export function checkCommandAllowed(command: string, ctx: ToolContext): Denial {
  if (FORBIDDEN_COMMANDS.test(command)) {
    return { denied: true, reason: `Refusing destructive command: ${command}` }
  }
  if (!ctx.allowPublish && PUBLISH_COMMANDS.test(command)) {
    return {
      denied: true,
      reason:
        'Publishing (git push / gh write / npm publish / docker push) is disabled for this session. ' +
        'Ask the user to enable publishing, or use ask_user.',
    }
  }
  // Last, and only ever stricter: the custom mode's command lists.
  const reason = commandPolicyDenial(command, ctx.modePolicy)
  if (reason) return { denied: true, reason }
  return { denied: false, reason: '' }
}

export interface Decision {
  allowed: boolean
  reason: string
}

/** Single gate every tool execution passes through. */
export function authorize(tool: Tool<never>, args: unknown, ctx: ToolContext): Decision {
  const modeCheck = checkToolAllowed(tool, ctx.mode)
  if (modeCheck.denied) return { allowed: false, reason: modeCheck.reason }

  const policyCheck = checkModePolicy(tool, ctx)
  if (policyCheck.denied) return { allowed: false, reason: policyCheck.reason }

  const guard = tool.guard?.(args, ctx)
  if (guard) return { allowed: false, reason: guard }

  return { allowed: true, reason: '' }
}
