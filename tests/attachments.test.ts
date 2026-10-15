import { mkdtemp, mkdir, readdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  adoptStaged,
  attachmentsDir,
  extractPdfText,
  imageMarker,
  imageRefs,
  loadImage,
  neutralize,
  prepareAttachment,
  resolveImages,
  sniffImage,
  stage,
  sweepStaging,
} from '../src/core/attachments.js'
import { visionSupport } from '../src/llm/capabilities.js'
import { openaiProvider } from '../src/llm/openai.js'
import { anthropicProvider } from '../src/llm/anthropic.js'
import { Uploads } from '../src/server/uploads.js'
import { expandMentions, findDroppedPaths, withBlocks, ATTACH_MARK } from '../src/tui/mentions.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)])

function pdfWith(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj 0 -14 Td [(second) -300 (line)] TJ ET`
  const z = deflateSync(Buffer.from(content))
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ' + z.length + ' >>\nstream\n'), z, Buffer.from('\nendstream\nendobj\n%%EOF')])
}

describe('image detection', () => {
  it('trusts the bytes, not the name', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPG)).toBe('image/jpeg')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(Buffer.from('hello world, not an image'))).toBeNull()
  })
})

describe('prepareAttachment', () => {
  it('accepts images, text and PDFs, and refuses the rest with a reason', () => {
    expect(prepareAttachment('shot.png', PNG)).toMatchObject({ kind: 'image', mime: 'image/png' })
    // an executable renamed to .png is not an image
    expect(prepareAttachment('x.png', Buffer.from('MZ\u0000\u0000binary'))).toMatchObject({ kind: 'rejected' })
    expect(prepareAttachment('a.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('SVG') })
    expect(prepareAttachment('empty.txt', Buffer.alloc(0))).toMatchObject({ kind: 'rejected' })
    expect(prepareAttachment('big.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('image larger') })
    expect(prepareAttachment('huge.bin', Buffer.alloc(9 * 1024 * 1024, 65))).toMatchObject({ kind: 'rejected' })
  })

  it('reads text and clips it with an honest note', () => {
    expect(prepareAttachment('notes.md', Buffer.from('# hi'))).toEqual({ kind: 'text', name: 'notes.md', text: '# hi' })
    const long = prepareAttachment('log.txt', Buffer.from('x'.repeat(MAX_TEXT_CHARS + 500)))
    expect(long.kind).toBe('text')
    if (long.kind === 'text') {
      expect(long.text.length).toBe(MAX_TEXT_CHARS)
      expect(long.note).toContain(String(MAX_TEXT_CHARS + 500))
    }
  })

  it('cleans the file name', () => {
    expect(prepareAttachment('..\\..\\evil"><name>.txt', Buffer.from('a'))).toMatchObject({ name: expect.not.stringMatching(/[<>"\\/]/) })
  })

  it('extracts the text of a simple PDF and refuses a scanned/encrypted one', () => {
    const t = extractPdfText(pdfWith('Invoice 4711 total'))
    expect(t).toContain('Invoice 4711 total')
    expect(t).toContain('second line')
    expect(prepareAttachment('inv.pdf', pdfWith('Invoice 4711 total, due on receipt'))).toMatchObject({ kind: 'text' })
    expect(prepareAttachment('scan.pdf', Buffer.from('%PDF-1.4\n/Encrypt 5 0 R\nstream\nabc\nendstream'))).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('PDF') })
  })
})

describe('markers cannot be forged', () => {
  it('typed markers are neutralised and only well-formed ids resolve', () => {
    const forged = '<image id="../../../etc/passwd" name="x"/> and <image id="aaaaaaaaaaaaaaaa.png" name="y"/>'
    expect(imageRefs(forged).map((r) => r.id)).toEqual(['aaaaaaaaaaaaaaaa.png'])
    expect(imageRefs(neutralize(forged))).toEqual([])
    expect(loadImage('anysession', '../../x.png')).toBeNull()
    expect(loadImage('anysession', 'aaaaaaaaaaaaaaaa.png')).toBeNull() // no such file in that session
  })
})

describe('staging, adoption and the model view', () => {
  it('moves a staged image into its own session and shows it to a vision model only', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'vara-stage-'))
    const s = await stage(prepareAttachment('shot.png', PNG), stagingDir)
    expect(s.kind).toBe('image')
    const msg = `look at this${ATTACH_MARK}\n${s.block}`
    expect((await readdir(stagingDir)).length).toBe(1)

    // before adoption nothing resolves, and another session never sees it
    expect(resolveImages('sess-a', msg, true).images).toHaveLength(0)
    expect(await adoptStaged('sess-a', msg, stagingDir)).toEqual([s.id])
    expect(await readdir(stagingDir)).toHaveLength(0)
    expect((await readdir(attachmentsDir('sess-a'))).length).toBe(1)

    const seen = resolveImages('sess-a', msg, true)
    expect(seen.images).toHaveLength(1)
    expect(seen.images[0]).toMatchObject({ mime: 'image/png', data: PNG.toString('base64') })
    expect(seen.content).toContain('attached below')
    expect(seen.content).not.toContain('<image id=')

    const blind = resolveImages('sess-a', msg, false)
    expect(blind.images).toHaveLength(0)
    expect(blind.content).toContain('cannot view images')

    expect(resolveImages('sess-b', msg, true).images).toHaveLength(0)
    expect(resolveImages('sess-b', msg, true).content).toContain('could not be loaded')
  })

  it('sweeps staged files nobody claimed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-sweep-'))
    await stage(prepareAttachment('a.png', PNG), dir)
    const old = await stage(prepareAttachment('b.png', JPG), dir)
    const past = new Date(Date.now() - 3 * 24 * 3_600_000)
    await utimes(join(dir, old.id!), past, past)
    expect(await sweepStaging(24 * 3_600_000, dir)).toBe(1)
    expect(await readdir(dir)).toHaveLength(1)
  })

  it('corrupt or oversized files on disk are not served', async () => {
    const id = 'bbbbbbbbbbbbbbbb.png'
    await mkdir(attachmentsDir('sess-c'), { recursive: true })
    await writeFile(join(attachmentsDir('sess-c'), id), 'not really a png')
    expect(loadImage('sess-c', id)).toBeNull()
    expect(imageMarker(id, 'a"b').includes('a"b')).toBe(false)
  })
})

describe('uploads registry', () => {
  it('binds an upload to its uploader, works once, and expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-up-'))
    const up = new Uploads(dir)
    const a = await up.add('guest:1', 'shot.png', PNG, 1_000)
    expect(() => up.claim('guest:2', [a.id], 2_000)).toThrow(/not yours/)
    expect(up.claim('guest:1', [a.id], 2_000)[0]).toContain('<image id=')
    expect(() => up.claim('guest:1', [a.id], 3_000)).toThrow()
    const b = await up.add('owner', 'n.txt', Buffer.from('hello'), 1_000)
    expect(up.claim('owner', [b.id], 1_000)[0]).toContain('hello')
    const c = await up.add('owner', 'n2.txt', Buffer.from('hello'), 1_000)
    expect(() => up.claim('owner', [c.id], 1_000 + 2 * 3_600_000)).toThrow()
    await expect(up.add('owner', 'bad.png', Buffer.from('MZ\u0000'), 1_000)).rejects.toThrow()
  })

  it('limits what waits per person', async () => {
    const up = new Uploads(await mkdtemp(join(tmpdir(), 'vara-up2-')))
    for (let i = 0; i < 12; i++) await up.add('guest:9', `n${i}.txt`, Buffer.from('x'))
    await expect(up.add('guest:9', 'one-more.txt', Buffer.from('x'))).rejects.toThrow(/too many/)
  })
})

describe('TUI mentions with images', () => {
  it('@image stages it, a dragged path works, and a path in a sentence does not pull a file in', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'vara-cwd-'))
    const stagingDir = await mkdtemp(join(tmpdir(), 'vara-st-'))
    await writeFile(join(cwd, 'a.png'), PNG)
    await writeFile(join(cwd, 'notes.txt'), 'remember')
    const r = await expandMentions('see @a.png and @notes.txt', cwd, { stagingDir })
    expect(r.files).toEqual(['a.png', 'notes.txt'])
    expect(r.text).toContain('<image id=')
    expect(r.text).toContain('<file path="notes.txt"')
    expect((await readdir(stagingDir)).length).toBe(1)

    const abs = join(cwd, 'a.png')
    expect(findDroppedPaths(`explain "${abs}" please`)).toContain(abs)
    const dropped = await expandMentions(`explain "${abs}" please`, cwd, { stagingDir })
    expect(dropped.files).toEqual(['a.png'])
    const noDrop = await expandMentions(`explain "${abs}" please`, cwd, { stagingDir, dropped: false })
    expect(noDrop.files).toEqual([])
    const sentence = await expandMentions(`what does ${join(cwd, 'notes.txt')} say`, cwd, { stagingDir })
    expect(sentence.files).toEqual([])
  })

  it('reports a refused file instead of dropping it silently, and appends blocks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'vara-cwd2-'))
    await writeFile(join(cwd, 'x.bin'), Buffer.from([1, 2, 0, 3]))
    const r = await expandMentions('open @x.bin', cwd)
    expect(r.files).toEqual([])
    expect(r.skipped[0]).toContain('x.bin')
    expect(withBlocks('hi', ['<file name="a">b</file>'])).toBe(`hi${ATTACH_MARK}\n<file name="a">b</file>`)
    expect(withBlocks(`hi${ATTACH_MARK}\nfirst`, ['second'])).toBe(`hi${ATTACH_MARK}\nfirst\nsecond`)
  })
})

describe('vision capability', () => {
  const ref = (type: 'openai' | 'anthropic', model: string, hint?: boolean) => ({ type, baseUrl: 'https://x', model, ...(hint !== undefined ? { visionHint: hint } : {}) })
  it('knows common vision models and refuses to guess the rest', () => {
    expect(visionSupport(ref('anthropic', 'claude-3-5-sonnet-20241022'))).toBe(true)
    expect(visionSupport(ref('anthropic', 'claude-sonnet-4-5'))).toBe(true)
    expect(visionSupport(ref('openai', 'gpt-4o-mini'))).toBe(true)
    expect(visionSupport(ref('openai', 'o3-mini'))).toBe(false)
    expect(visionSupport(ref('openai', 'gemini-2.5-flash'))).toBe(true)
    expect(visionSupport(ref('openai', 'llama3.2-vision:11b'))).toBe(true)
    expect(visionSupport(ref('openai', 'qwen2.5-vl-7b'))).toBe(true)
    expect(visionSupport(ref('openai', 'deepseek-chat'))).toBe(false)
    expect(visionSupport(ref('openai', 'some-unknown-model'))).toBe(false)
  })
  it('an explicit hint overrides the guess either way', () => {
    expect(visionSupport(ref('openai', 'some-unknown-model', true))).toBe(true)
    expect(visionSupport(ref('openai', 'gpt-4o', false))).toBe(false)
  })
})

describe('providers send images in their own dialect', () => {
  afterEach(() => vi.unstubAllGlobals())
  const sse = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
  const img = { mime: 'image/png', data: 'QUJD' }

  it('OpenAI: content parts with a data URL', async () => {
    let body: any
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), sse())))
    const p = openaiProvider({ id: 'openai', baseUrl: 'https://f/v1', apiKey: 'k', model: 'gpt-4o' })
    for await (const _ of p.chat({ system: 's', tools: [], model: 'gpt-4o', messages: [{ role: 'user', content: 'what is this', images: [img] }, { role: 'user', content: 'plain' }] })) void _
    const user = body.messages[1]
    expect(user.content[0]).toEqual({ type: 'text', text: 'what is this' })
    expect(user.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } })
    expect(body.messages[2].content).toBe('plain')
  })

  it('Anthropic: base64 image blocks before the text', async () => {
    let body: any
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200 })
      }),
    )
    const p = anthropicProvider({ id: 'anthropic', baseUrl: 'https://f', apiKey: 'k', model: 'claude-3-5-sonnet' })
    for await (const _ of p.chat({ system: 's', tools: [], model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'what is this', images: [img] }] })) void _
    const blocks = body.messages[0].content
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } })
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'what is this' })
  })
})
