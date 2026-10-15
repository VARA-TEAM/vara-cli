import type { Tool, ToolResult } from '../tools/types.js'
import { McpClient, type McpServerConfig, type McpStatus } from './client.js'
import { getSecretsForScope } from '../security/vault.js'
import { registerSecret, scrubAll } from '../security/redact.js'

/** A few well-known servers, one keystroke away in /mcp. */
export interface McpPreset {
  name: string
  label: string
  config: McpServerConfig
  note: string
}

export const MCP_PRESETS: McpPreset[] = [
  { name: 'filesystem', label: 'Filesystem', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, note: 'read/write files in this folder' },
  { name: 'fetch', label: 'Fetch (web pages)', config: { command: 'uvx', args: ['mcp-server-fetch'] }, note: 'download a URL as text — needs uv' },
  { name: 'memory', label: 'Memory (knowledge graph)', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, note: 'remember facts between sessions' },
  { name: 'playwright', label: 'Playwright (browser)', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, note: 'drive a real browser' },
  { name: 'github', label: 'GitHub', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], secretEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'] }, note: 'needs vault secret GITHUB_PERSONAL_ACCESS_TOKEN' },
  { name: 'context7', label: 'Context7 (library docs)', config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, note: 'up-to-date library documentation' },
]

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Tool name the model sees: `mcp__<server>__<tool>` (≤ 64 chars, API-safe). */
export function mcpToolName(server: string, tool: string): string {
  const full = `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`
  return full.length <= 64 ? full : full.slice(0, 64)
}

export interface ServerView {
  name: string
  status: McpStatus
  tools: number
  error: string
  config: McpServerConfig
}

/**
 * Owns every MCP connection. Connecting happens in the background and never
 * blocks the UI; a broken server shows an error and the rest keep working.
 */
export class McpHub {
  private clients = new Map<string, McpClient>()
  private configs: Record<string, McpServerConfig> = {}
  private listeners = new Set<() => void>()

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const l of this.listeners) l()
  }

  /** Reconcile with the configuration: start new/enabled, stop removed/disabled, restart changed. */
  async sync(servers: Record<string, McpServerConfig>): Promise<void> {
    const next = servers
    for (const [name, client] of [...this.clients]) {
      const cfg = next[name]
      if (!cfg || cfg.enabled === false || JSON.stringify(cfg) !== JSON.stringify(this.configs[name])) {
        client.close()
        this.clients.delete(name)
      }
    }
    this.configs = JSON.parse(JSON.stringify(next)) as Record<string, McpServerConfig>
    let secrets: Record<string, string> = {}
    try {
      secrets = await getSecretsForScope('global')
      for (const [k, v] of Object.entries(secrets)) registerSecret(v, k)
    } catch {
      /* no vault yet: servers needing secrets will report it */
    }
    const starts: Promise<void>[] = []
    for (const [name, cfg] of Object.entries(next)) {
      if (cfg.enabled === false || this.clients.has(name)) continue
      const client = new McpClient(name, cfg, secrets)
      this.clients.set(name, client)
      starts.push(
        client.connect().finally(() => this.changed()),
      )
    }
    this.changed()
    await Promise.all(starts)
  }

  async reconnect(name: string): Promise<void> {
    this.clients.get(name)?.close()
    this.clients.delete(name)
    // sync() starts every enabled server that has no client — i.e. this one.
    await this.sync(this.configs)
  }

  view(allConfigs: Record<string, McpServerConfig>): ServerView[] {
    return Object.entries(allConfigs).map(([name, config]) => {
      const c = this.clients.get(name)
      return {
        name,
        config,
        status: config.enabled === false ? 'disabled' : (c?.status ?? 'connecting'),
        tools: c?.status === 'ready' ? c.tools.length : 0,
        error: c?.error ?? '',
      }
    })
  }

  /** Name + description of one server's tools (for display). */
  toolsOf(name: string): Array<{ name: string; description: string; readOnly: boolean }> {
    const c = this.clients.get(name)
    return c?.status === 'ready' ? c.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })) : []
  }

  /** Tools of every ready server, adapted to the agent's tool interface. */
  tools(exclude?: ReadonlySet<string>): Tool<never>[] {
    const out: Tool<never>[] = []
    for (const client of this.clients.values()) {
      if (client.status !== 'ready' || exclude?.has(client.name)) continue
      for (const t of client.tools) {
        const tool: Tool<unknown> = {
          name: mcpToolName(client.name, t.name),
          description: `[MCP ${client.name}] ${t.description}`.slice(0, 1_000),
          readonly: t.readOnly,
          mcp: true,
          jsonSchema: t.inputSchema,
          // Never used for MCP tools (the raw schema wins) — kept to satisfy the interface.
          schema: undefined as never,
          async execute(args): Promise<ToolResult> {
            const res = await client.call(t.name, args)
            return { ok: res.ok, output: scrubAll(res.text) }
          },
        }
        out.push(tool as unknown as Tool<never>)
      }
    }
    return out
  }

  /** One line per ready server for the system prompt. */
  summary(exclude?: ReadonlySet<string>): string {
    const lines: string[] = []
    for (const c of this.clients.values()) {
      if (c.status !== 'ready' || exclude?.has(c.name)) continue
      const names = c.tools.slice(0, 8).map((t) => t.name).join(', ')
      lines.push(`- ${c.name}${c.serverName && c.serverName !== c.name ? ` (${c.serverName})` : ''}: ${c.tools.length} tools — ${names}${c.tools.length > 8 ? ', …' : ''}  → call as mcp__${sanitizeName(c.name)}__<tool>`)
    }
    return lines.join('\n')
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close()
    this.clients.clear()
  }
}
