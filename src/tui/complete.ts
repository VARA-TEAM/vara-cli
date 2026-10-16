/**
 * Inline completion for the prompt: `/command`, `/skill-name`, and `@skill` / `@mcp-server` / `@agents` / `@web`.
 * Pure, so what Tab does is testable without drawing anything. Files (`@path`) are completed by the attach logic.
 */
export interface Suggestion {
  /** What is shown. */
  label: string
  detail: string
  /** The whole input after Tab picks this one. */
  apply: string
}

export interface CompletionSources {
  commands: Array<{ name: string; description: string }>
  skills: string[]
  mcpServers: string[]
}

const WORDS: Array<[string, string]> = [
  ['agents', 'work in parallel with sub-agents'],
  ['web', 'search the internet first'],
  ['browser', 'use the browser tool'],
]

export function suggestions(input: string, src: CompletionSources, limit = 6): Suggestion[] {
  // `/name` as the first token only.
  const slash = /^\/([\w-]*)$/.exec(input)
  if (slash) {
    const q = slash[1]!.toLowerCase()
    const cmds = src.commands
      .filter((c) => c.name.slice(1).toLowerCase().startsWith(q))
      .map((c) => ({ label: c.name, detail: c.description, apply: `${c.name} ` }))
    const skills = src.skills
      .filter((s) => s.toLowerCase().startsWith(q) && !cmds.some((c) => c.label === `/${s}`))
      .map((s) => ({ label: `/${s}`, detail: 'skill', apply: `/${s} ` }))
    return [...cmds, ...skills].slice(0, limit)
  }
  // `@word` being typed at the end, at a word start.
  const at = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(input)
  if (at) {
    const q = at[2]!.toLowerCase()
    const head = input.slice(0, input.length - at[2]!.length - 1)
    const pick = (name: string, detail: string): Suggestion => ({ label: `@${name}`, detail, apply: `${head}@${name} ` })
    return [
      ...src.skills.filter((s) => s.toLowerCase().startsWith(q)).map((s) => pick(s, 'skill')),
      ...src.mcpServers.filter((s) => s.toLowerCase().startsWith(q)).map((s) => pick(s, 'MCP server')),
      ...WORDS.filter(([w]) => w.startsWith(q)).map(([w, d]) => pick(w, d)),
    ].slice(0, limit)
  }
  return []
}
