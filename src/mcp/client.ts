import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * A small, dependency-free Model Context Protocol client.
 * Transports: stdio (newline-delimited JSON-RPC) and streamable HTTP
 * (JSON or SSE responses). Only what an agent needs: initialize, tools/list,
 * tools/call.
 */

export interface McpServerConfig {
  /** Command + args for a local (stdio) server. */
  command?: string
  args?: string[]
  /** Plain environment for the server process (no secrets here — see secretEnv). */
  env?: Record<string, string>
  /** Vault secret names injected as environment variables into the process. */
  secretEnv?: string[]
  cwd?: string
  /** URL of a remote (streamable HTTP) server. */
  url?: string
  /** Vault secret sent as `Authorization: Bearer …` to a remote server. */
  bearerSecret?: string
  /** Signed in with OAuth (vara connectors login <name>): the token comes from the vault and is refreshed automatically. */
  oauth?: boolean
  headers?: Record<string, string>
  enabled?: boolean
  /** Per-call timeout; default 120 s. */
  timeoutMs?: number
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export interface McpCallResult {
  ok: boolean
  text: string
}

export type McpStatus = 'disabled' | 'connecting' | 'ready' | 'error'

const PROTOCOL_VERSION = '2025-03-26'
const INIT_TIMEOUT_MS = 30_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Bearer token supplier for OAuth-signed-in servers. */
export type TokenProvider = (force: boolean) => Promise<string | undefined>

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): void
  /** Last diagnostic output (stderr / HTTP error), for error messages. */
  diagnostics(): string
}

/** JSON-RPC error → Error with the server's message. */
function rpcError(method: string, err: { message?: string; code?: number }): Error {
  return new Error(`${method}: ${err.message ?? 'server error'}${err.code !== undefined ? ` (code ${err.code})` : ''}`)
}

/** Windows cannot spawn `npx`/`npm`/`uvx` shims without a shell. */
function needsShell(command: string): boolean {
  return process.platform === 'win32' && !/\.exe$/i.test(command)
}

function quoteForShell(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private stderr = ''
  private closed = false

  constructor(command: string, args: string[], env: Record<string, string>, cwd?: string) {
    const shell = needsShell(command)
    this.child = spawn(shell ? quoteForShell(command) : command, shell ? args.map(quoteForShell) : args, {
      env,
      cwd,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2_000)
    })
    this.child.on('error', (err) => this.failAll(new Error(`could not start "${command}": ${err.message}`)))
    this.child.on('exit', (code) => {
      this.failAll(new Error(`server exited${code !== null ? ` (code ${code})` : ''}${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`))
    })
    // A server closing its stdin pipe must never crash VARA.
    this.child.stdin.on('error', () => {})
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // servers may print logs on stdout; ignore non-JSON lines
      }
      if (msg.id !== undefined && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(rpcError('request', msg.error))
        else p.resolve(msg.result)
      } else if (msg.id !== undefined && msg.method) {
        // Server → client request (sampling, roots…): we support none of them.
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by this client' } })
      }
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      /* the exit handler reports it */
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: no answer after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('closed'))
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      /* already gone */
    }
  }

  diagnostics(): string {
    return this.stderr.trim()
  }
}

