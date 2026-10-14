import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { McpClient, expand } from '../src/mcp/client.js'
import { McpHub, mcpToolName } from '../src/mcp/hub.js'
import { toolDefinitions, toolsFor } from '../src/tools/registry.js'

const server = join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs')
const stdioCfg = { command: process.execPath, args: [server] }

const clients: McpClient[] = []
const hubs: McpHub[] = []
afterAll(() => {
  for (const c of clients) c.close()
  for (const h of hubs) h.closeAll()
})

describe('MCP client (stdio)', () => {
  it('connects, lists tools (ignoring log lines on stdout) and calls them', async () => {
    const c = new McpClient('fixture', stdioCfg)
    clients.push(c)
    await c.connect()
    expect(c.error).toBe('')
    expect(c.status).toBe('ready')
    expect(c.tools.map((t) => t.name)).toEqual(['echo', 'add', 'boom'])
    expect(c.tools[0]!.readOnly).toBe(true)
    expect(c.tools[1]!.readOnly).toBe(false)
    expect(await c.call('echo', { text: 'hi' })).toEqual({ ok: true, text: 'echo: hi' })
    expect(await c.call('add', { a: 2, b: 3 })).toEqual({ ok: true, text: '5' })
    expect(await c.call('boom', {})).toEqual({ ok: false, text: 'it broke' })
  })

  it('reports a server that cannot start, without throwing', async () => {
    const c = new McpClient('bad', { command: process.execPath, args: ['-e', 'process.exit(3)'] })
    clients.push(c)
    await c.connect()
    expect(c.status).toBe('error')
    expect(c.error).toMatch(/exited|code 3/)
    expect((await c.call('x', {})).ok).toBe(false)
  })

  it('reports a missing secret by NAME, never a value', async () => {
    const c = new McpClient('s', { ...stdioCfg, secretEnv: ['MY_TOKEN'] })
    clients.push(c)
    await c.connect()
    expect(c.status).toBe('error')
    expect(c.error).toContain('MY_TOKEN')
  })

  it('injects vault secrets into the server environment', async () => {
    const c = new McpClient('s2', { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,error:{message:"tok="+process.env.MY_TOKEN}})+"\\n");setTimeout(()=>{},2000)'], secretEnv: ['MY_TOKEN'] }, { MY_TOKEN: 'abc123' })
    clients.push(c)
    await c.connect()
    expect(c.error).toContain('tok=abc123')
  })

  it('expands ${NAME} from secrets, then the environment, else leaves it', () => {
    process.env['VARA_TEST_ENV_X'] = 'fromenv'
    expect(expand('a ${S} b ${VARA_TEST_ENV_X} c ${NOPE_ZZ}', { S: 'sec' })).toBe('a sec b fromenv c ${NOPE_ZZ}')
  })
})

describe('MCP client (HTTP)', () => {
  it('speaks JSON and SSE responses and keeps the session id', async () => {
    const seen: Array<{ method: string; session: string | undefined; auth: string | undefined }> = []
    const http = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        if (req.method !== 'POST') return res.writeHead(200).end()
        const m = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } }
        seen.push({ method: m.method, session: req.headers['mcp-session-id'] as string | undefined, auth: req.headers['authorization'] as string | undefined })
        if (m.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1' })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'http-fixture' } } }))
        }
        if (m.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } })}\n\n`)
        }
        if (m.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } }))
        }
        res.writeHead(202).end()
      })
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
    const port = (http.address() as { port: number }).port
    const c = new McpClient('remote', { url: `http://127.0.0.1:${port}/mcp`, bearerSecret: 'TOK' }, { TOK: 'sekret' })
    clients.push(c)
    await c.connect()
    expect(c.error).toBe('')
    expect(c.serverName).toBe('http-fixture')
    expect(c.tools.map((t) => t.name)).toEqual(['ping'])
    expect(await c.call('ping', {})).toEqual({ ok: true, text: 'pong' })
    expect(seen.find((s) => s.method === 'tools/list')!.session).toBe('S1')
    expect(seen[0]!.auth).toBe('Bearer sekret')
    await new Promise((r) => http.close(r))
  })
})

describe('MCP hub → agent tools', () => {
  it('exposes namespaced tools with raw schemas; read-only ones survive PLAN mode and questions', async () => {
    const hub = new McpHub()
    hubs.push(hub)
    await hub.sync({ fixture: stdioCfg })
    const tools = hub.tools()
    expect(tools.map((t) => t.name)).toEqual(['mcp__fixture__echo', 'mcp__fixture__add', 'mcp__fixture__boom'])

    const build = toolsFor('task', 'build', { extra: tools })
    expect(build.map((t) => t.name)).toContain('mcp__fixture__add')
    const plan = toolsFor('task', 'plan', { extra: tools })
    expect(plan.map((t) => t.name)).toContain('mcp__fixture__echo')
    expect(plan.map((t) => t.name)).not.toContain('mcp__fixture__add')
    expect(toolsFor('question', 'build', { extra: tools }).map((t) => t.name)).not.toContain('mcp__fixture__add')
    expect(toolsFor('chat', 'build', { extra: tools }).map((t) => t.name)).not.toContain('mcp__fixture__echo')

    // The model sees the server's own JSON schema.
    const defs = toolDefinitions('build', 'task', { extra: tools }) as Array<{ function: { name: string; parameters: { required?: string[] } } }>
    const add = defs.find((d) => d.function.name === 'mcp__fixture__add')!
    expect(add.function.parameters.required).toEqual(['a', 'b'])

    const result = await tools[1]!.execute({ a: 40, b: 2 } as never, {} as never)
    expect(result).toEqual({ ok: true, output: '42' })
    expect(hub.summary()).toContain('fixture')
    expect(hub.summary()).toContain('mcp__fixture__<tool>')
  })

  it('syncs: disabled and removed servers go away; a failing one does not hurt the rest', async () => {
    const hub = new McpHub()
    hubs.push(hub)
    await hub.sync({ good: stdioCfg, broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] }, off: { ...stdioCfg, enabled: false } })
    const view = hub.view({ good: stdioCfg, broken: { command: 'x' }, off: { ...stdioCfg, enabled: false } })
    expect(view.find((v) => v.name === 'good')).toMatchObject({ status: 'ready', tools: 3 })
    expect(view.find((v) => v.name === 'broken')!.status).toBe('error')
    expect(view.find((v) => v.name === 'off')!.status).toBe('disabled')
    expect(hub.tools().length).toBe(3)
    await hub.sync({})
    expect(hub.tools().length).toBe(0)
  })

  it('names are API-safe and bounded', () => {
    expect(mcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it')
    expect(mcpToolName('s', 'x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})
