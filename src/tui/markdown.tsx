import React from 'react'
import { Box, Text } from 'ink'
import { glyph, theme } from './theme.js'

/**
 * Small, dependency-free markdown renderer for assistant replies:
 * headings, **bold**, *italic*, `code`, [links](url), bullet/numbered lists,
 * > quotes, ``` fences and --- rules. Anything it does not recognise is shown
 * as plain text, so a half-streamed message never breaks.
 */

type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: boolean }

const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w])|\[[^\]\n]+\]\([^)\s]+\))/g

/** Split one line into styled runs. Exported for tests. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of line.matchAll(INLINE_RE)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (at > last) out.push({ text: line.slice(last, at) })
    if (tok.startsWith('**') || tok.startsWith('__')) out.push({ text: tok.slice(2, -2), bold: true })
    else if (tok.startsWith('`')) out.push({ text: tok.slice(1, -1), code: true })
    else if (tok.startsWith('[')) {
      const close = tok.indexOf('](')
      out.push({ text: tok.slice(1, close), link: true })
    } else out.push({ text: tok.slice(1, -1), italic: true })
    last = at + tok.length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}

function Runs({ line, color, bold }: { line: string; color?: string; bold?: boolean }): React.ReactElement {
  return (
    <>
      {parseInline(line).map((r, i) => (
        <Text
          key={i}
          bold={bold || r.bold}
          italic={r.italic}
          underline={r.link}
          color={r.code ? theme.accent : r.link ? theme.info : color}
        >
          {r.text}
        </Text>
      ))}
    </>
  )
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; indent: number; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'blank' }
  | { kind: 'para'; text: string }

/** Line-oriented block parser. Exported for tests. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      blocks.push({ kind: 'code', lang: fence[1] ?? '', lines: body })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]!.replace(/\s*#+\s*$/, '') })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      continue
    }
    const b = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (b) {
      blocks.push({ kind: 'bullet', indent: Math.floor(b[1]!.length / 2), marker: /\d/.test(b[2]!) ? b[2]! : glyph.dot === '●' ? '•' : '-', text: b[3]! })
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      blocks.push({ kind: 'quote', text: q[1]! })
      continue
    }
    blocks.push(line.trim() === '' ? { kind: 'blank' } : { kind: 'para', text: line })
  }
  return blocks
}

export function Markdown({ text, width }: { text: string; width?: number }): React.ReactElement {
  const blocks = parseBlocks(text)
  // Collapse runs of blank lines to one.
  const clean = blocks.filter((b, i) => !(b.kind === 'blank' && (i === 0 || blocks[i - 1]!.kind === 'blank')))
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {clean.map((b, i) => (
        <Box key={i} flexShrink={0} flexDirection="column">
          {renderBlock(b)}
        </Box>
      ))}
    </Box>
  )
}

function renderBlock(b: Block): React.ReactElement {
  switch (b.kind) {
    case 'heading':
      return (
        <Text bold color={b.level <= 2 ? theme.brand : theme.accent}>
          <Runs line={b.text} bold />
        </Text>
      )
    case 'bullet':
      return (
        <Box paddingLeft={b.indent * 2}>
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.brand}>{b.marker}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text>
              <Runs line={b.text} />
            </Text>
          </Box>
        </Box>
      )
    case 'quote':
      return (
        <Box>
          <Text color={theme.border}>▎ </Text>
          <Text color={theme.muted} italic>
            <Runs line={b.text} color={theme.muted} />
          </Text>
        </Box>
      )
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="single" borderColor={theme.border} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} marginY={0}>
          {b.lang ? <Text color={theme.muted}>{b.lang}</Text> : null}
          {b.lines.map((l, j) => (
            <Text key={j} color={theme.accent}>
              {l || ' '}
            </Text>
          ))}
        </Box>
      )
    case 'rule':
      return (
        <Text color={theme.border}>
          {glyph.rule.repeat(24)}
        </Text>
      )
    case 'blank':
      return <Text> </Text>
    default:
      return (
        <Text>
          <Runs line={b.text} />
        </Text>
      )
  }
}
