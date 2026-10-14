import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'

let workdir: string
let Engine: typeof import('../src/core/engine.js').Engine
let SessionRunner: typeof import('../src/core/runner.js').SessionRunner
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput

class FakeProvider implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest)
    const turn = this.script.shift() ?? { content: 'fallback reply', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const toolNames = (req: ProviderRequest) => req.tools.map((t) => (t as { function: { name: string } }).function.name).sort()

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-intent-'))
  const sessionModule = await import('../src/core/session.js')
  createSession = sessionModule.createSession
  CreateSessionInput = sessionModule.CreateSessionInput
  Engine = (await import('../src/core/engine.js')).Engine
  SessionRunner = (await import('../src/core/runner.js')).SessionRunner
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function autoSession(objective: string) {
  return createSession(CreateSessionInput.parse({ objective, cwd: workdir, auto: true }), DEFAULT_CONFIG)
}

describe('engine — intent routing', () => {
  it('a typo/greeting gets ONE reply and the session is ready (no repeated answers)', async () => {
    const session = autoSession('hellp')
    const provider = new FakeProvider([{ content: 'Hi! What should we work on?', toolCalls: [] }])
    const engine = new Engine({ session, provider })
    await engine.run()
    expect(provider.requests).toHaveLength(1)
    expect(session.state).toBe('ready')
    expect(session.intent).toBe('chat')
    // The user's words reach the model as a real message (they used to be missing).
    expect(provider.requests[0]!.messages[0]).toMatchObject({ role: 'user', content: 'hellp' })
    // Chat gets no work tools.
    expect(toolNames(provider.requests[0]!)).toEqual(['escalate'])
  })

  it('a question may read the project, then ends on the text answer', async () => {
    const session = autoSession('what files are in this folder?')
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'q1', name: 'list_dir', arguments: JSON.stringify({ path: '.' }) }] },
      { content: 'The folder is empty.', toolCalls: [] },
    ])
    await new Engine({ session, provider }).run()
    expect(session.intent).toBe('question')
    expect(session.state).toBe('ready')
    expect(provider.requests).toHaveLength(2)
    const tools = toolNames(provider.requests[0]!)
    expect(tools).toContain('read_file')
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('complete')
  })

  it('refuses a write tool during a conversation turn', async () => {
    const session = autoSession('hi')
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'no' }) }] },
      { content: 'Hello!', toolCalls: [] },
    ])
    await new Engine({ session, provider }).run()
    const toolMsg = session.transcript.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/not available while answering/)
    expect(session.state).toBe('ready')
  })

  it('escalate turns the conversation into a verified task', async () => {
    const session = autoSession('the login page is broken')
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'e1', name: 'escalate', arguments: JSON.stringify({ to: 'task', objective: 'Fix the login page', reason: 'user reports a bug' }) }] },
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'login.txt', content: 'fixed' }) }] },
      { content: 'Done.', toolCalls: [{ id: 'c1', name: 'complete', arguments: JSON.stringify({ summary: 'Fixed the login page', verificationPlan: 'checked file', verifiedRequirements: ['1'] }) }] },
    ])
    await new Engine({ session, provider }).run()
    expect(session.config.objective).toBe('Fix the login page')
    expect(session.intent).toBe('task')
    expect(session.state).toBe('completed')
    // After escalating, the work tools are offered.
    expect(toolNames(provider.requests[1]!)).toContain('write_file')
  })

  it('a clear task starts working immediately; a goal switches kind', async () => {
    const task = autoSession('create a file named notes.txt')
    const p1 = new FakeProvider([{ content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: 'Which content should it have?' }) }] }])
    await new Engine({ session: task, provider: p1 }).run()
    expect(task.intent).toBe('task')
    expect(toolNames(p1.requests[0]!)).toContain('write_file')

    const goal = autoSession('keep the tests passing and monitor them')
    const p2 = new FakeProvider([{ content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: 'Which test command?' }) }] }])
    await new Engine({ session: goal, provider: p2 }).run()
    expect(goal.intent).toBe('goal')
    expect(goal.config.kind).toBe('goal')
  })

  it('a text-only turn during work gets an explicit nudge instead of a silent re-ask', async () => {
    const session = autoSession('create a file named a.txt')
    const provider = new FakeProvider([
      { content: 'I will create it now.', toolCalls: [] },
      { content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: 'Any content?' }) }] },
    ])
    await new Engine({ session, provider }).run()
    const second = provider.requests[1]!.messages.filter((m) => !m.content.startsWith('[STATE]')).at(-1)!
    expect(second.content).toMatch(/\[ENGINE\] Your reply had no tool call/)
  })

  it('after a chat, a new request in the same session becomes the objective', async () => {
    const session = autoSession('hello')
    const provider = new FakeProvider([
      { content: 'Hi!', toolCalls: [] },
      { content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: 'Which framework?' }) }] },
    ])
    const runner = new SessionRunner(session, provider, undefined, () => {})
    await runner.start()
    expect(session.state).toBe('ready')
    runner.send('build a todo app in react')
    await runner.start()
    expect(session.intent).toBe('task')
    expect(session.config.objective).toBe('build a todo app in react')
    expect(session.activeRequirements).toEqual(['The stated objective is achieved and verified: build a todo app in react'])
    expect(provider.requests[1]!.messages.filter((m) => !m.content.startsWith('[STATE]')).at(-1)).toMatchObject({ role: 'user', content: 'build a todo app in react' })
  })

  it('a pinned session (auto off) keeps its kind even for a greeting', async () => {
    const session = createSession(CreateSessionInput.parse({ objective: 'hello', cwd: workdir, kind: 'task' }), DEFAULT_CONFIG)
    const provider = new FakeProvider([{ content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: 'What should I build?' }) }] }])
    await new Engine({ session, provider }).run()
    expect(session.intent).toBe('task')
  })

  it('skills are listed in the prompt and loadable through the skill tool', async () => {
    const session = autoSession('review my last change please')
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 's', name: 'skill', arguments: JSON.stringify({ name: 'code-review' }) }] },
      { content: 'Looks fine.', toolCalls: [] },
    ])
    const { BUILTIN_SKILLS } = await import('../src/core/builtin-skills.js')
    await new Engine({ session, provider, loadSkills: async () => BUILTIN_SKILLS }).run()
    expect(provider.requests[0]!.system).toContain('code-review:')
    const loaded = session.transcript.find((m) => m.role === 'tool' && m.toolName === 'skill')
    expect(loaded?.content).toContain('# Code review')
  })
})
