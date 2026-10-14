// A tiny MCP server over stdio, for tests: tools `echo` (read-only), `add` and `boom`.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
console.log('this line is a log, not JSON-RPC')
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
      { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
    ] } })
  } else if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params
    if (name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } })
    else if (name === 'add') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } })
    else send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } })
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } })
  }
})
