import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { proposalsDir } from '../config/paths.js'
import { scrubSystem } from '../security/redact.js'
import { discoverSkills, validSkillName, writeSkill } from './skills.js'

/**
 * Skill proposals: after real multi-step work the agent may SUGGEST a new or improved skill. A proposal is
 * only a JSON file under ~/.vara/proposals; it is never loaded as a skill. The owner reads it (TUI
 * `/skills proposals`, the browser's Skills page, `vara skills proposals`) and approves or rejects it.
 * Approving writes the skill with the same function the owner-approved `skill_write` tool uses.
 */

export interface SkillProposal {
  id: string
  name: string
  scope: 'user' | 'project'
  description: string
  body: string
  /** Why the agent thinks this is worth keeping (what task it came from). */
  reason: string
  cwd: string
  sessionId: string
  createdAt: string
  /** A skill of this name already exists: approving replaces its text. */
  replaces: 'none' | 'builtin' | 'user' | 'project'
}

export const MAX_PENDING = 20
export const MAX_PER_SESSION = 3
export const MAX_BODY = 8000

const ID_RE = /^[0-9a-f]{8}$/

export async function listProposals(): Promise<SkillProposal[]> {
  if (!existsSync(proposalsDir)) return []
  const out: SkillProposal[] = []
  for (const f of await readdir(proposalsDir)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await readFile(join(proposalsDir, f), 'utf8')) as SkillProposal)
    } catch {
      /* a damaged file must not hide the rest */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getProposal(id: string): Promise<SkillProposal | null> {
  if (!ID_RE.test(id)) return null
  try {
    return JSON.parse(await readFile(join(proposalsDir, `${id}.json`), 'utf8')) as SkillProposal
  } catch {
    return null
  }
}

export interface ProposalInput {
  name: string
  scope: 'user' | 'project'
  description: string
  body: string
  reason: string
  cwd: string
  sessionId: string
}

/** Validate and queue a proposal. Throws a readable message when it is refused. */
export async function createProposal(input: ProposalInput): Promise<SkillProposal> {
  const name = input.name.trim().toLowerCase()
  if (!validSkillName(name)) throw new Error('Skill name: lowercase letters, digits, "-" or "_" (max 40).')
  const description = input.description.replace(/\s+/g, ' ').trim().slice(0, 300)
  const body = input.body.replace(/\r\n/g, '\n').trim()
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!description) throw new Error('A skill needs a one-line description (when to use it).')
  if (!body) throw new Error('A skill cannot be empty.')
  if (body.length > MAX_BODY) throw new Error(`A proposed skill body is limited to ${MAX_BODY} characters; keep it a short playbook.`)
  for (const t of [description, body, reason]) {
    if (scrubSystem(t) !== t) throw new Error('The proposal contains something that looks like a secret (key, token, password). Remove it and propose again.')
  }
  const pending = await listProposals()
  if (pending.length >= MAX_PENDING) throw new Error('Too many proposals are waiting for the owner. Do not propose more now.')
  if (pending.filter((p) => p.sessionId === input.sessionId).length >= MAX_PER_SESSION) throw new Error(`At most ${MAX_PER_SESSION} proposals per session.`)
  if (pending.some((p) => p.name === name && p.cwd === input.cwd && p.scope === input.scope)) throw new Error('A proposal with this name is already waiting for the owner.')
  const existing = (await discoverSkills(input.cwd)).find((s) => s.name === name)
  const proposal: SkillProposal = {
    id: randomUUID().slice(0, 8),
    name,
    scope: input.scope,
    description,
    body,
    reason,
    cwd: input.cwd,
    sessionId: input.sessionId,
    createdAt: new Date().toISOString(),
    replaces: existing ? existing.source : 'none',
  }
  await mkdir(proposalsDir, { recursive: true })
  await writeFile(join(proposalsDir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), 'utf8')
  return proposal
}

/** Owner approves: the skill is written and the proposal removed. */
export async function approveProposal(id: string): Promise<{ path: string; created: boolean; proposal: SkillProposal }> {
  const p = await getProposal(id)
  if (!p) throw new Error(`No proposal ${id}.`)
  const r = await writeSkill(p.name, p.scope, p.cwd, p.description, p.body)
  await rm(join(proposalsDir, `${id}.json`), { force: true })
  return { ...r, proposal: p }
}

export async function rejectProposal(id: string): Promise<boolean> {
  if (!ID_RE.test(id) || !existsSync(join(proposalsDir, `${id}.json`))) return false
  await rm(join(proposalsDir, `${id}.json`), { force: true })
  return true
}
