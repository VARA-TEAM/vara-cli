# Third-party notices — VARA

**English** · [العربية](THIRD_PARTY_NOTICES.ar.md)

This file records every piece of code borrowed or inspired from an outside project, with its source, version, licence and the changes made. The aim: protect VARA's independence and honour licence terms.

---

## The governing principle

No file from an outside project is copied into VARA **as is**. What is taken is the *idea, algorithm or tool invocation*, then rewritten in VARA's style (plain TypeScript + zod + `ToolResult`) without heavyweight platforms (Effect, bun, drizzle, tree-sitter) that bring in dependencies and weaken independence.

---

## OpenCode

| Field | Value |
| --- | --- |
| Project | [opencode](https://github.com/anomalyco/opencode) |
| Version reviewed | `2.0.27` |
| Licence | MIT (the licence text is kept in the original repository) |
| Copyright | `Copyright (c) 2025 opencode` |
| How it was used | **Ideas and design were drawn on; no code was copied** |

### Components drawn on

| Component in VARA | Counterpart in OpenCode | What was taken, exactly |
| --- | --- | --- |
| `src/tools/search.ts` (`glob` tool) | `packages/core/src/tool/plugin/glob.ts` | *The invocation only:* using `rg --files --glob=<pattern>` to search paths, excluding `.git/` and hidden files by default, and a `limit`. |
| `src/tools/search.ts` (`grep` tool) | `packages/core/src/ripgrep.ts` + `tool/plugin/grep.ts` | *The algorithm:* reading `rg --json` and extracting `path`/`line_number`/`lines.text`, and classifying exit codes (0 = matches, 1 = none, 2 = pattern error). |

### What was deliberately not taken

- **The Effect / Service / Layer layer** — the structure OpenCode wraps everything in. VARA uses simple engine injection (`makeGlobTool('ripgrep' | 'node')`) for testability without loading the platform.
- **`drizzle` / databases**, **`bun`**, **`node-pty`**, **`tree-sitter`** — heavy dependencies VARA does not need and that would weaken its operational independence.
- **The Effect permission system** — VARA has its own `permissions.ts` and `authorize()`.

### Changes made to the ideas drawn on

1. **An injectable engine** — OpenCode always calls rg; VARA also offers `node` as a deterministic alternative engine for tests and for when rg is absent.
2. **The Node engine honours `.gitignore`** — with a purpose-built parser (`parseIgnoreFile`/`isIgnored`) that supports comments, negation `!`, `dirOnly`, anchors and "last match wins". OpenCode relies on rg for `.gitignore` handling and offers no equivalent fallback.
3. **`--no-require-git`** — added so `.gitignore` is honoured even outside a git repository (rg by default honours it only inside one).
4. **Separator normalisation** — rg paths on Windows are normalised to `/` (`normalizeRel`) for stable output across platforms.
5. **Output limits** — VARA enforces its own limits (`MAX_OUTPUT_CHARS`, `GREP_MAX_PER_FILE`) instead of adopting OpenCode's.

---

## Aider

| Field | Value |
| --- | --- |
| Project | [Aider](https://github.com/Aider-AI/aider) |
| Licence | Apache-2.0 |
| What was taken | **The idea only** of a *repository map*: a ranked outline of a codebase's symbols that fits a token budget, so the model finds code without reading whole files (see [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html)). No Aider code, query files or prompts were copied. |
| In VARA | `src/core/repomap.ts`, `src/tools/repo-tools.ts` — a small per-language regular-expression extractor and a ranking by how many other files mention each symbol, written from scratch. No tree-sitter and no graph library. |
| Changes | Not a graph ranking and not a parser: the index can miss unusual syntax and says it is an index. Exposed as two tools (`repo_map`, `read_symbol`) rather than injected into every prompt. |

---

## Licence commitment (MIT)

Because what was taken is ideas and design rather than "substantial portions of the source code", the MIT licence does not oblige VARA to redistribute their source. Even so, this file records the source of the idea, its version and licence out of good faith toward the original project, and keeps opencode's copyright notice on record should any material part be brought in later.

**If any file or material part of OpenCode is ever carried over, it must be recorded here immediately in the same batch** (source, version, licence, changes) and the licence text and copyright notice kept, as MIT requires.

---

## Other components

No other project's code is currently adopted. Every dependency in `package.json` is a third-party library imported through npm under its published licence — their code is not copied into the repository. The licences of the libraries bundled into each release package are listed in that package's `THIRD_PARTY_LICENSES.txt`.
