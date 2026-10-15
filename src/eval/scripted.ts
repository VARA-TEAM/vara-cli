import type { AssistantTurn, Provider } from '../llm/provider.js'
import { BenchProvider } from './measuring-provider.js'
import type { EvalTask } from './tasks.js'

/** The model id the offline run reports and prices (a registry model, so cost is computed from SIMULATED token counts). */
export const OFFLINE_MODEL = 'claude-3-5-sonnet'

const call = (id: string, name: string, args: unknown): AssistantTurn['toolCalls'][number] => ({ id, name, arguments: JSON.stringify(args) })
const turn = (...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ content: '', toolCalls: calls })

/**
 * The scripted "model" for a task: the same fixed turns in every arm, so an arm
 * that sends less is leaner for an identical conversation, not "smarter".
 * look around -> read -> run the check (fails) -> apply the reference edits -> run the check -> claim completion.
 * It measures what VARA sends; it says NOTHING about how a real model behaves.
 */
export function scriptedProvider(task: EvalTask): BenchProvider & Provider {
  const turns: AssistantTurn[] = []
  const reads = task.readWindow
    ? [call('r0', 'read_file', { path: task.readWindow.path, offset: task.readWindow.offset, limit: task.readWindow.limit })]
    : task.reads.map((p, i) => call(`r${i}`, 'read_file', { path: p }))
  turns.push(turn(call('l0', 'list_dir', { path: '.' }), ...reads))
  turns.push(turn(call('c1', 'shell', { command: task.checkCommand })))
  turns.push(turn(...task.solution.map((e, i) => call(`e${i}`, 'edit_file', { path: e.path, oldString: e.oldString, newString: e.newString }))))
  turns.push(turn(call('c2', 'shell', { command: task.checkCommand })))
  turns.push({ content: '', toolCalls: [call('done', 'complete', { summary: `Fixed: ${task.title}`, verificationPlan: `ran ${task.checkCommand}, all cases passed`, verifiedRequirements: ['1'] })] })
  return new BenchProvider(turns)
}
