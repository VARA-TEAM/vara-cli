import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../src/tools/types.js'
import { writeFileTool, editFileTool, readFileTool } from '../src/tools/fs-tools.js'
import { shellTool } from '../src/tools/shell-tool.js'

let workdir: string
let ctx: ToolContext

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-verify-'))
  ctx = {
    cwd: workdir,
    mode: 'build',
    sessionId: 'test',
    scope: 'session:test',
    env: { ...process.env } as Record<string, string>,
    allowPublish: false,
  }
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('write_file verification (P0)', () => {
  it('round-trips Unicode content and reports byte verification', async () => {
    const content = '# مرحبا\nemoji 🚀\n中文字符\nquotes "and" \u2019dashes\u2019\n'
    const result = await writeFileTool.execute({ path: 'unicode.txt', content }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('read-back verified')

    const read = await readFileTool.execute({ path: 'unicode.txt' }, ctx)
    expect(read.ok).toBe(true)
    expect(read.output).toContain('مرحبا')
    expect(read.output).toContain('🚀')
  })

  it('rejects a .py file with a syntax error at write time', async () => {
    const result = await writeFileTool.execute(
      { path: 'broken.py', content: 'def f(:\n    pass\n' },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain('SYNTAX CHECK FAILED')
    expect(result.output).toContain('py_compile')
  })

  it('accepts a valid .py file and says the check passed', async () => {
    const result = await writeFileTool.execute(
      { path: 'ok.py', content: 'def f():\n    return 1\n' },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('py_compile ok')
  })

  it('rejects invalid .json at write time', async () => {
    const result = await writeFileTool.execute({ path: 'bad.json', content: '{"a": 1,}' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('json parse failed')
  })
})

describe('edit_file verification (P0)', () => {
  it('confirms the edit landed on disk', async () => {
    await writeFileTool.execute({ path: 'edit-me.txt', content: 'alpha beta gamma' }, ctx)
    const result = await editFileTool.execute(
      { path: 'edit-me.txt', oldString: 'beta', newString: 'BETA' },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('read-back verified')
    const disk = await readFile(join(workdir, 'edit-me.txt'), 'utf8')
    expect(disk).toBe('alpha BETA gamma')
  })

  it('reports a syntax failure when the edit breaks a Python file', async () => {
    await writeFileTool.execute({ path: 'edit-py.py', content: 'x = 1\n' }, ctx)
    const result = await editFileTool.execute(
      { path: 'edit-py.py', oldString: 'x = 1', newString: 'def broken(:' },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain('SYNTAX CHECK FAILED')
  })

  it('matches and edits CRLF content even when oldString has LF line endings', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(workdir, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n', 'utf8')
    const result = await editFileTool.execute(
      { path: 'crlf.txt', oldString: 'line1\nline2\n', newString: 'first\nsecond\n' },
      ctx,
    )
    expect(result.ok).toBe(true)
    const disk = await readFile(join(workdir, 'crlf.txt'), 'utf8')
    expect(disk).toBe('first\r\nsecond\r\nline3\r\n')
  })
})

describe('shell cwd (P1 — Windows path safety)', () => {
  it('runs in a subdirectory whose name contains spaces', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(workdir, 'dir with spaces'), { recursive: true })

    // `cd` (cmd) / `pwd` (sh) with no args print the current directory — proves the
    // cwd argument moved the process without any cd chain in the command.
    const inside = await shellTool.execute({ command: process.platform === 'win32' ? 'cd' : 'pwd', cwd: 'dir with spaces' }, ctx)
    expect(inside.ok).toBe(true)
    expect(inside.output.toLowerCase()).toContain('dir with spaces')

    const hello = await shellTool.execute({ command: 'echo hello-from-inside', cwd: 'dir with spaces' }, ctx)
    expect(hello.ok).toBe(true)
    expect(hello.output).toContain('hello-from-inside')
  })

  it('refuses a cwd that escapes the working directory', async () => {
    const result = await shellTool.execute({ command: 'echo hi', cwd: '..' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('escapes the working directory')
  })
})
