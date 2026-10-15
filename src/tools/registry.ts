import { z } from 'zod'
import type { Tool, ToolContext } from './types.js'
import { rawToolDefinition, zodToJsonSchema } from './types.js'
import { deleteFileTool, editFileTool, listDirTool, readFileTool, writeFileTool } from './fs-tools.js'
import { globTool, grepTool } from './search.js'
import { shellTool } from './shell-tool.js'
import { ghTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from './git-tools.js'
import { askUserTool, completeTool, delegateTool, escalateTool, skillTool } from './control-tools.js'
import { checkCommandAllowed } from './permissions.js'
import { scrubAll } from '../security/redact.js'
import { filterByPolicy, type ModePolicy } from '../core/modes.js'

const ALL_TOOLS: Tool<never>[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  shellTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  ghTool,
  askUserTool,
  completeTool,
  skillTool,
  escalateTool,
  delegateTool,
] as unknown as Tool<never>[]

/**
 * Plan mode allows only tools that cannot mutate anything. The shell tool is
 * deliberately excluded: its command policy would have to be airtight, and a
 * whitelist that misses one mutating command silently breaks plan mode.
 * Read-only git status/diff/log tools exist precisely so planning can inspect
 * the repository without shell access.
 */
const PLAN_ALLOWED = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'ask_user',
  'skill',
  'delegate',
])

/** Read-only investigation set used to answer questions. */
const QUESTION_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'skill', 'escalate', 'delegate'])

/** Work tools for a mode. `escalate` only exists outside work. */
export function toolsForMode(mode: 'plan' | 'build'): Tool<never>[] {
  const work = ALL_TOOLS.filter((t) => t.name !== 'escalate')
  if (mode === 'build') return work
  return work.filter((t) => PLAN_ALLOWED.has(t.name))
}

export type ToolIntent = 'chat' | 'question' | 'task' | 'goal'

export interface ToolSet {
  /** Tools from connected MCP servers (dynamic). */
  extra?: Tool<never>[]
  hasSkills?: boolean
  /** Sub-agents may not delegate. */
  canDelegate?: boolean
  /** A custom mode's restrictions: refused tools are hidden from the model. */
  policy?: ModePolicy
}

/**
 * Tools offered for one turn. Chat gets only `escalate` (it must be able to
 * say "this is actually work"); questions get read-only investigation tools;
 * tasks/goals get the mode's full set. `skill` / `delegate` / MCP tools are
 * offered only when they exist and make sense. MCP tools that do not declare
 * themselves read-only are withheld in PLAN mode and during questions.
 */
export function toolsFor(intent: ToolIntent, mode: 'plan' | 'build', set: ToolSet | boolean = false): Tool<never>[] {
  const opts: ToolSet = typeof set === 'boolean' ? { hasSkills: set } : set
  let list =
    intent === 'chat'
      ? ALL_TOOLS.filter((t) => t.name === 'escalate' || t.name === 'skill')
      : intent === 'question'
        ? ALL_TOOLS.filter((t) => QUESTION_TOOLS.has(t.name))
        : toolsForMode(mode)
  if (!opts.hasSkills) list = list.filter((t) => t.name !== 'skill')
  if (opts.canDelegate === false) list = list.filter((t) => t.name !== 'delegate')
  if (intent !== 'chat' && opts.extra?.length) {
    const readOnlyOnly = intent === 'question' || mode === 'plan'
    list = [...list, ...opts.extra.filter((t) => !readOnlyOnly || t.readonly)]
  }
  return filterByPolicy(list, opts.policy)
}

export function toolDefinitions(mode: 'plan' | 'build', intent: ToolIntent = 'task', set: ToolSet | boolean = false): Array<Record<string, unknown>> {
  return toolsFor(intent, mode, set).map((t) => (t.jsonSchema ? rawToolDefinition({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }) : zodToJsonSchema(t.schema as z.ZodType, t.name)))
}

export function findTool(name: string, extra: Tool<never>[] = []): Tool<never> | undefined {
  return ALL_TOOLS.find((t) => t.name === name) ?? extra.find((t) => t.name === name)
}

export { checkCommandAllowed }
