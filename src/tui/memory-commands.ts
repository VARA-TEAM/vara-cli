import { addNote, memoryFile, readNotes, removeNote, replaceNote, type MemoryScope } from '../core/memory.js'
import { approveProposal, getProposal, listProposals, rejectProposal } from '../core/proposals.js'
import type { MemorySettings } from '../config/config.js'

export interface Reply {
  text: string
  error?: boolean
  /** Set when the command changed the memory switch (the caller saves the config). */
  enable?: boolean
  /** Set when a skill was installed or updated (the caller refreshes its list). */
  skillsChanged?: boolean
}

/** `/memory …` — shared by the terminal; the browser calls the same core functions through /api/manage/memory. */
export function memoryReply(args: string[], cwd: string, mem: MemorySettings): Reply {
  const [sub, ...rest] = args
  if (sub === 'on' || sub === 'off') {
    return { text: sub === 'on' ? `memory on: saved notes go into the prompt (up to ${mem.maxTokens} tokens) and the agent gets a memory tool` : 'memory off: nothing is injected; your files stay as they are', enable: sub === 'on' }
  }
  const scope: MemoryScope = rest.includes('user') ? 'user' : 'project'
  const words = rest.filter((w) => w !== 'user' && w !== 'project')
  try {
    if (sub === 'add') {
      const r = addNote(scope, cwd, words.join(' '))
      return { text: r.added ? `saved to ${scope} memory (${r.total} notes)` : 'already noted' }
    }
    if (sub === 'edit') {
      replaceNote(scope, cwd, Number(words[0]), words.slice(1).join(' '))
      return { text: 'changed' }
    }
    if (sub === 'remove') return { text: `removed: ${removeNote(scope, cwd, Number(words[0]))}` }
  } catch (err) {
    return { text: (err as Error).message, error: true }
  }
  const show = (s: MemoryScope): string => {
    const n = readNotes(s, cwd)
    return `${s} (${memoryFile(s, cwd)})${n.length ? '\n' + n.map((x, i) => `  ${i + 1}. ${x}`).join('\n') : ' — none'}`
  }
  return {
    text: `Memory is ${mem.enabled ? 'ON' : 'OFF'} (agent writes: ${mem.agentWrites}, prompt budget ${mem.maxTokens} tokens)\n${show('project')}\n${show('user')}\n\n/memory add [user] <note> · edit [user] <n> <note> · remove [user] <n> · on|off — or edit the files by hand`,
  }
}

/** `/skills proposals|show|approve|reject` */
export async function proposalReply(args: string[]): Promise<Reply> {
  const [sub, id] = args
  try {
    if (sub === 'proposals') {
      const all = await listProposals()
      if (!all.length) return { text: 'no skill proposals waiting' }
      const rows = all.map((p) => `  ${p.id}  ${p.name} [${p.scope}${p.replaces !== 'none' ? `, replaces ${p.replaces}` : ''}] ${p.description}`)
      return { text: `Skills the agent proposed (nothing is installed until you approve):\n${rows.join('\n')}\n\n/skills show <id> · approve <id> · reject <id>` }
    }
    if (sub === 'show') {
      const p = id ? await getProposal(id) : null
      return p ? { text: `${p.name} [${p.scope}]\nwhen: ${p.description}\nwhy: ${p.reason}\n\n${p.body}` } : { text: 'no such proposal', error: true }
    }
    if (sub === 'approve') {
      const r = await approveProposal(id ?? '')
      return { text: `${r.created ? 'installed' : 'updated'} ${r.proposal.name}`, skillsChanged: true }
    }
    return (await rejectProposal(id ?? '')) ? { text: 'rejected' } : { text: 'no such proposal', error: true }
  } catch (err) {
    return { text: (err as Error).message, error: true }
  }
}
