import { addNote, memoryFile, readNotes, removeNote, replaceNote, type MemoryScope } from './core/memory.js'
import { approveProposal, getProposal, listProposals, rejectProposal } from './core/proposals.js'

export const MEMORY_USAGE = `vara memory — notes that persist between sessions (turn on with config.memory.enabled)

  vara memory [list] [--user|--project]     show the notes (default: both) and where the files are
  vara memory add "<note>" [--user]         add a note (default scope: project, i.e. this folder)
  vara memory edit <n> "<note>" [--user]    change note n
  vara memory remove <n> [--user]           delete note n
You can also edit the files by hand: ~/.vara/memory/MEMORY.md and <project>/.vara/memory.md (one "- note" per line).`

export async function memoryCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const scopeOf = (): MemoryScope => (args.includes('--user') ? 'user' : 'project')
  const rest = args.filter((a) => !a.startsWith('--'))
  const sub = rest[0] ?? 'list'
  if (sub === 'list') {
    const scopes: MemoryScope[] = args.includes('--user') ? ['user'] : args.includes('--project') ? ['project'] : ['user', 'project']
    for (const s of scopes) {
      const notes = readNotes(s, cwd)
      console.log(`${s}  (${memoryFile(s, cwd)})${notes.length ? '' : '  — none'}`)
      notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}`))
    }
    return
  }
  if (sub === 'add') {
    if (!rest[1]) throw new Error('Usage: vara memory add "<note>" [--user]')
    const r = addNote(scopeOf(), cwd, rest[1])
    console.log(r.added ? `Saved (${r.total} notes).` : 'Already noted.')
    return
  }
  if (sub === 'edit') {
    if (!rest[1] || !rest[2]) throw new Error('Usage: vara memory edit <n> "<note>" [--user]')
    replaceNote(scopeOf(), cwd, Number(rest[1]), rest[2])
    console.log('Changed.')
    return
  }
  if (sub === 'remove') {
    if (!rest[1]) throw new Error('Usage: vara memory remove <n> [--user]')
    console.log(`Removed: ${removeNote(scopeOf(), cwd, Number(rest[1]))}`)
    return
  }
  console.log(MEMORY_USAGE)
}

export const SKILLS_USAGE = `vara skills — the agent's skill proposals (turn on with config.skills.propose); nothing is installed until you approve

  vara skills proposals            list what is waiting
  vara skills show <id>            read a proposal in full
  vara skills approve <id>         install it (a new skill, or an update of the one it names)
  vara skills reject <id>          throw it away`

export async function skillsCommand(args: string[]): Promise<void> {
  const [sub, id] = args
  if (sub === 'proposals' || sub === 'list') {
    const all = await listProposals()
    if (!all.length) return console.log('No proposals waiting.')
    for (const p of all) console.log(`${p.id}  ${p.name}  [${p.scope}${p.replaces !== 'none' ? `, replaces ${p.replaces}` : ''}]  ${p.description}\n           ${p.cwd}  ·  ${p.reason}`)
    return
  }
  if (sub === 'show') {
    const p = id ? await getProposal(id) : null
    if (!p) throw new Error('No such proposal. See: vara skills proposals')
    console.log(`${p.name} [${p.scope}${p.replaces !== 'none' ? `, replaces the ${p.replaces} skill` : ''}]\nwhen: ${p.description}\nwhy: ${p.reason}\nfolder: ${p.cwd}\n\n${p.body}`)
    return
  }
  if (sub === 'approve') {
    if (!id) throw new Error('Usage: vara skills approve <id>')
    const r = await approveProposal(id)
    console.log(`${r.created ? 'Installed' : 'Updated'} ${r.proposal.name}: ${r.path}`)
    return
  }
  if (sub === 'reject') {
    if (!id) throw new Error('Usage: vara skills reject <id>')
    console.log((await rejectProposal(id)) ? 'Rejected.' : 'No such proposal.')
    return
  }
  console.log(SKILLS_USAGE)
}
