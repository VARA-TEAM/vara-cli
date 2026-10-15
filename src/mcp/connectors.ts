import type { McpServerConfig } from './client.js'

/**
 * Connectors: ready-made MCP servers with guided secrets. A connector is nothing magic — adding one writes an
 * ordinary MCP server entry (named after the connector) and stores its secrets in the encrypted vault, so it
 * appears in /mcp, can be switched off per session, and its tools reach the agent like any MCP tool.
 *
 * Only servers whose npm package or documented endpoint was checked are listed. `checked` says how.
 * Servers that need browser-based OAuth sign-in are NOT listed: VARA's MCP client cannot complete that flow yet
 * (see docs/ROADMAP.md), and a connector that cannot connect is worse than none.
 */
export interface ConnectorSecret {
  /** Name in the vault (and the environment variable the server expects, for local servers). */
  name: string
  label: string
  /** Where the person gets it. */
  help: string
}

export type ConnectorCategory = 'code' | 'knowledge' | 'ops' | 'data' | 'web' | 'files'

export interface Connector {
  id: string
  name: string
  category: ConnectorCategory
  description: string
  config: McpServerConfig
  secrets: ConnectorSecret[]
  /** What was verified and when (honesty about the catalogue). */
  checked: string
}

const npx = (pkg: string, ...rest: string[]): Pick<McpServerConfig, 'command' | 'args'> => ({ command: 'npx', args: ['-y', pkg, ...rest] })

export const CONNECTORS: Connector[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'files',
    description: 'Read and write files in the working folder through MCP (VARA already has file tools; this adds the standard MCP file toolset).',
    config: npx('@modelcontextprotocol/server-filesystem', '.'),
    secrets: [],
    checked: 'npm package @modelcontextprotocol/server-filesystem exists (2026-10)',
  },
  {
    id: 'memory',
    name: 'Memory',
    category: 'knowledge',
    description: 'A small knowledge graph the agent can keep facts in between sessions.',
    config: npx('@modelcontextprotocol/server-memory'),
    secrets: [],
    checked: 'npm package @modelcontextprotocol/server-memory exists (2026-10)',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    category: 'knowledge',
    description: 'A structured step-by-step reasoning tool for hard problems.',
    config: npx('@modelcontextprotocol/server-sequential-thinking'),
    secrets: [],
    checked: 'npm package @modelcontextprotocol/server-sequential-thinking exists (2026-10)',
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'knowledge',
    description: 'Up-to-date documentation for libraries and frameworks.',
    config: npx('@upstash/context7-mcp'),
    secrets: [],
    checked: 'npm package @upstash/context7-mcp exists (2026-10)',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    category: 'web',
    description: 'Download a URL as text or markdown. Needs `uv` (uvx) installed.',
    config: { command: 'uvx', args: ['mcp-server-fetch'] },
    secrets: [],
    checked: 'PyPI package mcp-server-fetch — not re-verified in this build',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    category: 'web',
    description: 'A full Playwright browser server. (VARA also has its own built-in `browser` tool, which needs nothing extra.)',
    config: npx('@playwright/mcp@latest'),
    secrets: [],
    checked: 'npm package @playwright/mcp exists (2026-10)',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'code',
    description: 'Repositories, issues and pull requests through GitHub\'s own remote MCP server.',
    config: { url: 'https://api.githubcopilot.com/mcp/', bearerSecret: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
    secrets: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', help: 'github.com → Settings → Developer settings → Personal access tokens. Give it only the scopes you need.' }],
    checked: 'endpoint from GitHub\'s MCP documentation; not connected to in this build (needs your token)',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge',
    description: 'Search and edit Notion pages and databases shared with your integration.',
    config: { ...npx('@notionhq/notion-mcp-server'), secretEnv: ['NOTION_TOKEN'] },
    secrets: [{ name: 'NOTION_TOKEN', label: 'Notion integration token', help: 'notion.so/profile/integrations → create an internal integration, then share pages with it.' }],
    checked: 'npm package @notionhq/notion-mcp-server exists (2026-10); token variable name from its README, not exercised here',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'ops',
    description: 'Look at issues and events from Sentry while debugging.',
    config: { ...npx('@sentry/mcp-server'), secretEnv: ['SENTRY_ACCESS_TOKEN'] },
    secrets: [{ name: 'SENTRY_ACCESS_TOKEN', label: 'Sentry user auth token', help: 'sentry.io → Settings → Account → Auth Tokens.' }],
    checked: 'npm package @sentry/mcp-server exists (2026-10); token variable name from its README, not exercised here',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'data',
    description: 'Manage Supabase projects, tables and SQL. Use a read-only token on anything important.',
    config: { ...npx('@supabase/mcp-server-supabase', '--read-only'), secretEnv: ['SUPABASE_ACCESS_TOKEN'] },
    secrets: [{ name: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase personal access token', help: 'supabase.com/dashboard/account/tokens. Started read-only; remove --read-only in /mcp only if you must.' }],
    checked: 'npm package @supabase/mcp-server-supabase exists (2026-10); flags from its README, not exercised here',
  },
]

export function findConnector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id)
}

/** The server entry a connector adds (a copy: the catalogue is never mutated). */
export function connectorServer(c: Connector): McpServerConfig {
  return JSON.parse(JSON.stringify({ args: [], env: {}, secretEnv: [], headers: {}, ...c.config, enabled: true })) as McpServerConfig
}
