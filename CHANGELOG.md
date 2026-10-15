# Changelog — VARA

**English** · [العربية](CHANGELOG.ar.md)

Everything that reached `main`, newest first. Every batch is verified: `npm run check` is green before the push (typecheck + tests + build). Technical detail is in the commit message itself — see `git show <hash>`. Dates are the real push dates.

---

## Unreleased

- **Per-session switches for skills and MCP servers (connectors):** turn a skill or a server off for one conversation without touching the others or your saved settings — the *Tools* tab in the browser's side panel, `/disable <name>` and `/enable <name>` in the terminal, or by the agent itself (`skill_toggle` / `mcp_manage` with `scope: session`, with approval). A switched-off skill is not in the agent's prompt, so `/skill-name` refuses it; a switched-off server's tools are not offered. A skill change applies from the next message.
- **The agent can manage itself — with your approval, never silently:** four new tools — `skill_write` (create/edit a skill), `skill_toggle`, `mcp_manage` (add/remove/enable/disable an MCP server) and `switch_mode`. Each one shows the exact change (the full command line for an MCP server, the full text of a skill) as an approval card — in the browser (Allow / Decline) and in the terminal (`/approve`, `/deny`) — and the run waits. Headless runs, sub-agents and guests' agents cannot use them (denied, nothing changes); stopping the run declines the request. `plan` mode may still ask to `switch_mode`; a custom mode that does not list a tool cannot use it.
- **Custom modes:** name your own modes beyond plan/build (Settings → Agent in the browser, or `modes` in `config.json`). A mode stands on plan or build and can only *narrow* it with tool and shell-command lists (`allowTools`, `denyTools`, `allowCommands`, `denyCommands`); enforced in `authorize()` and hidden from the model. Pick it with `/mode <name>` or `Tab` in the terminal, or the mode selector in the browser; guests are capped by their grant. A mode that was deleted fails closed (read-only).
- **Working folder in the browser interface:** the session list shows only the current folder's sessions (the owner can ask for every folder); the owner can change the working folder from the sidebar — pick a recent one or browse the machine — and new sessions work there. Sessions already started keep theirs. Guests cannot change or browse folders.
- **Installer:** `install.ps1` no longer fails on Windows accounts whose user PATH is unset.

## 2026-10-14 · v0.3.0 — the browser interface with every terminal feature

- **Providers and models from the browser:** add a provider (presets or a custom endpoint), store the key encrypted (never shown again), fetch the model list, test models for real (green/red dot), context window and output reserve, thinking level per model, choose the default. A change applies at once with no restart, and a change that cannot work (e.g. a missing key) is refused before it is saved.
- **Agent:** understand each message, default mode, verify command, cheaper model, publishing, task and goal limits, context window.
- **Skills and MCP:** view, create, edit and switch skills; add MCP servers from presets or a command/URL, with live status, their tools and reconnect.
- **In a session:** command palette (`Ctrl K`), `/` commands (mode, kind, model, think, cost, export, stop, skill…), `@` project-file attachments, a three-tab side panel (Proof and evidence · Cost, savings and context window · Files), markdown export, stop for good, task ↔ goal, a draft kept per session.
- **Look and feel settings:** show reasoning, tool details, side panel; keyboard shortcuts list.
- **Security:** all of the above is owner-only (403 for a guest); `@file` is owner-only; no key is returned in any response; changes run one at a time so none is lost.

## 2026-10-14 · v0.2.0 — the browser interface

- **`vara ui` became a real interface:** React embedded in the executable (no external services), live conversation (SSE) with safe markdown (no `innerHTML`), tables and code, tool cards, a requirements/files/usage panel, 9 themes, English/Arabic with right-to-left, a mobile layout.
- **Team:** invites by link and QR, edit or revoke a guest's powers, see usage, and attribution of guests' messages in a shared session.
- The server computes each person's powers (`can`) and the interface only displays them; the decision stays on the server (403 on violation).

## 2026-10-14 · v0.1.1 — the licence

