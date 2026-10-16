/**
 * A second chance for `edit_file` when the exact text is not found: models often get the indentation or trailing
 * spaces of a block slightly wrong. If, ignoring leading and trailing whitespace on every line, the block occurs
 * exactly ONCE, it is replaced and the replacement is re-indented to match the file. Zero or several candidates:
 * no guess, the caller reports "not found" as before.
 */
export interface FuzzyResult {
  next: string
  /** One line the tool shows to the model, so it knows the match was not exact. */
  note: string
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0]

export function fuzzyReplace(content: string, oldStr: string, newStr: string): FuzzyResult | null {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const want = oldStr.split(/\r?\n/)
  while (want.length && want[0]!.trim() === '') want.shift()
  while (want.length && want.at(-1)!.trim() === '') want.pop()
  if (want.length === 0 || want.every((l) => l.trim() === '')) return null
  const norm = (l: string): string => l.trim()
  const hits: number[] = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < want.length && ok; j++) if (norm(lines[i + j]!) !== norm(want[j]!)) ok = false
    if (ok) hits.push(i)
  }
  if (hits.length !== 1) return null
  const at = hits[0]!
  const fileIndent = indentOf(lines[at]!)
  const askedIndent = indentOf(want[0]!)
  const replacement = newStr.split(/\r?\n/).map((l) => {
    if (l.trim() === '') return l
    // Re-base: the model's indentation relative to its own first line, put on the file's first-line indentation.
    return l.startsWith(askedIndent) ? fileIndent + l.slice(askedIndent.length) : l
  })
  const next = [...lines.slice(0, at), ...replacement, ...lines.slice(at + want.length)].join(eol)
  return { next, note: 'matched ignoring differences in indentation / trailing spaces (the file was re-indented to fit)' }
}
