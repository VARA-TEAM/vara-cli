import type { Skill } from './skills.js'

/** Skills that ship with VARA. Users override any of them by name. */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'code-review',
    source: 'builtin',
    description: 'Review a diff or files for bugs, risks and simplifications (use when asked to review code or a change)',
    body: `# Code review
1. Establish scope: \`git_diff\` (or the files named). Read every changed hunk in context — open the surrounding function, not just the lines.
2. Hunt correctness first: wrong conditions, off-by-one, null/undefined paths, error paths that swallow failures, races, resource leaks, broken invariants between callers and callees.
3. Then security: injection, path traversal, secrets in code/logs, missing authorization checks.
4. Then maintainability: duplication, needless complexity, misleading names — only when it matters.
5. Report findings ranked by severity. Each finding: file:line, the concrete failure scenario (input → wrong result), and the fix. No vague style nits.
6. If nothing is wrong, say so plainly — do not invent findings.`,
  },
  {
    name: 'debug',
    source: 'builtin',
    description: 'Systematic debugging of a failure, crash or wrong output (use when something is broken)',
    body: `# Debugging
1. Reproduce: run the failing command/test and capture the exact error. No fix before a reproduction.
2. Read the stack trace bottom-up to the first frame in project code. Open that code.
3. Form ONE hypothesis that explains every symptom. Check it with the cheapest probe (read a value, add a log, run a narrower test).
4. Fix the root cause, not the symptom. Keep the change minimal.
5. Re-run the reproduction, then the surrounding test suite, to prove the fix and catch regressions.
6. Report: cause → fix → evidence (command + result).`,
  },
  {
    name: 'write-tests',
    source: 'builtin',
    description: 'Add meaningful tests for existing code (use when asked to test or increase coverage)',
    body: `# Writing tests
1. Detect the test framework and conventions from existing tests (location, naming, helpers). Match them.
2. Test behavior, not implementation: inputs → observable outputs and side effects.
3. Cover the happy path, the edges (empty, boundary, invalid input) and the failure paths.
4. Never mock the unit under test. Mock only slow/external boundaries (network, clock, filesystem when needed).
5. Each test must be able to fail: briefly break the code (or assert the opposite) to confirm the test catches it, then restore.
6. Run the whole suite and report the result.`,
  },
  {
    name: 'explain-code',
    source: 'builtin',
    description: 'Explain how a codebase, module or flow works (use for "how does X work" questions)',
    body: `# Explaining code
1. Find the entry point (main, CLI, routes, exported API) with list_dir / glob / grep.
2. Trace the flow the user asked about end-to-end, reading the actual code — never guess from names.
3. Answer top-down: one-paragraph summary, then the steps with file:line references.
4. Mention the non-obvious parts (side effects, error handling, configuration) and stop — no refactoring advice unless asked.`,
  },
  {
    name: 'git-commit',
    source: 'builtin',
    description: 'Write a clear commit for the current changes (use when asked to commit)',
    body: `# Committing
1. \`git_status\` and \`git_diff\`: understand every change. Do not commit unrelated or generated files, or secrets.
2. Group into one logical change; if the diff mixes concerns, say so before committing.
3. Message: imperative subject ≤ 72 chars in the repo's convention (check \`git_log\`), blank line, body explaining WHY.
4. Run the project's checks (tests/lint/build) before committing when they exist.
5. Commit with git_commit and report the hash.`,
  },
]
