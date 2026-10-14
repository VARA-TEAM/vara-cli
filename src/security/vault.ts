import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { vaultDir } from '../config/paths.js'

const execFileAsync = promisify(execFile)

export interface SecretRef {
  name: string
  /** Where this secret is visible: 'session:<id>', 'project:<path>', or 'global'. */
  scope: string
  hint: string
}

interface StoredSecret extends SecretRef {
  iv: string
  tag: string
  data: string
}

/**
 * Secret vault.
 *
 * - Values are encrypted at rest with AES-256-GCM.
 * - The master key never sits in plaintext on disk: on Windows it is wrapped by
 *   DPAPI (CurrentUser), on macOS by the login keychain, elsewhere by a 0600 file
 *   (weaker; a warning is returned to the caller).
 * - Values are injected into the environment of the one process that needs them,
 *   and are registered with the redactor so they can never reach logs or the
 *   transcript.
 */

let masterKey: Buffer | null = null
const secretsFile = () => join(vaultDir, 'secrets.json')
const masterFile = () => join(vaultDir, 'master.key')

async function loadSecrets(): Promise<StoredSecret[]> {
  if (!existsSync(secretsFile())) return []
  const raw = await readFile(secretsFile(), 'utf8')
  return JSON.parse(raw) as StoredSecret[]
}

async function writeSecrets(list: StoredSecret[]): Promise<void> {
  await mkdir(vaultDir, { recursive: true })
  await writeFile(secretsFile(), JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Environment for the Windows PowerShell 5.1 child. When VARA is launched from
 * PowerShell 7 (pwsh), `PSModulePath` points at PowerShell 7's modules and 5.1
 * cannot load its own Security module ("ConvertTo-SecureString … could not be
 * loaded"). Dropping the variable lets 5.1 use its default module path.
 */
function powershellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['PSModulePath']
  delete env['PSMODULEPATH']
  return env
}

async function wrapWithDpapi(key: Buffer): Promise<string> {
  const hex = key.toString('hex')
  const ps = `ConvertTo-SecureString -AsPlainText -Force '${hex}' | ConvertFrom-SecureString`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
    windowsHide: true,
    env: powershellEnv(),
  })
  return stdout.trim()
}

async function unwrapWithDpapi(blob: string): Promise<Buffer> {
  const ps = `$s = ConvertTo-SecureString '${blob}'; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
    windowsHide: true,
    env: powershellEnv(),
  })
  return Buffer.from(stdout.trim(), 'hex')
}

async function wrapWithMacKeychain(key: Buffer): Promise<string> {
  await execFileAsync('security', [
    'add-generic-password',
    '-s',
    'vara-vault',
    '-a',
    'master',
    '-w',
    key.toString('hex'),
  ])
  return 'KEYCHAIN'
}

async function unwrapWithMacKeychain(): Promise<Buffer> {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'vara-vault', '-w'])
  return Buffer.from(stdout.trim(), 'hex')
}

/**
 * Returns the 32-byte master key, creating it on first use.
 * Also reports how the key is protected so the UI can warn on weak platforms.
 */
export async function getMasterKey(): Promise<{ key: Buffer; protection: string }> {
  if (masterKey) return { key: masterKey, protection: 'cached' }
  await mkdir(vaultDir, { recursive: true })

  // First-time creation must be race-safe: two VARA processes starting together
  // (two terminals, a host and a TUI, parallel tests) must end up with the SAME
  // key — otherwise whichever wrote second makes the other's secrets unreadable.
  // So creation is exclusive ("wx" / no -U), and the loser reads the winner's key.

  if (process.platform === 'win32') {
    const read = async (): Promise<Buffer> => unwrapWithDpapi(await readFile(masterFile(), 'utf8'))
    if (existsSync(masterFile())) {
      masterKey = await read()
      return { key: masterKey, protection: 'windows-dpapi' }
    }
    const key = randomBytes(32)
    try {
      await writeFile(masterFile(), await wrapWithDpapi(key), { encoding: 'utf8', flag: 'wx' })
      masterKey = key
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      masterKey = await readWhenComplete(read)
    }
    return { key: masterKey, protection: 'windows-dpapi' }
  }

  if (process.platform === 'darwin') {
    try {
      masterKey = await unwrapWithMacKeychain()
      return { key: masterKey, protection: 'macos-keychain' }
    } catch {
      const key = randomBytes(32)
      try {
        await wrapWithMacKeychain(key)
        masterKey = key
      } catch (err) {
        // Someone else created it between our read and our add: use theirs.
        if (!/already exists/i.test(String((err as Error).message))) throw err
        masterKey = await readWhenComplete(unwrapWithMacKeychain)
      }
      return { key: masterKey, protection: 'macos-keychain' }
    }
  }

  // Linux / other: file-based fallback (weaker — we surface this to the user).
  const readFileKey = async (): Promise<Buffer> => Buffer.from((await readFile(masterFile(), 'utf8')).trim(), 'hex')
  if (existsSync(masterFile())) {
    masterKey = await readWhenComplete(readFileKey)
    return { key: masterKey, protection: 'file-0600 (weak)' }
  }
  const key = randomBytes(32)
  try {
    await writeFile(masterFile(), key.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    masterKey = key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    masterKey = await readWhenComplete(readFileKey)
  }
  await chmod(masterFile(), 0o600).catch(() => {})
  return { key: masterKey, protection: 'file-0600 (weak)' }
}

/** The winner of a creation race may still be writing: retry briefly until a full 32-byte key is readable. */
async function readWhenComplete(read: () => Promise<Buffer>): Promise<Buffer> {
  let last: unknown
  for (let i = 0; i < 20; i++) {
    try {
      const key = await read()
      if (key.length === 32) return key
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw last instanceof Error ? last : new Error('the secret vault key could not be read')
}

export async function setSecret(name: string, value: string, scope = 'global'): Promise<SecretRef> {
  const { key } = await getMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const list = await loadSecrets()
  const next: StoredSecret = {
    name,
    scope,
    hint: `${value.slice(0, 2)}…${'•'.repeat(Math.min(8, Math.max(2, value.length - 2)))}`,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  }
  const idx = list.findIndex((s) => s.name === name && s.scope === scope)
  if (idx >= 0) list[idx] = next
  else list.push(next)
  await writeSecrets(list)
  return { name, scope, hint: next.hint }
}

/** Returns secrets visible to the given scope, decrypted. Never log the result. */
export async function getSecretsForScope(scope: string): Promise<Record<string, string>> {
  const list = await loadSecrets()
  // Nothing stored: do not unlock the master key (on Windows that starts PowerShell, ~1 s cold).
  if (list.length === 0) return {}
  const { key } = await getMasterKey()
  const out: Record<string, string> = {}
  for (const s of list) {
    if (s.scope !== 'global' && s.scope !== scope) continue
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'))
    const value = Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()])
    out[s.name] = value.toString('utf8')
  }
  return out
}

export async function listSecrets(): Promise<SecretRef[]> {
  const list = await loadSecrets()
  return list.map(({ name, scope, hint }) => ({ name, scope, hint }))
}

export async function deleteSecret(name: string, scope = 'global'): Promise<boolean> {
  const list = await loadSecrets()
  const next = list.filter((s) => !(s.name === name && s.scope === scope))
  if (next.length === list.length) return false
  await writeSecrets(next)
  return true
}
