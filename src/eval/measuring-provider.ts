import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../llm/provider.js'
import type { NormalizedUsage } from '../llm/usage.js'

/**
 * The measuring fake provider shared by the offline cost benchmark
 * (tests/bench/scenarios.ts) and `vara eval --offline`. It returns scripted
 * turns and records what VARA SENT (sizes, simulated cache), never what a model
 * would have done. The provider cache is SIMULATED: longest common prefix with
 * the previous request to the same model, 1024-token minimum.
 */
export interface RequestStat {
  model: string
  totalTokens: number
  cachedTokens: number
  outputTokens: number
  kind: 'work' | 'chat' | 'summary'
}

const MIN_CACHEABLE_CHARS = 4096

export class BenchProvider implements Provider {
  id = 'anthropic' as const
  stats: RequestStat[] = []
  private last = new Map<string, string[]>()
  private n = 0
  constructor(private readonly script: Array<AssistantTurn | ((req: ProviderRequest, n: number) => AssistantTurn)>, private readonly summaryText = 'GOAL fix the parser. DONE: read and edited files. OPEN: nothing.') {}

  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const items = [req.system, JSON.stringify(req.tools), ...req.messages.map((m) => JSON.stringify(m))]
    const total = items.reduce((n, s) => n + s.length, 0)
    const prev = this.last.get(req.model)
    let prefix = 0
    if (prev) {
      for (let i = 0; i < Math.min(prev.length, items.length); i++) {
        if (prev[i] === items[i]) prefix += items[i]!.length
        else {
          const a = prev[i]!
          const b = items[i]!
          let k = 0
          while (k < a.length && k < b.length && a[k] === b[k]) k++
          prefix += k
          break
        }
      }
    }
    this.last.set(req.model, items)
    const cachedChars = prefix >= MIN_CACHEABLE_CHARS ? prefix : 0

    const isSummary = req.system.includes('compress the working history')
    let turn: AssistantTurn
    if (isSummary) turn = { content: this.summaryText, toolCalls: [] }
    else {
      const next = this.script.shift()
      turn = typeof next === 'function' ? next(req, this.n) : (next ?? { content: 'done', toolCalls: [] })
      this.n++
    }
    const outChars = turn.content.length + turn.toolCalls.reduce((n, c) => n + c.arguments.length + c.name.length + 20, 0)
    const stat: RequestStat = {
      model: req.model,
      totalTokens: Math.ceil(total / 4),
      cachedTokens: Math.floor(cachedChars / 4),
      outputTokens: Math.ceil(outChars / 4),
      kind: isSummary ? 'summary' : req.system.includes('# Session Type') ? 'work' : 'chat',
    }
    this.stats.push(stat)
    const usage: NormalizedUsage = {
      inputTokens: stat.totalTokens - stat.cachedTokens,
      outputTokens: stat.outputTokens,
      cachedInputTokens: stat.cachedTokens,
      cacheWriteTokens: null,
      reportedTotalInputTokens: stat.totalTokens,
      source: 'provider',
      complete: true,
    }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn, usage }
  }
}
