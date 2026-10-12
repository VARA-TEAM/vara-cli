import { z } from 'zod'
import type { Tool, ToolContext } from './types.js'
import { zodToJsonSchema } from './types.js'
import { deleteFileTool, editFileTool, listDirTool, readFileTool, writeFileTool } from './fs-tools.js'
import { globTool, grepTool } from './search.js'
import { shellTool } from './shell-tool.js'
import { ghTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from './git-tools.js'
import { askUserTool, completeTool } from './control-tools.js'
import { checkCommandAllowed } from './permissions.js'
import { scrubAll } from '../security/redact.js'

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
])

export function toolsForMode(mode: 'plan' | 'build'): Tool<never>[] {
  if (mode === 'build') return ALL_TOOLS
  return ALL_TOOLS.filter((t) => PLAN_ALLOWED.has(t.name))
}

export function toolDefinitions(mode: 'plan' | 'build'): Array<Record<string, unknown>> {
  return toolsForMode(mode).map((t) => zodToJsonSchema(t.schema as z.ZodType, t.name))
}

export function findTool(name: string): Tool<never> | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}

export { checkCommandAllowed }