class HttpTransport implements Transport {
  private nextId = 1
  private sessionId = ''
  private lastError = ''

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    /** OAuth: the current bearer token (`force` = refresh first, after a 401). */
    private readonly tokens?: TokenProvider,
  ) {}

  private async send(body: unknown, timeoutMs: number, force: boolean): Promise<Response> {
    const auth: Record<string, string> = {}
    if (this.tokens) {
      const t = await this.tokens(force)
      if (!t) throw new Error('not signed in — run: vara connectors login <name>')
      auth['authorization'] = `Bearer ${t}`
    }
    return fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
        ...auth,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    const res = await this.send(body, timeoutMs, false)
    // An expired or revoked token: refresh once and retry the same request.
    if (res.status === 401 && this.tokens) return this.send(body, timeoutMs, true)
    return res
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    let res: Response
    try {
      res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    } catch (err) {
      this.lastError = (err as Error).message
      throw new Error(`${method}: ${(err as Error).name === 'TimeoutError' ? `no answer after ${Math.round(timeoutMs / 1000)}s` : this.lastError}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await res.text()
    if (!res.ok) {
      this.lastError = `HTTP ${res.status} ${text.slice(0, 200)}`
      throw new Error(`${method}: ${this.lastError}`)
    }
    const type = res.headers.get('content-type') ?? ''
    const messages: Array<{ id?: number; result?: unknown; error?: { message?: string; code?: number } }> = []
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\n\n+/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          messages.push(JSON.parse(data))
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        const parsed = JSON.parse(text) as unknown
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]))
      } catch {
        throw new Error(`${method}: the server did not return JSON`)
      }
    }
    const mine = messages.find((m) => m.id === id)
    if (!mine) throw new Error(`${method}: no response from the server`)
    if (mine.error) throw rpcError(method, mine.error)
    return mine.result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, 10_000)
    } catch {
      /* notifications are best effort */
    }
  }

  close(): void {
    if (!this.sessionId) return
    void fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'mcp-session-id': this.sessionId }, signal: AbortSignal.timeout(3_000) }).catch(() => {})
  }

  diagnostics(): string {
    return this.lastError
  }
}

export class McpClient {
  status: McpStatus = 'connecting'
  error = ''
  tools: McpToolInfo[] = []
  serverName = ''
  private transport: Transport | null = null

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
    /** Resolved secrets (name → value) for secretEnv / bearerSecret. */
    private readonly secrets: Record<string, string> = {},
    /** For `oauth` servers. */
    private readonly tokens?: TokenProvider,
  ) {}

  async connect(): Promise<void> {
    this.status = 'connecting'
    this.error = ''
    try {
      this.transport = this.makeTransport()
      const init = (await this.transport.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'vara', version: '0.1.0' } },
        INIT_TIMEOUT_MS,
      )) as { serverInfo?: { name?: string } }
      this.serverName = init?.serverInfo?.name ?? ''
      await this.transport.notify('notifications/initialized')
      this.tools = await this.listTools()
      this.status = 'ready'
    } catch (err) {
      this.status = 'error'
      const diag = this.transport?.diagnostics()
      this.error = `${(err as Error).message}${diag && !(err as Error).message.includes(diag.slice(-40)) ? ` — ${diag.split('\n').pop()}` : ''}`
      this.transport?.close()
      this.transport = null
    }
  }

  private makeTransport(): Transport {
    if (this.cfg.url) {
      const headers: Record<string, string> = { ...(this.cfg.headers ?? {}) }
      for (const [k, v] of Object.entries(headers)) headers[k] = expand(v, this.secrets)
      const token = this.cfg.bearerSecret ? this.secrets[this.cfg.bearerSecret] : undefined
      if (this.cfg.bearerSecret && !token) throw new Error(`secret ${this.cfg.bearerSecret} is not in the vault (vara secret set ${this.cfg.bearerSecret})`)
      if (token) headers['authorization'] = `Bearer ${token}`
      if (this.cfg.oauth && !this.tokens) throw new Error('OAuth sign-in is not available here')
      return new HttpTransport(expand(this.cfg.url, this.secrets), headers, this.cfg.oauth ? this.tokens : undefined)
    }
    if (!this.cfg.command) throw new Error('the server needs a "command" or a "url"')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(this.cfg.env ?? {}) }
    for (const name of this.cfg.secretEnv ?? []) {
      const v = this.secrets[name]
      if (!v) throw new Error(`secret ${name} is not in the vault (vara secret set ${name})`)
      env[name] = v
    }
    return new StdioTransport(this.cfg.command, (this.cfg.args ?? []).map((a) => expand(a, this.secrets)), env, this.cfg.cwd)
  }

  private async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = (await this.transport!.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT_MS)) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>
        nextCursor?: string
      }
      for (const t of res.tools ?? []) {
        out.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          readOnly: t.annotations?.readOnlyHint === true,
        })
      }
      cursor = res.nextCursor
      if (!cursor) break
    }
    return out
  }

  async call(tool: string, args: unknown): Promise<McpCallResult> {
    if (!this.transport || this.status !== 'ready') return { ok: false, text: `MCP server "${this.name}" is not connected${this.error ? ` (${this.error})` : ''}` }
    try {
      const res = (await this.transport.request('tools/call', { name: tool, arguments: args ?? {} }, this.cfg.timeoutMs ?? 120_000)) as {
        content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>
        isError?: boolean
        structuredContent?: unknown
      }
      const parts: string[] = []
      for (const c of res.content ?? []) {
        if (c.type === 'text' && c.text) parts.push(c.text)
        else if (c.type === 'resource' && c.resource) parts.push(c.resource.text ?? `[resource ${c.resource.uri ?? ''}]`)
        else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type} ${c.mimeType ?? ''} omitted]`)
      }
      if (!parts.length && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent))
      return { ok: !res.isError, text: parts.join('\n') || (res.isError ? 'the tool reported an error' : '(no output)') }
    } catch (err) {
      return { ok: false, text: (err as Error).message }
    }
  }

  close(): void {
    this.transport?.close()
    this.transport = null
    if (this.status === 'ready' || this.status === 'connecting') this.status = 'disabled'
  }
}

/** `${NAME}` → env var or vault secret; unknown names stay literal. */
export function expand(text: string, secrets: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => secrets[name] ?? process.env[name] ?? m)
}
