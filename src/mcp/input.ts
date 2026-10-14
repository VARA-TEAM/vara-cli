import type { McpServerConfig } from './client.js'

/** `npx -y pkg "a b"` → ['npx', '-y', 'pkg', 'a b']. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Config for what the user typed: a URL becomes a remote server, anything else a command line. */
export function serverFromInput(input: string): McpServerConfig | string {
  const text = input.trim()
  if (!text) return 'Type a command (npx -y @scope/server) or a URL (https://…).'
  if (/^https?:\/\//i.test(text)) return { url: text, enabled: true }
  const [command, ...args] = splitCommand(text)
  if (!command) return 'Type a command (npx -y @scope/server) or a URL (https://…).'
  return { command, args, enabled: true }
}
