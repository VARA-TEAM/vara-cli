import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { VaraConfig } from '../config/config.js'
import { MCP_PRESETS, type McpHub, type ServerView } from '../mcp/hub.js'
import type { McpServerConfig } from '../mcp/client.js'
import { windowStart, useSync } from './providers.js'
import { glyph, theme } from './theme.js'

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/

/** `npx -y pkg "a b"` → ['npx', '-y', 'pkg', 'a b']. Exported for tests. */
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

type Row = { kind: 'server'; view: ServerView } | { kind: 'preset'; index: number } | { kind: 'custom' }

const STATUS_COLOR: Record<string, string> = { ready: theme.ok, error: theme.err, connecting: theme.warn, disabled: theme.muted }

/**
 * /mcp: connect external tool servers. Add one in two keystrokes from the
 * presets, or paste any command line / URL. Status is live.
 */
export function McpScreen({
  config,
  hub,
  maxRows = 10,
  onChange,
  onClose,
}: {
  config: VaraConfig
  hub: McpHub
  maxRows?: number
  onChange: (config: VaraConfig) => void
  onClose: () => void
}): React.ReactElement {
  const [cfg, setCfg, cfgR] = useSync(config)
  const [, setTick] = useState(0)
  const [screen, setScreen, screenR] = useSync<'list' | 'tools' | 'name' | 'command' | 'confirm'>('list')
  const [idx, setIdx, idxR] = useSync(0)
  const [text, setText, textR] = useSync('')
  const [draftName, , draftR] = useSync('')
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null)

  useEffect(() => hub.onChange(() => setTick((t) => t + 1)), [hub])

  const servers = cfg.mcp.servers
  const views = hub.view(servers)
  const rows: Row[] = [
    ...views.map((view): Row => ({ kind: 'server', view })),
    { kind: 'custom' },
    ...MCP_PRESETS.map((p, index) => ({ p, index }))
      .filter(({ p }) => !servers[p.name])
      .map(({ index }): Row => ({ kind: 'preset', index })),
  ]
  const sel = Math.min(idx, rows.length - 1)

  const apply = (next: VaraConfig) => {
    setCfg(next)
    onChange(next)
  }
  const setServers = (s: Record<string, McpServerConfig>) => apply({ ...cfgR.current, mcp: { ...cfgR.current.mcp, servers: s as never } })

  const add = (name: string, server: McpServerConfig) => {
    setServers({ ...cfgR.current.mcp.servers, [name]: { args: [], env: {}, secretEnv: [], headers: {}, ...server, enabled: true } as never })
    setMsg({ text: `${glyph.ok} ${name} added — connecting…`, err: false })
  }

  useInput((raw, key) => {
    const screen = screenR.current
    const rowsNow = (() => {
      const sv = cfgR.current.mcp.servers
      return [
        ...Object.keys(sv).map((name) => ({ kind: 'server' as const, name })),
        { kind: 'custom' as const },
        ...MCP_PRESETS.map((_, index) => ({ kind: 'preset' as const, index })).filter((r) => !sv[MCP_PRESETS[r.index]!.name]),
      ]
    })()
    const i = Math.min(idxR.current, rowsNow.length - 1)
    const row = rowsNow[i]

    if (screen === 'name' || screen === 'command') {
      if (key.escape) {
        setScreen('list')
        setText('')
        return
      }
      if (key.return) {
        const t = textR.current.trim()
        if (screen === 'name') {
          if (!NAME_RE.test(t)) return setMsg({ text: 'Name: letters, digits, "-" or "_".', err: true })
          if (cfgR.current.mcp.servers[t]) return setMsg({ text: `"${t}" already exists.`, err: true })
          draftR.current = t
          setText('')
          setMsg(null)
          return setScreen('command')
        }
        const parsed = serverFromInput(t)
        if (typeof parsed === 'string') return setMsg({ text: parsed, err: true })
        add(draftR.current, parsed)
        setText('')
        return setScreen('list')
      }
      if (key.backspace || key.delete) return setText((s) => s.slice(0, -1))
      if (raw && !key.ctrl && !key.meta && raw >= ' ') setText((s) => s + raw.replace(/[\r\n]/g, ''))
      return
    }
    if (screen === 'confirm') {
      if ((raw === 'y' || raw === 'Y') && row?.kind === 'server') {
        const { [row.name]: _gone, ...rest } = cfgR.current.mcp.servers
        setServers(rest)
        setIdx(0)
      }
      return setScreen('list')
    }
    if (screen === 'tools') {
      if (key.escape || key.return) setScreen('list')
      return
    }

    if (key.escape) return onClose()
    if (key.upArrow) return setIdx(Math.max(0, i - 1))
    if (key.downArrow) return setIdx(Math.min(rowsNow.length - 1, i + 1))
    if (!row) return
    if (key.return) {
      if (row.kind === 'custom') {
        setText('')
        setMsg(null)
        return setScreen('name')
      }
      if (row.kind === 'preset') {
        const p = MCP_PRESETS[row.index]!
        return add(p.name, p.config)
      }
      return setScreen('tools')
    }
    if (row.kind !== 'server') return
    if (raw === 't') {
      const cur = cfgR.current.mcp.servers[row.name]!
      return setServers({ ...cfgR.current.mcp.servers, [row.name]: { ...cur, enabled: cur.enabled === false } })
    }
    if (raw === 'r') {
      setMsg({ text: `reconnecting ${row.name}…`, err: false })
      return void hub.reconnect(row.name).then(() => setTick((t) => t + 1))
    }
    if (raw === 'd') return setScreen('confirm')
  })

  if (screen === 'name' || screen === 'command') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          Add an MCP server {screen === 'command' ? `· ${draftR.current}` : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{screen === 'name' ? 'Name (e.g. docs):' : 'Command line or URL — e.g. npx -y @modelcontextprotocol/server-memory  ·  https://mcp.example.com/mcp'}</Text>
          <Text>
            <Text color={theme.brand}>▸ </Text>
            {text}
            <Text inverse> </Text>
          </Text>
        </Box>
        {msg ? <Text color={msg.err ? theme.err : theme.ok}>{msg.text}</Text> : null}
        <Text dimColor>Secrets: list vault names in "secretEnv" / "bearerSecret" in the config — never paste a token here.</Text>
        <Text dimColor>Enter next · Esc cancel</Text>
      </Box>
    )
  }

  const selRow = rows[sel]
  if (screen === 'tools' && selRow?.kind === 'server') {
    const v = selRow.view
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          {v.name} <Text color={STATUS_COLOR[v.status]}>{v.status}</Text>
          <Text color={theme.muted}> · {v.config.url ?? [v.config.command, ...(v.config.args ?? [])].join(' ')}</Text>
        </Text>
        {v.error ? <Text color={theme.err}>{v.error}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {hub.tools().filter((t) => t.name.startsWith(`mcp__${v.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`)).slice(0, maxRows).map((t) => (
            <Text key={t.name} wrap="truncate-end">
              <Text color={t.readonly ? theme.ok : theme.warn}>{t.readonly ? 'read ' : 'write'}</Text> {t.name.split('__').slice(2).join('__')}
              <Text color={theme.muted}> — {t.description.replace(/^\[MCP [^\]]*\]\s*/, '')}</Text>
            </Text>
          ))}
        </Box>
        <Text dimColor>read = safe in PLAN mode and for questions · write = BUILD only · Esc back</Text>
      </Box>
    )
  }
  if (screen === 'confirm' && selRow?.kind === 'server') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} marginBottom={1}>
        <Text bold color={theme.warn}>
          Remove MCP server “{selRow.view.name}”?
        </Text>
        <Text dimColor>y = remove · any other key = cancel</Text>
      </Box>
    )
  }

  const start = windowStart(sel, maxRows, rows.length)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
      <Text bold color={theme.brand}>
        MCP servers <Text color={theme.muted}>· external tools for the agent</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.slice(start, start + maxRows).map((r, k) => {
          const at = start + k === sel
          const ptr = at ? '▸ ' : '  '
          if (r.kind === 'custom') {
            return (
              <Text key="custom" inverse={at}>
                {ptr}
                <Text color={theme.brand}>+ Custom server</Text>
                <Text color={theme.muted}> — any command line or URL</Text>
              </Text>
            )
          }
          if (r.kind === 'preset') {
            const p = MCP_PRESETS[r.index]!
            return (
              <Text key={p.name} inverse={at} wrap="truncate-end">
                {ptr}
                <Text color={theme.muted}>+ {p.label} — {p.note}</Text>
              </Text>
            )
          }
          const v = r.view
          return (
            <Text key={v.name} inverse={at} wrap="truncate-end">
              {ptr}
              <Text color={STATUS_COLOR[v.status]}>{v.status === 'disabled' ? '○' : glyph.dot} </Text>
              <Text bold>{v.name}</Text>
              <Text color={theme.muted}> · {v.status === 'ready' ? `${v.tools} tools` : v.status}</Text>
              {v.error ? <Text color={theme.err}> · {v.error}</Text> : null}
            </Text>
          )
        })}
      </Box>
      {msg ? <Text color={msg.err ? theme.err : theme.ok}>{msg.text}</Text> : null}
      <Text dimColor>Enter open / add · t on/off · r reconnect · d remove · Esc close</Text>
    </Box>
  )
}
