import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline, safeHref, type Block, type Inline } from '../ui/src/md'
import { buildItems, changedFiles, formatCost, formatTokens, relativeTime, toolSummary } from '../ui/src/transcript'
import { parseSse } from '../ui/src/api'
import { dictionariesForTest, keys, translate } from '../ui/src/i18n'
import { THEMES, findTheme } from '../ui/src/theme'

const flat = (inl: Inline[]): string => inl.map((i) => (i.t === 'text' || i.t === 'code' ? i.v : flat(i.c))).join('')

describe('web markdown — inline', () => {
  it('bold, italic, code, strike and links', () => {
    const r = parseInline('a **bold** and *it* and `x < y` and ~~old~~ and [docs](https://x.dev/a)')
    expect(r.map((n) => n.t)).toEqual(['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'link'])
    expect(r[5]).toEqual({ t: 'code', v: 'x < y' })
    expect(r[9]).toMatchObject({ t: 'link', href: 'https://x.dev/a' })
  })

  it('the exact case from the TUI screenshot: quotes inside bold', () => {
    const r = parseInline('- **"hello"** - just saying hi')
    expect(r[1]).toMatchObject({ t: 'strong' })
    expect(flat(r)).toBe('- "hello" - just saying hi')
  })

  it('leaves unfinished markers (a streaming message) as text', () => {
    expect(flat(parseInline('half **bold and `code'))).toBe('half **bold and `code')
  })

  it('does not treat snake_case or math as emphasis', () => {
    expect(parseInline('read_file_tool and 2 * 3 * 4')).toEqual([{ t: 'text', v: 'read_file_tool and 2 * 3 * 4' }])
  })

  it('only http(s) and mailto links are clickable; others render as plain text', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('https://a.b')).toBe('https://a.b')
    const unsafe = parseInline('[click](javascript:alert(1))')
    expect(unsafe.some((n) => n.t === 'link')).toBe(false)
    expect(flat(unsafe).startsWith('click')).toBe(true)
  })

  it('auto-links bare URLs without swallowing trailing punctuation', () => {
    const r = parseInline('see https://example.com/a?b=1.')
    expect(r[1]).toMatchObject({ t: 'link', href: 'https://example.com/a?b=1' })
    expect(flat(r)).toBe('see https://example.com/a?b=1.')
  })

  it('handles backslash escapes', () => {
    expect(flat(parseInline('\\*not italic\\*'))).toBe('*not italic*')
  })
})

describe('web markdown — blocks', () => {
  it('headings, paragraphs, rules', () => {
    const b = parseBlocks('# Title\n\nSome text\nsecond line\n\n---\n\n### Sub')
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'hr', 'h'])
    expect(b[0]).toMatchObject({ t: 'h', level: 1 })
  })

  it('code fences keep their content verbatim, including blank lines and markdown', () => {
    const b = parseBlocks('```ts\nconst a = **1**\n\nconst b = 2\n```\nafter')
    expect(b[0]).toEqual({ t: 'code', lang: 'ts', v: 'const a = **1**\n\nconst b = 2' })
    expect(b[1]).toMatchObject({ t: 'p' })
  })

  it('an unclosed fence (still streaming) shows what has arrived', () => {
    expect(parseBlocks('```js\nlet x')[0]).toEqual({ t: 'code', lang: 'js', v: 'let x' })
  })

  it('nested and ordered lists', () => {
    const b = parseBlocks('- one\n  - nested a\n  - nested b\n- two\n\n3. third\n4. fourth')
    const ul = b[0] as Extract<Block, { t: 'list' }>
    expect(ul.items).toHaveLength(2)
    expect(ul.items[0]!.children[0]).toMatchObject({ t: 'list', ordered: false })
    expect((ul.items[0]!.children[0] as Extract<Block, { t: 'list' }>).items).toHaveLength(2)
    const ol = b[1] as Extract<Block, { t: 'list' }>
    expect(ol).toMatchObject({ ordered: true, start: 3 })
  })

  it('tables with alignment', () => {
    const b = parseBlocks('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |')
    expect(b[0]).toMatchObject({ t: 'table', align: ['left', 'right'] })
    expect((b[0] as Extract<Block, { t: 'table' }>).rows).toHaveLength(2)
    // The single-dash centred separator the models like to write.
    const c = parseBlocks('| a | b | c |\n| :-: | :-- | --: |\n| 1 | 2 | 3 |')
    expect(c[0]).toMatchObject({ t: 'table', align: ['center', 'left', 'right'] })
  })

  it('blockquotes can contain blocks', () => {
    const b = parseBlocks('> quoted **text**\n> - item')
    expect(b[0]).toMatchObject({ t: 'quote' })
    expect((b[0] as Extract<Block, { t: 'quote' }>).blocks.map((x) => x.t)).toEqual(['p', 'list'])
  })

  it('never produces markup from raw HTML — it stays text', () => {
    const b = parseBlocks('<script>alert(1)</script>')
    expect(b).toEqual([{ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] }])
  })

  it('survives garbage and huge input quickly', () => {
    const t0 = Date.now()
    parseBlocks(('*'.repeat(500) + '\n' + '['.repeat(500) + '\n' + '`'.repeat(500) + '\n').repeat(40))
    parseBlocks('a '.repeat(50_000))
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})

