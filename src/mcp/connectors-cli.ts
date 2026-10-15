import { createInterface } from 'node:readline'
import { loadConfig, persistConfig } from '../config/config.js'
import { listSecrets, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import { CONNECTORS, connectorServer, findConnector } from './connectors.js'

/** Ask for a secret without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const w = rl as unknown as { _writeToOutput: (s: string) => void }
    let muted = false
    const original = w._writeToOutput.bind(rl)
    w._writeToOutput = (s: string) => original(muted ? '' : s)
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
    muted = true
  })
}

/** `vara connectors [list | add <id> | remove <id>]` — the same catalogue as the web Settings → Connectors tab. */
export async function connectorsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list'
  const config = await loadConfig()
  const have = new Set((await listSecrets()).map((s) => s.name))
  if (sub === 'list') {
    for (const c of CONNECTORS) {
      const added = config.mcp.servers[c.id] ? (config.mcp.servers[c.id]!.enabled === false ? 'off ' : 'on  ') : '    '
      const need = c.secrets.filter((s) => !have.has(s.name)).map((s) => s.name)
      console.log(`${added} ${c.id.padEnd(20)} ${c.category.padEnd(10)} ${c.description}`)
      if (!config.mcp.servers[c.id] && need.length) console.log(`${' '.repeat(36)}needs: ${need.join(', ')}`)
    }
    console.log('\nAdd one: vara connectors add <id>   ·   remove: vara connectors remove <id>')
    return
  }
  const id = args[1]
  const c = id ? findConnector(id) : undefined
  if (!c) throw new Error(`Usage: vara connectors list | add <id> | remove <id>${id ? `\nUnknown connector "${id}". See: vara connectors list` : ''}`)
  if (sub === 'add') {
    if (config.mcp.servers[c.id]) throw new Error(`${c.name} is already connected.`)
    for (const s of c.secrets) {
      if (have.has(s.name)) continue
      console.log(`${s.label}\n  ${s.help}`)
      const v = await askHidden(`${s.name}: `)
      if (!v) throw new Error('No value given — nothing was added.')
      await setSecret(s.name, v)
      registerSecret(v, s.name)
    }
    await persistConfig({ ...config, mcp: { ...config.mcp, servers: { ...config.mcp.servers, [c.id]: connectorServer(c) as never } } })
    console.log(`${c.name} added. It connects the next time VARA starts (or reopen /mcp in a running one).`)
    return
  }
  if (sub === 'remove') {
    if (!config.mcp.servers[c.id]) throw new Error(`${c.name} is not connected.`)
    const { [c.id]: _gone, ...rest } = config.mcp.servers
    await persistConfig({ ...config, mcp: { ...config.mcp, servers: rest } })
    console.log(`${c.name} removed. Its secrets stay in the vault (vara secret delete <NAME> to remove them).`)
    return
  }
  throw new Error('Usage: vara connectors list | add <id> | remove <id>')
}
