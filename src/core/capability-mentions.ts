/**
 * `@name` in a message points the agent at something it has: a skill, an MCP server, parallel agents, the web, the
 * browser. The model is told so in plain words, once, right after the user's text — so "@review check this diff"
 * cannot be missed the way a tool buried in a long list can. Files (`@src/a.ts`) are handled elsewhere.
 */
export interface Capabilities {
  skills: readonly string[]
  mcpServers: readonly string[]
}

const KEYWORDS: Record<string, string> = {
  agents: 'work on the independent parts in parallel: use the `delegate` tool (sub-agents) and merge their reports',
  parallel: 'work on the independent parts in parallel: use the `delegate` tool (sub-agents) and merge their reports',
  swarm: 'work on the independent parts in parallel: use the `delegate` tool (sub-agents) and merge their reports',
  web: 'look it up on the internet with `web_search` (and read pages with `web_fetch`) instead of answering from memory',
  browser: 'use the `browser` tool for this',
}

export const MENTION_MARK = '[VARA: the user pointed at'

/** The hint to append after `text`, or null when nothing known was mentioned (or it was already added). */
export function mentionHint(text: string, caps: Capabilities): string | null {
  if (text.includes(MENTION_MARK)) return null
  const found = new Set<string>()
  const lines: string[] = []
  for (const m of text.matchAll(/(?:^|[\s(])@([\p{L}\p{N}_.-]+)/gu)) {
    const raw = m[1]!.replace(/[.,;:!?؟،]+$/u, '')
    const name = raw.toLowerCase()
    if (!name || found.has(name)) continue
    const skill = caps.skills.find((s) => s.toLowerCase() === name)
    const mcp = caps.mcpServers.find((s) => s.toLowerCase() === name)
    if (skill) lines.push(`skill "${skill}": load it with the \`skill\` tool and follow it`)
    else if (mcp) lines.push(`MCP server "${mcp}": use its tools (named mcp__${mcp}__*) for this`)
    else if (KEYWORDS[name]) lines.push(`@${name}: ${KEYWORDS[name]}`)
    else continue
    found.add(name)
  }
  return lines.length ? `\n\n${MENTION_MARK} — ${lines.join('; ')}.]` : null
}