describe('chat model from a snapshot', () => {
  const view = {
    transcript: [
      { role: 'user', content: 'hello', at: 't1' },
      { role: 'user', content: '[from Noor] what about tests?\n\n[attached files]\n<file>x</file>', at: 't2' },
      { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }, { id: 'c2', name: 'write_file', arguments: '{"path":"new.txt","content":"x"}' }], at: 't3' },
      { role: 'tool', content: '[OK] 12 lines', toolCallId: 'c1', toolName: 'read_file', at: 't4' },
      { role: 'tool', content: '[FAIL] denied', toolCallId: 'c2', toolName: 'write_file', at: 't5' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'edit_file', arguments: '{"path":"src/a.ts"}' }], at: 't6' },
    ],
  } as never

  it('builds user/assistant/tool items with attribution and outcomes', () => {
    const items = buildItems(view)
    expect(items.map((i) => i.kind)).toEqual(['user', 'user', 'assistant', 'tool', 'tool', 'tool'])
    expect(items[1]).toMatchObject({ author: 'Noor', text: 'what about tests?' })
    expect(items[3]).toMatchObject({ name: 'read_file', ok: true, output: '12 lines' })
    expect(items[4]).toMatchObject({ ok: false, output: 'denied' })
    expect(items[5]).toMatchObject({ name: 'edit_file' }) // still running: no output yet
    expect((items[5] as { output?: string }).output).toBeUndefined()
  })

  it('lists changed files once, new before edited', () => {
    expect(changedFiles(view)).toEqual([{ path: 'new.txt', op: 'new' }, { path: 'src/a.ts', op: 'edit' }])
  })

  it('summarises tool calls on one line', () => {
    expect(toolSummary({ name: 'shell', arguments: '{"command":"npm test"}' })).toBe('$ npm test')
    expect(toolSummary({ name: 'read_file', arguments: '{"path":"a.ts"}' })).toBe('a.ts')
    expect(toolSummary({ name: 'delegate', arguments: '{"tasks":[{},{}]}' })).toBe('2 sub-agents')
    expect(toolSummary({ name: 'x', arguments: 'not json' })).toBe('not json')
  })

  it('formats money, tokens and time honestly (unknown stays unknown)', () => {
    expect(formatCost(null)).toBeNull()
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(1.5, true)).toBe('$1.50+')
    expect(formatTokens(null)).toBe('?')
    expect(formatTokens(128_000)).toBe('128k')
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h')
  })
})

describe('SSE parsing', () => {
  it('splits frames across chunk boundaries and keeps ids', () => {
    let { frames, rest } = parseSse('id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b"')
    expect(frames).toEqual([{ id: 1, data: '{"a":1}' }])
    ;({ frames, rest } = parseSse(rest + ':2}\n\n: ping\n\n'))
    expect(frames).toEqual([{ id: 2, data: '{"b":2}' }])
  })
})

describe('translations and themes', () => {
  it('Arabic has every key English has, and none is empty', () => {
    for (const k of keys) {
      expect(dictionariesForTest.ar[k], k).toBeTruthy()
      expect(dictionariesForTest.en[k], k).toBeTruthy()
    }
    expect(translate('ar', 'newSession')).not.toBe(translate('en', 'newSession'))
  })

  it('every theme defines every colour, and the default exists', () => {
    for (const t of THEMES) for (const [k, v] of Object.entries(t)) expect(v, `${t.id}.${k}`).not.toBe('')
    expect(findTheme('nope').id).toBe('vara')
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
  })
})

describe('attached files in a user message', () => {
  it('lists images and files after the marker and hides them from the text', async () => {
    const { buildItems, attachedOf } = await import('../ui/src/transcript')
    const body = 'what is this\n\n[attached files]\n<image id="0123456789abcdef.png" name="shot.png"/>\n<file name="a.txt">\nhi\n</file>'
    const [item] = buildItems({ transcript: [{ role: 'user', content: body, at: 'x' }] })
    expect(item).toMatchObject({ kind: 'user', text: 'what is this', images: [{ id: '0123456789abcdef.png', name: 'shot.png' }], files: ['a.txt'] })
    expect(attachedOf('<image id="../x.png" name="n"/>').images).toEqual([])
  })
})
