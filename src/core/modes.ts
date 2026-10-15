import type { Mode } from './types.js'

/**
 * User-defined modes.
 *
 * A custom mode is a NAMED RESTRICTION of one of the two built-in modes. It says
 * which built-in it stands on (`base`) and then narrows it further with tool and
 * command lists. It can never allow something its base refuses: the base's rules
 * (permissions.ts) always run first, a policy only adds more refusals. That is
 * what lets a user say "review mode: read files and run `npm test`, nothing else"
 * without any chance of weakening plan/build.
 */

export interface ModeDef {
  description: string
  /** The built-in mode this one stands on; its rules always apply first. */
  base: Mode
  /** When non-empty, ONLY these tools may run (`*` wildcard allowed: `mcp__github__*`). */
  allowTools: string[]
  /** These tools never run, even if allowed above. */
  denyTools: string[]
  /** When non-empty, every shell command must match one of these (`npm test*`). */
  allowCommands: string[]
  /** A shell command matching any of these is refused. */
  denyCommands: string[]
}

export interface ModePolicy extends ModeDef {
  name: string
}

export const RESERVED_MODES = ['plan', 'build']
const NAME_RE = /^[a-z][a-z0-9_-]{0,29}$/

export function validModeName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_MODES.includes(name)
}

/** Tools that stay available whatever a mode says: the agent must always be able to ask. */
const ALWAYS_TOOLS = new Set(['ask_user'])

const escapeRe = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** Case-insensitive match where `*` stands for any text. The whole string must match. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp('^' + pattern.trim().split('*').map(escapeRe).join('.*') + '$', 'i')
  return re.test(text.trim())
}

/** Why a tool is refused by the policy, or null when it may run. */
export function toolPolicyDenial(toolName: string, policy: ModePolicy | undefined): string | null {
  if (!policy || ALWAYS_TOOLS.has(toolName)) return null
  if (policy.denyTools.some((p) => globMatch(p, toolName))) {
    return `Mode "${policy.name}" does not allow the tool "${toolName}".`
  }
  if (policy.allowTools.length && !policy.allowTools.some((p) => globMatch(p, toolName))) {
    return `Mode "${policy.name}" only allows: ${policy.allowTools.join(', ')}. "${toolName}" is not one of them.`
  }
  return null
}

/** Split a shell line into its simple commands (`a && b | c; d`). */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n\r]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Constructs that hide a second command from a list match: substitution and redirection. */
const HIDDEN = /`|\$\(|<\(|>\(|[<>]/

/** Why a shell command is refused by the policy, or null when it may run. */
export function commandPolicyDenial(command: string, policy: ModePolicy | undefined): string | null {
  if (!policy) return null
  const parts = splitCommand(command)
  for (const part of parts) {
    if (policy.denyCommands.some((p) => globMatch(p, part))) {
      return `Mode "${policy.name}" does not allow this command: ${part}`
    }
  }
  if (policy.allowCommands.length) {
    // With an allow list, anything that could smuggle a second command is refused.
    if (HIDDEN.test(command)) {
      return `Mode "${policy.name}" only runs plain commands from its allow list; substitution and redirection (\`, $(), <, >) are not accepted.`
    }
    for (const part of parts) {
      if (!policy.allowCommands.some((p) => globMatch(p, part))) {
        return `Mode "${policy.name}" only allows commands matching: ${policy.allowCommands.join(', ')}. Not allowed: ${part}`
      }
    }
  }
  return null
}

/** The tools of `names` the policy lets through (hides refused tools from the model). */
export function filterByPolicy<T extends { name: string }>(tools: T[], policy: ModePolicy | undefined): T[] {
  return policy ? tools.filter((t) => toolPolicyDenial(t.name, policy) === null) : tools
}

/** A mode that is named by a session but no longer exists: read-only, never "anything goes". */
const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'skill', 'escalate']

/**
 * The policy for a session's custom mode. `undefined` means plain plan/build.
 * A name that no longer exists fails CLOSED (read-only), not open.
 */
export function policyFor(modes: Record<string, ModeDef> | undefined, name: string | undefined): ModePolicy | undefined {
  if (!name) return undefined
  const def = modes?.[name]
  if (!def) {
    return { name, description: 'This mode was removed from the settings; the session is read-only until you pick another.', base: 'plan', allowTools: READ_ONLY_TOOLS, denyTools: [], allowCommands: [], denyCommands: [] }
  }
  return { name, ...def }
}

export type ModeChoice = { ok: true; mode: Mode; customMode?: string } | { ok: false; error: string }

/** Resolve what the user typed (`plan`, `build` or a custom name) into the pair the session stores. */
export function resolveModeChoice(modes: Record<string, ModeDef> | undefined, name: string): ModeChoice {
  const n = name.trim().toLowerCase()
  if (n === 'plan' || n === 'build') return { ok: true, mode: n }
  const def = modes?.[n]
  if (!def) return { ok: false, error: `No mode named "${name}". Available: ${['plan', 'build', ...Object.keys(modes ?? {})].join(', ')}.` }
  return { ok: true, mode: def.base, customMode: n }
}

/** Name shown for a session's mode. */
export function modeLabel(config: { mode: Mode; customMode?: string }): string {
  return config.customMode ?? config.mode
}

/** Every mode name the user may pick, in cycling order. */
export function modeNames(modes: Record<string, ModeDef> | undefined): string[] {
  return ['plan', 'build', ...Object.keys(modes ?? {}).sort()]
}

/** The block added to the system prompt so the model knows its limits and does not waste turns. */
export function describePolicy(policy: ModePolicy): string {
  const lines = [`# Custom mode: ${policy.name} (stands on ${policy.base.toUpperCase()})`, policy.description]
  if (policy.allowTools.length) lines.push(`Only these tools work: ${policy.allowTools.join(', ')}.`)
  if (policy.denyTools.length) lines.push(`These tools are refused: ${policy.denyTools.join(', ')}.`)
  if (policy.allowCommands.length) lines.push(`Shell commands must match: ${policy.allowCommands.join(' | ')}.`)
  if (policy.denyCommands.length) lines.push(`Shell commands refused: ${policy.denyCommands.join(' | ')}.`)
  return lines.join('\n')
}
