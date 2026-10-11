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

async function wrapWithDpapi(key: Buffer): Promise<string> {
  const hex = key.toString('hex')
  const ps = `ConvertTo-SecureString -AsPlainText -Force '${hex}' | ConvertFrom-SecureString`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
    windowsHide: true,
  })
  return stdout.trim()
}

async function unwrapWithDpapi(blob: string): Promise<Buffer> {
  const ps = `$s = ConvertTo-SecureString '${blob}'; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
    windowsHide: true,
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
    '-U',
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

  if (process.platform === 'win32') {
    if (existsSync(masterFile())) {
      masterKey = await unwrapWithDpapi(await readFile(masterFile(), 'utf8'))
      return { key: masterKey, protection: 'windows-dpapi' }
    }
    const key = randomBytes(32)
    await writeFile(masterFile(), await wrapWithDpapi(key), 'utf8')
    masterKey = key
    return { key, protection: 'windows-dpapi' }
  }

  if (process.platform === 'darwin') {
    try {
      masterKey = await unwrapWithMacKeychain()
      return { key: masterKey, protection: 'macos-keychain' }
    } catch {
      const key = randomBytes(32)
      await wrapWithMacKeychain(key)
      masterKey = key
      return { key, protection: 'macos-keychain' }
    }
  }

  // Linux / other: file-based fallback (weaker — we surface this to the user).
  if (existsSync(masterFile())) {
    masterKey = Buffer.from((await readFile(masterFile(), 'utf8')).trim(), 'hex')
    return { key: masterKey, protection: 'file-0600 (weak)' }
  }
  const key = randomBytes(32)
  await writeFile(masterFile(), key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  await chmod(masterFile(), 0o600)
  masterKey = key
  return { key, protection: 'file-0600 (weak)' }
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
  const { key } = await getMasterKey()
  const list = await loadSecrets()
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
