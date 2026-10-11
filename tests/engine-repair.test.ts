import { describe, expect, it } from 'vitest'
import { repairTruncatedJson } from '../src/core/engine.js'

describe('repairTruncatedJson', () => {
  it('returns the parsed object for valid JSON', () => {
    expect(repairTruncatedJson('{"path":"a.txt","content":"hi"}')).toEqual({ path: 'a.txt', content: 'hi' })
  })

  it('closes a truncated string then the object', () => {
    expect(repairTruncatedJson('{"path": "hello.txt", "content": "hi')).toEqual({
      path: 'hello.txt',
      content: 'hi',
    })
  })

  it('closes a truncated nested structure', () => {
    expect(repairTruncatedJson('{"a": {"b": [1, 2')).toEqual({ a: { b: [1, 2] } })
  })

  it('handles escaped quotes inside a truncated string', () => {
    expect(repairTruncatedJson('{"content": "say \\"hi')).toEqual({ content: 'say "hi' })
  })

  it('returns null for unrepairable garbage', () => {
    expect(repairTruncatedJson('not json at all')).toBeNull()
    expect(repairTruncatedJson('plain words')).toBeNull()
  })

  it('repairs a bare opening brace to an empty object (schema validation catches it later)', () => {
    expect(repairTruncatedJson('{')).toEqual({})
  })

  it('handles markdown code fences around JSON', () => {
    expect(repairTruncatedJson('```json\n{"path": "a.txt"}\n```')).toEqual({ path: 'a.txt' })
    expect(repairTruncatedJson('```\n{"path": "b.txt"}\n```')).toEqual({ path: 'b.txt' })
  })

  it('salvages JSON with a trailing comma before truncation', () => {
    expect(repairTruncatedJson('{"path": "a.txt", "content": "hi", ')).toEqual({
      path: 'a.txt',
      content: 'hi',
    })
  })

  it('salvages JSON with a dangling colon before truncation', () => {
    expect(repairTruncatedJson('{"path": "a.txt", "content": ')).toEqual({
      path: 'a.txt',
      content: '',
    })
  })

  it('returns an empty object for empty input', () => {
    expect(repairTruncatedJson('')).toEqual({})
    expect(repairTruncatedJson('   ')).toEqual({})
  })
})
