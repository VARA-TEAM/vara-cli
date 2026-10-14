import { memo, type ReactNode } from 'react'
import { parseBlocks, parseInline, type Block, type Inline } from '../md'
import { CopyButton } from './ui'

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v
      case 'strong':
        return <strong key={i}>{renderInline(n.c)}</strong>
      case 'em':
        return <em key={i}>{renderInline(n.c)}</em>
      case 'del':
        return <del key={i}>{renderInline(n.c)}</del>
      case 'code':
        return (
          <code key={i} className="inline-code">
            {n.v}
          </code>
        )
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
            {renderInline(n.c)}
          </a>
        )
    }
  })
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'p':
        return (
          <p key={i} dir="auto">
            {renderInline(b.c)}
          </p>
        )
      case 'h': {
        const H = (`h${Math.min(6, b.level + 1)}` as 'h2')
        return (
          <H key={i} dir="auto">
            {renderInline(b.c)}
          </H>
        )
      }
      case 'hr':
        return <hr key={i} />
      case 'quote':
        return (
          <blockquote key={i} dir="auto">
            {renderBlocks(b.blocks)}
          </blockquote>
        )
      case 'code':
        return (
          <div className="codeblock" key={i}>
            <div className="codeblock-head">
              <span>{b.lang || 'text'}</span>
              <CopyButton text={b.v} />
            </div>
            <pre dir="ltr">
              <code>{b.v}</code>
            </pre>
          </div>
        )
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} dir="auto">
            {renderInline(it.c)}
            {it.children.length ? renderBlocks(it.children) : null}
          </li>
        ))
        return b.ordered ? (
          <ol key={i} start={b.start} dir="auto">
            {items}
          </ol>
        ) : (
          <ul key={i} dir="auto">
            {items}
          </ul>
        )
      }
      case 'table':
        return (
          <div className="table-wrap" key={i}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} dir="auto" style={{ textAlign: b.align[j] ?? undefined }}>
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} dir="auto" style={{ textAlign: b.align[k] ?? undefined }}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** Renders model output as React elements — nothing is ever injected as HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md" dir="auto">
      {renderBlocks(parseBlocks(text))}
    </div>
  )
})

/** Inline-only variant for one-liners. */
export function InlineMd({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>
}
