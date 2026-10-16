import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteFileTool, editFileTool, readFileTool, writeFileTool } from '../src/tools/fs-tools.js'
import { clearCheckpoints, listCheckpoints, undo } from '../src/tools/file-guard.js'
import type { ToolContext } from '../src/tools/types.js'

let dir: string
const sid = 'guard-test-session'
const ctx = (): ToolContext => ({ cwd: dir, mode: 'build', sessionId: sid, scope: `session:${sid}`, env: {}, allowPublish: false })
const run = <A>(tool: { execute: (a: A, c: ToolContext) => Promise<{ ok: boolean; output: string }> }, args: A) => tool.execute(args, ctx())

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-guard-'))
})
afterAll(async () => {
  await clearCheckpoints(sid)
  await rm(dir, { recursive: true, force: true })
})

describe('file guard', () => {
  it('refuses an edit planned from a version of the file that has since changed on disk', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8')
    await run(readFileTool, { path: 'a.txt' })
    await writeFile(join(dir, 'a.txt'), 'one\ntwo changed by you\n', 'utf8') // someone else edits it
    const r = await run(editFileTool, { path: 'a.txt', oldString: 'two', newString: 'TWO' })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/changed on disk/)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo changed by you\n')
    // after reading it again the edit goes through
    await run(readFileTool, { path: 'a.txt' })
    expect((await run(editFileTool, { path: 'a.txt', oldString: 'two changed by you', newString: 'TWO' })).ok).toBe(true)
  })

  it('does not get in the way of the agent editing its own files again and again', async () => {
    await run(writeFileTool, { path: 'b.txt', content: 'x\n' })
    expect((await run(editFileTool, { path: 'b.txt', oldString: 'x', newString: 'y' })).ok).toBe(true)
    expect((await run(editFileTool, { path: 'b.txt', oldString: 'y', newString: 'z' })).ok).toBe(true)
  })

  it('/undo puts back edits, overwrites, deletes and removes files the agent created, newest first', async () => {
    await clearCheckpoints(sid)
    await writeFile(join(dir, 'c.txt'), 'original\n', 'utf8')
    await run(readFileTool, { path: 'c.txt' })
    await run(editFileTool, { path: 'c.txt', oldString: 'original', newString: 'edited' })
    await run(writeFileTool, { path: 'new.txt', content: 'brand new\n' })
    await run(deleteFileTool, { path: 'c.txt' })
    expect((await listCheckpoints(sid)).map((c) => c.action)).toEqual(['edit', 'write', 'delete'])

    const first = await undo(sid, 1) // the delete
    expect(first.restored[0]!.what).toMatch(/brought back/)
    expect(await readFile(join(dir, 'c.txt'), 'utf8')).toBe('edited\n')

    const rest = await undo(sid, 5)
    expect(rest.failed).toEqual([])
    expect(await readFile(join(dir, 'c.txt'), 'utf8')).toBe('original\n')
    await expect(readFile(join(dir, 'new.txt'), 'utf8')).rejects.toThrow()
    expect(await listCheckpoints(sid)).toEqual([])
  })
})

describe('tolerant edit matching', () => {
  it('replaces a block whose indentation the model got wrong, once, and re-indents the replacement', async () => {
    await writeFile(join(dir, 'd.js'), 'function f() {\n    if (x) {\n        run()\n    }\n}\n', 'utf8')
    await run(readFileTool, { path: 'd.js' })
    const r = await run(editFileTool, { path: 'd.js', oldString: 'if (x) {\n  run()\n}', newString: 'if (x) {\n  run()\n  log()\n}' })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/indentation/)
    expect(await readFile(join(dir, 'd.js'), 'utf8')).toBe('function f() {\n    if (x) {\n      run()\n      log()\n    }\n}\n')
  })
  it('does not guess when the block is ambiguous or absent', async () => {
    await writeFile(join(dir, 'e.js'), 'a()\n  b()\na()\n  b()\n', 'utf8')
    await run(readFileTool, { path: 'e.js' })
    expect((await run(editFileTool, { path: 'e.js', oldString: 'a()\nb()', newString: 'c()' })).ok).toBe(false)
    expect((await run(editFileTool, { path: 'e.js', oldString: 'nothing like it', newString: 'c()' })).ok).toBe(false)
  })
})
