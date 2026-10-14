# Contributing — VARA

**English** · [العربية](CONTRIBUTING.ar.md)

The rules are short on purpose: read them once, then get to work.

---

## Before the first step

```bash
npm install
npm run check     # must be green from day one — if it is not, report it, do not bypass it
```

---

## Workflow

1. **One branch per change**, from `main`:
   ```bash
   git checkout -b fix/short-description   # or feat/… test/… docs/…
   ```
2. **Change as little as possible** — no reformatting of files you did not touch, no drive-by "improvements".
3. **Proof is mandatory** — new behaviour or a fix comes with a test that fails before the change and passes after.
4. **The gate before pushing:**
   ```bash
   npm run check    # typecheck + tests + build
   ```
   The exact number of tests changes with every batch — do not rely on a number written anywhere; rely on `npm run check` passing.
5. **Conventional Commits:**
   ```
   fix: prevent stale-closure Enter on the welcome screen

   - App.tsx: submit reads inputRef instead of the render closure
   - tests/tui-app.test.tsx: regression test that fails without the ref fix
   ```
   Types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci`.
6. **Push, then tell your partner** in one line: what changed, why, and which file deserves a look.

```bash
git push -u origin fix/short-description
```

---

## Non-negotiable rules

| Rule | Why |
| --- | --- |
| **Never commit secrets** — `.env` is ignored; keys live in the vault or in environment variables | A leaked key means at least replacing it, sometimes more |
| **`npm run check` is green before every push** — a failure is reported as it is | A false promise is worse than an honest failure |
| **unknown ≠ 0** — an unknown value stays `null` | Zero means "measured and nothing was spent", which is a lie if it was not measured |
| **No change to `engine.ts` / `permissions.ts` / `vault.ts` without discussing it first** | They carry the project's promises — breaking them voids their meaning |
| **Never weaken a defence-line test to make it pass** (`keymap` `commands` `engine` `permissions` `redact` `vault` `runtime-refs` `tui-app`) | A weakened test is decoration |
| **Docs follow the code, in both languages** — English is the default; update the Arabic twin (`docs/ar/`, `*.ar.md`) in the same change | A document that disagrees with the code is a bug |

---

## Reviewing

- Review the **diff**, not the message: what actually changed?
- Ask: does the new test fail without the fix? (Ask for a demonstration if in doubt.)
- Label each comment BLOCKER (blocks the merge) or MINOR (do it later) — no arguing over small details.
- Disputes are settled by experiment: a small test that shows who is right.

---

## What is not necessary

- Perfect English or Arabic in a commit message — substance matters more.
- Fixing everything you think is bad — file an issue or tell your partner, and carry on with your task.
- New features before what exists is stable.
