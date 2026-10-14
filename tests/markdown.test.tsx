import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Markdown, parseBlocks, parseInline } from '../src/tui/markdown.js'

describe('markdown', () => {
  it('parses inline styles', () => {
    expect(parseInline('a **bold** and `code` and *it* and [lnk](http://x.y)')).toEqual([
      { text: 'a ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'code', code: true },
      { text: ' and ' },
      { text: 'it', italic: true },
      { text: ' and ' },
      { text: 'lnk', link: true },
    ])
    // Unclosed markers (a half-streamed message) stay literal.
    expect(parseInline('half **bold')).toEqual([{ text: 'half **bold' }])
    // Underscores inside identifiers are not italics.
    expect(parseInline('read_file_tool')).toEqual([{ text: 'read_file_tool' }])
  })

  it('parses blocks', () => {
    const blocks = parseBlocks('# Title\n\n- one\n  - nested\n1. first\n> quote\n```ts\nconst a = 1\n```\n---')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'blank', 'bullet', 'bullet', 'bullet', 'quote', 'code', 'rule'])
    expect(blocks[3]).toMatchObject({ kind: 'bullet', indent: 1 })
    expect(blocks[6]).toMatchObject({ kind: 'code', lang: 'ts', lines: ['const a = 1'] })
  })

  it('renders without markdown markers', () => {
    const { lastFrame } = render(<Markdown text={'## Core Concept\n\nVARA is **verified** work.\n- item `x`'} />)
    const f = lastFrame()!
    expect(f).toContain('Core Concept')
    expect(f).toContain('VARA is verified work.')
    expect(f).toContain('item x')
    expect(f).not.toContain('**')
    expect(f).not.toContain('##')
    expect(f).not.toContain('`')
  })
})