- **MIT:** a `LICENSE` file and the `license` field in `package.json`.
- Every package now carries `LICENSE` and `THIRD_PARTY_LICENSES.txt` (notices of every bundled library's licence, generated from the bundle map) — MIT requires the notice to travel with every copy.

## 2026-10-14 · v0.1.0 — first downloadable release

- **A self-contained package per OS** (`scripts/package-release.mjs`): the whole app in one file (`vara.mjs`) + a bundled Node + a launcher (`vara.cmd` / `vara`). The user installs neither Node nor npm. Windows x64 · macOS arm64 · Linux x64.
- **One-command installers:** `install.ps1` and `install.sh` — verify SHA-256 before running anything, no administrator rights.
- **`vara doctor`** checks the interface (it really renders it in memory), the provider, git and ripgrep. **`vara --version`**.
- **Release workflow** (`release.yml`, runs on pushing a `v*` tag): full gate → package on 3 systems → smoke test of the unpacked package in a clean folder → publish with `SHA256SUMS.txt` → a real install with the actual scripts on clean runners.
- **Known limits:** macOS on Intel and ARM on Windows/Linux are not built. No code signing (a SmartScreen/Gatekeeper warning is possible).

## 2026-10-14 · Shared sessions (the foundation) · CI

New: `src/server/{access,host,http,commands}.ts`, `src/core/runner-factory.ts`, `.github/workflows/ci.yml`; tests `access` and `server`.

- **The host** (`vara ui` / `vara serve`): a local HTTP server (REST + SSE) hosting sessions; keys never leave the owner's machine.
- **Invites and powers:** `vara invite` creates a link with a grant (watch / write / own session / power ceiling / model lock / call and cost caps / expiry). `vara guests` lists and revokes. Tokens are stored hashed, and an edited or revoked grant takes effect at once.
- **Hardening:** loopback by default, a token on every call, `Host` and `Origin` checks, rate limits, a body size limit, no error leaks.
- **A real race fixed:** saving a session became atomic (write then rename), so a second reader (the session list, another client) never sees a half-written file, and one corrupt session does not hide the rest.
- A unified runner factory (`makeSessionRunner`) used by the terminal UI and the host alike.
- GitHub CI: Ubuntu/Windows/macOS × Node 20/22. Later the same day, CI-found fixes: PowerShell 7 vault crash, a race when creating the master key, a skipped vault unlock when no secret is stored, portable tests.

## 2026-10-14 · MCP · sub-agents · thinking · the cost-saving engine · markdown

New: `src/mcp/{client,hub}.ts`, `src/llm/capabilities.ts`, `src/tui/{mcp,markdown,mentions}.ts(x)`; changes in `engine.ts`, `prompt.ts`, `anthropic.ts`, `openai.ts`, `registry.ts`, `control-tools.ts`, `App.tsx`, `settings.tsx`.

- **The cost-saving engine:** (1) a stable prefix for caching — the system message never changes between turns, what does (`[STATE]`) goes in the last messages; (2) Anthropic `cache_control` on the system message, tools and last message; (3) old tool output compacted in one batch past a soft limit, the full text kept in the audit log; (4) `read_file` of an unchanged file still in the conversation is answered instantly; (5) a cheaper model (`agent.cheapModel`) for chat, questions and sub-agents; (6) thinking on work turns only. `/cost` shows spend and savings.
- **Sub-agents:** the `delegate` tool — up to 4 tasks (3 at a time), ephemeral sessions that are not saved, a clean context and a small budget, no nesting. Their cost is added to the parent's ledger.
- **MCP:** a stdio and HTTP (JSON/SSE) client; `/mcp` with built-in servers (filesystem, fetch, memory, playwright, github, context7) or any command/URL. Server tools reach the agent with their schemas; `readOnlyHint` decides what runs in PLAN and in questions. Secrets by vault name only.
- **Thinking:** detects each model's support from its id and endpoint (OpenAI o-series/gpt-5, Claude, Gemini, OpenRouter) and offers only the available levels; `/think` or `h` in the model list. With Claude, signed thinking blocks are kept and returned with tool turns.
- **Markdown** in replies: headings, bold, italic, code, lists, quotes, code blocks, links.
- **Features:** `@file` in any message, `/export`, `/cost`, the cheaper-model setting and "MCP" in `/settings`.
- **Cleanup:** removed `.opencode/`, `opencode.json` and the unused `model-switching.ts`; updated `.env.example`, `.gitignore` and `package.json` metadata.

## 2026-10-14 · An agent that understands intent, a new start screen, themes, settings and skills

New: `src/core/intent.ts`, `src/core/skills.ts`, `src/core/builtin-skills.ts`, `src/tui/{home,settings}.tsx`, `src/version.ts`; changes in `engine.ts`, `prompt.ts`, `registry.ts`, `keymap.ts`, `App.tsx`, `cli.tsx`, `config.ts`.

- **Root cause of the "hellp" problem (proven):** (1) the first message never reached the model (the objective was only in the system prompt and the conversation was empty); (2) a text-only reply with no tools counted as "no progress", so the request was repeated with no new message and the model repeated itself. Now the message is planted as the first user message, a text reply in a conversation ends the turn with state `ready`, and in work an explicit nudge is sent (`complete`, `ask_user` or a tool).
- **Intent routing:** every message is classified chat / question / task / goal (Arabic + English, tolerant of typos; when unsure it picks the least powerful). Chat has no tools, a question reads only, task/goal get all tools and verification. The model has the last word through `escalate`. A session pinned by hand (TASK/GOAL) is not classified. A short message like "hi" is no longer a validation error.
- **Start screen:** nothing forced; `Ctrl+N` opens it as a "+ New" tab, with recent sessions (↑↓ then Enter), kind AUTO/TASK/GOAL, mode and model. `vara` always opens it and `vara -c` continues the latest session.
- **Stable frame:** its own screen buffer with a fixed-height frame; mouse wheel and arrows scroll the conversation; the terminal is restored on exit.
- **9 themes** applied instantly, a **side panel** with switchable sections, and **`/settings`** (`Ctrl+O`): theme, full screen, mouse, panel sections, intent routing, default mode, verify command, publishing, task/goal budgets, context window, skills.
- **Skills:** `SKILL.md` in `~/.vara/skills` and `<project>/.vara/skills` (+5 built in); the agent sees the index and loads what it needs through the `skill` tool; `/skills`, `/skills new <name>`, `/skill <name>`.

## 2026-10-14 · Multiple providers + `vara setup` + a redesigned terminal UI

Files: `src/config/providers.ts`, `src/llm/presets.ts`, `src/llm/discovery.ts`, `src/tui/providers.tsx`, `src/tui/setup.tsx`, `src/tui/{theme,prompt}.ts(x)` (new); `config.ts`, `runtime.ts`, `context.ts`, `engine.ts`, `runner.ts`, `App.tsx`, `cli.tsx`, `entries.tsx` and others.

- **Multiple providers:** `providers` in the config (each with protocol, URL, secret name, models); `provider` stays the active one, so the rest of the code is unchanged. Old configs are upgraded automatically.
- **11 ready providers + custom:** paste a key only; the key is stored encrypted and never shown.
- **Fetching models and their status:** `GET /models` (OpenAI/Anthropic/OpenRouter/Gemini/Ollama) and a real test with a tiny request: green = answered, red = failed with the reason, 429 = undetermined. Nothing is tested automatically (cost) — `t` / `a` on request.
- **Smart context per model:** manual → API → registry → "assumed"; the output reserve is capped at a quarter of the window; manual edit with `c` (`128k`/`1m`). The engine reads the live values every turn.
- **Live switching inside a session:** `/provider`, `/model`, `/models`, `/providers` rebuild the provider and swap the runner safely (a key failure changes nothing).
- **`vara setup` / `vara providers` / `vara run --provider`**, and setup opens automatically when no key exists.
- **Terminal UI:** one theme, an input box with a cursor, a live activity line, a line-budget view instead of an item count, a fixed palette scroll, no emoji.

## 2026-10-12 · A new `glob` tool and a fixed `grep` (search honouring `.gitignore`)

Files: `src/tools/search.ts` (new), `tests/search.test.ts` (new), `src/tools/fs-tools.ts`, `src/tools/registry.ts`, `src/tools/index.ts`, `THIRD_PARTY_NOTICES.md` (new).

**The proven gap:** `grep` abandoned ripgrep entirely on Windows (`if (isWin) return nodeGrep`) and fell back to a plain scan that ignored `.gitignore`, and there was no `glob` (path search) tool at all.

- **A new `glob` tool** searches paths by glob pattern (`**/*.ts`, `src/**/*.tsx`) — read-only, allowed in Plan mode.
- **`grep` rebuilt** to use `rg --json` on **every** platform, with correct exit codes (0/1/2) and clear regex errors.
- **Two injectable engines** (`ripgrep` | `node`): the Node engine is a deterministic alternative for tests and for when rg is absent, and genuinely honours `.gitignore` through its own parser (comments, negation `!`, `dirOnly`, anchors, "last match wins").
- **`--no-require-git`** so `.gitignore` is honoured even outside a git repository, and `normalizeRel` to unify Windows path separators.
- **Output limits** enforced (`MAX_OUTPUT_CHARS`, `GREP_MAX_PER_FILE`).
- **Independence:** no code is copied from OpenCode — only ideas and algorithms, re-implemented in VARA's style. See `THIRD_PARTY_NOTICES.md`.
- 13 regression tests (RED then GREEN). Test suite then: 177/177 in 18 files.

## 2026-10-12 · bfacc81 — enforce the real token budget and unify stall detection

Files: `src/core/engine.ts`, `tests/engine.test.ts`.

**Context (proven from a real stress session `b8026cfb`):** the engine completed 247 calls with no evidence at all (`evidence = 0`) and input grew to **106k tokens against a ~64k window** until the user stopped it by hand. Two proven causes:

- **`toModelMessages` ignored the `requestBudgetTokens`** already computed in `context.ts` and used a fixed character threshold (80,000 characters) that rarely applied → the window was never enforced.
- **The stall counter reset on any tool** — even a **failed** tool adds a result line to the transcript and looks like progress, so the stall was never noticed despite 247 turns.

**The fix:** `toModelMessages` now honours the real `requestBudgetTokens`, walks newest to oldest and drops the oldest tool output first; a message carrying `toolCalls` is never digested (to avoid orphaning its tool results — a provider API error). The stall counter resets only on real progress: **a successful tool** or **a completion claim**; text-only turns and failed tools share one path (`noteNoProgress`) that stops at `STALL_LIMIT`.

**Real acceptance proof** (session `0c9fee55` on a disposable folder): `state=completed` in **9 calls** (not 247), total input **29,427 tokens** (not 106k), independent evidence `node --test` exit=0, and cost `null` with a "pricing unknown" note (unknown ≠ 0). Test suite then: 164/164 in 17 files.

## 2026-10-12 · e17fc6d — docs: CHANGELOG and ROADMAP, and syncing all docs

Added `CHANGELOG.md` and `docs/ROADMAP.md`, and synced README/CONTRIBUTING/DEVELOPMENT/ARCHITECTURE with the real code. The fixed test count was dropped from CONTRIBUTING in favour of `npm run check` passing.

## 2026-10-11 · a14cf67 — thinking support, retry, and protecting config from key leaks

Files: `src/config/refs.ts` (new), `src/llm/retry.ts` (new), `tests/runtime-refs.test.ts` (new), `src/runtime.ts`, `src/config/config.ts`, `src/llm/provider.ts`, `src/llm/openai.ts`, `src/llm/anthropic.ts`, `src/core/engine.ts`, `tests/engine.test.ts`.

- **A `thinking` event in the provider contract:** supported models stream their private reasoning; the engine passes it, **scrubbed** (`scrubAll`), to the interface and keeps it out of the audit log — thinking is display evidence, not proof.
- **Exponential-backoff retry** (`retry.ts`) on 429/500/502/503/529 only, with jitter and a cap. **No retry on 4xx** — a client error is not transient.
- **Actionable provider errors:** the API's error body is read and its message and type extracted instead of a bare "HTTP 401".
- **`apiKeySecret`/`apiKeyEnv` are names, not values** (`refs.ts`): checked on load (zod) and before use (`buildProvider`), with a denylist of known key prefixes (`sk-`, `ghp_`, `AKIA`, `Bearer`, …).
- **The "No API key found" message passes through `scrubAll`** as defence in depth.
- Test suite then: 161/161 in 17 files.

## 2026-10-11 · 881647a — an overhaul of the smart loop, tools and interface

**Engine and tools:** correct grouping of multiple tool results for Anthropic and alternating-role messages; safe OpenAI binding (content and `tool_call_id`); repeated-tool detection (a warning after 3 identical calls) and stall detection (prevents endless turns); dynamic context compaction that prevents overrunning the window, and truncated-JSON repair (markdown fences, trailing commas); CRLF/LF normalisation in file edits, line counts in file reads, cache folders excluded from listings; Unix → Windows command hints in the shell tool.

**Interface:** logo fixed, a refreshed welcome screen and status indicators.

**Model registry:** extended for Claude 3.7, o3/o1 and DeepSeek.

## 2026-10-11 · f2bd4e9 — documenting `npm run dev`

Run straight from source through `tsx` to develop VARA without rebuilding.

## 2026-10-11 · 1fbf205 — the repository foundation

The project initialised with 72 files: the execution engine, tools and permissions, the two providers, the encrypted secret vault, the interface and the (Arabic) docs. The verification gate (`npm run check`) has been active since day one.

---

## How to read this file

- **The date** is the actual push date to `main`, and the **hash** is the commit for direct reference.
- Anything not listed here did not reach `main` — a feature you see on a branch is not published yet.
- Verified items state the test count; any batch without one did not pass the gate (and that is forbidden).
