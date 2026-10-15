# Architecture — VARA

**English** · [العربية](ar/ARCHITECTURE.md)

A **deep** document: how everything works and why it was designed that way. To just run the tool, see the [README](../README.md).

---

## 1. Overview

```
                     ┌──────────────────────────────────────────┐
   You ────────────► │  Terminal UI (Ink/React)   cli.tsx       │
   (TUI, run, web)   │  headless `vara run`, browser UI (host)  │
                     └───────────────┬──────────────────────────┘
                                     │ Session + Provider
                     ┌───────────────▼──────────────────────────┐
                     │  Engine (src/core/engine.ts)             │
                     │  one loop: turns ⇄ tools                 │
                     │  ┌────────────────────────────────────┐  │
                     │  │ authorize() → tool → evidence      │  │
                     │  └────────────────────────────────────┘  │
                     │  on `complete`: independent verification │
                     └───────┬──────────────────┬───────────────┘
                             │                  │
              ┌──────────────▼───┐   ┌──────────▼──────────────┐
              │ Provider (llm/)  │   │ Store (core/store.ts)   │
              │ direct HTTP+SSE  │   │ ~/.vara/sessions/<id>/  │
              │ pricing, usage   │   │ state.json+events.jsonl │
              └──────────────────┘   └─────────────────────────┘
                  every model/tool output is scrubbed before it is saved
```

| Layer | Path | Single responsibility |
| --- | --- | --- |
| Domain | `src/core/types.ts` | All types — the single source of truth |
| Engine | `src/core/engine.ts` | The loop, budgets, proof, rejecting false completion |
| Intent | `src/core/intent.ts` | Classify each message: chat / question / task / goal |
| Tools | `src/tools/*` | Real execution + permission enforcement |
| MCP | `src/mcp/*` | Model Context Protocol client (stdio + HTTP) and server hub |
| Skills | `src/core/skills.ts`, `builtin-skills.ts` | Discover and index `SKILL.md` playbooks |
| Runner | `src/core/runner.ts`, `runner-factory.ts` | Engine lifecycle across pauses; the one place that wires a session to provider, skills, budgets, MCP |
| Models | `src/llm/*` | HTTP/SSE, normalisation, pricing, model discovery |
| Security | `src/security/*` | Secret encryption and output scrubbing |
| Host | `src/server/*` | Shared sessions, invites, permissions, local HTTP API, management API |
| Storage | `src/core/store.ts` | State snapshot + event log |
| Terminal UI | `src/tui/*` | Rendering only — no business logic |
| Web UI | `ui/` | React app embedded into the release bundle |

Design rule: **the interfaces hold no business logic**, and the engine knows nothing about them (it speaks through `EngineEvent`), so the terminal UI, the browser UI and headless runs all use the same engine.

---

## 2. The execution loop

`Engine.run()` loops until the session reaches a final or waiting state:

0. **Intent routing** (`routeIntent`, using `classifyIntent` in `intent.ts`) — before the first turn: what kind of message is this? A session pinned by hand (TASK/GOAL) is not classified; unfinished work stays work; anything else is classified, and the model has the last word through the `escalate` tool. Chat has no tools, a question has read tools, work has all tools. **A text-only reply in chat/question ends the turn** (`ready`) — no repeating.
1. **Late instructions** — any follow-up the user typed while it worked is injected at the start of the next safe turn, and its turn is recorded (`appliedAtTurn`) so it is transparent.
2. **Budget check** — `maxTurns` / `maxDurationMs` / `maxModelCalls`. Warnings at 70% (review requirements), 80% (stop non-essential work) and 90% (mandatory checkpoint report); each fires once.
3. **Model call** — system message (`prompt.ts`) + transcript (compacted) + follow-ups.
4. **Tool execution** — every call goes through the single `authorize()` (see §4). The result is recorded as a `tool` message.
5. **Stall detection** — turns with no text, no tools and no evidence move the session to `waiting_user` instead of burning budget; the stall counter only resets on real progress (a successful tool or a completion claim).
6. **Repeat** until completion, failure or the user stops it.

**Against repeated failure:** two failures in a row of the same tool force a change of strategy, not a blind retry. Identical consecutive tool calls are detected as a loop.

**Broken JSON from the model:** models sometimes emit truncated JSON in a tool call. `repairTruncatedJson()` fixes it when possible; otherwise the error goes back to the model as text it can act on instead of crashing the loop.

---

## 3. State machine

`SessionState` in `types.ts`; every transition has a recorded reason (`stateReason`):

| State | Meaning |
| --- | --- |
| `idle` | Created, not started |
| `running` | The loop is active; accepts follow-ups at safe points |
| `ready` | A chat/question was answered; waiting for your next message |
| `waiting_user` | The agent stopped and waits for your decision (or progress stalled) |
| `paused` | You paused it — state saved, messages queue up |
| `interrupted` | The process died mid-turn — **the previous turn is not assumed to have succeeded** |
| `completed` | Requirements verified and evidence recorded |
| `failed` | Attempts/budget exhausted, with a reason |
| `stopped` | Stopped by hand |

**Recovery from interruption:** a session opened while saved as `running` becomes `interrupted` with an explicit note to the model: inspect what is in the folder and continue — do not assume the earlier step worked. This prevents the worst case: building on an assumed foundation.

---

## 4. Tools and permissions

| Tool | plan | build |
| --- | --- | --- |
| `read_file` `list_dir` `glob` `grep` | ✓ | ✓ |
| `git_status` `git_diff` `git_log` | ✓ | ✓ |
| `write_file` `edit_file` `delete_file` | ✗ | ✓ |
| `shell` | ✗ (forbidden outright — it would bypass the write ban) | ✓ with command policy |
| `git_commit` | ✗ | ✓ |
| `gh` | ✗ | ✓ (writes need publishing enabled) |
| `ask_user` | ✓ — pauses the session until you answer | ✓ |
| `delegate` `skill` `escalate` | ✓ | ✓ |
| `switch_mode` | ✓ (needs approval) | ✓ (needs approval) |
| `skill_write` `skill_toggle` `mcp_manage` | ✗ | ✓ (each needs approval, §7.7) |
| `complete` | — | ✓ — followed by independent verification |
| MCP tools (`mcp__<server>__<tool>`) | only those the server marks read-only | ✓ |

**The core principle:** permissions are **enforced on the tool itself**, not by telling the model not to write. The only path to execution is `authorize()` in `tools/permissions.ts`:

1. `checkToolAllowed` — `plan` mode rejects any tool that is not `readonly`.
2. A per-tool `guard` (injects `cwd`, checks paths…).
3. `checkModePolicy` — the session's **custom mode** (§7.6.1) can only add refusals: tool allow/deny lists, hidden from the model as well.
4. `checkCommandAllowed`:
   - **Always destructive:** `rm -rf /`, `mkfs`, `format C:` … → flat refusal.
   - **Publishing:** `git push`, `gh repo create/edit/delete`, `gh api POST/PATCH/DELETE`, `npm publish`, `docker push` … → refused unless `allowPublish` is on for that session.
   - **Custom-mode command lists** (`allowCommands` / `denyCommands`), evaluated last. With an allow list, substitution and redirection (`` ` ``, `$()`, `<`, `>`) are refused because they hide a second command.

---

## 5. The proof path (the heart of the project)

```
The model calls `complete` ──► rejected unless every requirement is covered by number
      │
      ▼
The ENGINE (not the model) gathers evidence independently:
   • files actually changed
   • git status
   • the configured verify command (e.g. npm test) — real exit code
      │
      ▼
Verification failed? ── yes ──► rejection + clear reason; the session carries on or fails
      │ no
      ▼
Accepted + evidence log (EvidenceRecord) in the session
```

- `activeRequirements` holds every active requirement: the original ones plus every applied follow-up. `complete` is rejected when the model ignores a requirement added along the way.
- **`verifiedRequirements` is mandatory:** "verified 0 of 0" is not success — the model must answer each requirement by number.
- Evidence is written to `session.evidence` **by the engine only**. The model cannot write the evidence log.

---

## 6. Cost truthfulness (unknown ≠ 0)

The problem: a system shows "cost $0.0000" as if it had been measured when it had not.

VARA's answer has two layers:

1. **A call ledger** (`ModelCallRecord[]`): every model call is recorded on its own — tokens as reported by the provider (`usageSource: 'provider'`) or as estimated (`'estimated'`), and the cost or `null` with a reason. Session totals are **derived from the whole ledger**, never added in place, so nothing is counted twice on resume or restart.
2. **The golden refusal:** tokens that were not reported stay `null`, never 0. Cost is computed only from explicit pricing in the model registry (`llm/registry.ts`); otherwise `costUsd: null` and `unpricedCalls` counts the unknowns.

Interfaces show `unknown` honestly (with a `+` when part of the cost is unpriced) and never fake a zero.

---

## 7. Model layer

- **No SDK:** direct HTTP to the provider with SSE streaming (`llm/sse.ts`), two equal providers:
  - `openai.ts` — any OpenAI-compatible endpoint.
  - `anthropic.ts` — the Anthropic API, including extended-thinking blocks.
- **Event contract** (`provider.ts`): `text` (the answer), `thinking` (the model's reasoning — shown scrubbed and **not** written to the audit log, because thinking is display evidence, not proof), `done` (result + usage), `error`.
- **Retry** (`retry.ts`): only transient errors (429/500/502/503/529), exponential backoff with jitter and a cap. 4xx errors are never retried — a client error is not transient.
- **Provider construction:** `provider.ts` builds the provider from config; `runtime.ts` resolves the key (vault first, environment variable as fallback) and refuses to build the provider if `apiKeySecret`/`apiKeyEnv` hold a key instead of a name (`config/refs.ts`).
- **Providers and discovery** (`config/providers.ts`, `llm/presets.ts`, `llm/discovery.ts`): `providers` in the config holds each provider (protocol, URL, secret name, models); `provider` stays the active one, so the rest of the code is unchanged. Models are listed from the provider's own `/models`, and a model is proven with a tiny real request (green = answered, red = failed with the reason, 429 = unknown). Nothing is tested automatically (it costs money).
- **Model registry** (`registry.ts`): context window and pricing per known model. An unregistered model means unknown pricing, hence cost `null` — correct, not a guess.
- **Context per model:** manual → reported by the API → built-in registry → marked "assumed"; the output reserve is capped at a quarter of the window.
- **Usage normalisation** (`usage.ts`): unifies the providers' formats and honestly distinguishes "the provider reported" from "we estimated".

## 7.1 Thinking (`llm/capabilities.ts`)

`thinkingSupport({type, baseUrl, model})` decides from the model id and endpoint whether the model supports thinking and by which mechanism: `effort` (OpenAI o-series/gpt-5, Gemini), `budget` (Claude: extended-thinking token budget), `openrouter`. An unknown model means no support, so **no parameter is sent**. The level is stored per model (`models[id].thinking`) and sent only on **work** turns. With Anthropic, signed thinking blocks are kept (`reasoning`) and returned with tool turns, as the API requires.

## 7.2 The cost-saving engine (in `engine.ts` and `anthropic.ts`)

| Mechanism | Effect |
| --- | --- |
| **Stable prefix** | The system message does not change between turns; what does change (turn number, latest evidence) goes in a final `[STATE]` message. This is what makes providers' caches work. |
| **Anthropic `cache_control`** | On the system message, the tool list and the last message. |
| **Compaction** (`compactIfNeeded`) | Past a soft limit, old tool output is shortened **in one batch** (the last 8 messages stay intact). The full text remains in the audit log. |
| **Token-budget trimming** | `toModelMessages` honours the real `requestBudgetTokens`: newest to oldest, dropping the oldest tool outputs first; a message that carries `toolCalls` is never dropped. |
| **No repeated reads** | A full `read_file` of a file whose mtime is unchanged and whose content is still in the conversation is answered instantly without sending it again. |
| **Model routing** | `agent.cheapModel` for chat, questions and sub-agents. |
| **Sub-agents** | A small clean context instead of inflating the main conversation. |

Counters live in `session.savings`, shown by `/cost`, the terminal side panel and the web *Cost* tab (which also estimates dollar savings from cache and compaction when pricing is known). Sub-agent cost is added to the parent's ledger so the numbers stay honest.

## 7.3 Sub-agents and the swarm (`delegate`)

`delegate` calls `Engine.spawnSubagents`, which validates a plan (`planSwarm` in `core/swarm.ts`) and runs it (`runSwarm`). A plan is up to 4 tasks; each may have an `id`, a **role** and `dependsOn`.

- **Roles:** `researcher` and `reviewer` are read-only, `implementer` and `tester` may edit files; a role adds its instructions to the sub-agent's prompt. Your own roles go in `config.json` → `swarm.roles`. An explicit `kind` beats the role; in PLAN mode every task is read-only.
- **Shared task list:** every sub-agent is shown the whole plan (who does what) and, for a task that depends on others, the reports of those tasks. A task starts only when its dependencies are done; if one fails, what depends on it is skipped and the rest still runs. A plan with an unknown id, a duplicate or a cycle is refused with a reason the model can act on.
- **Limits** (`config.json` → `swarm`, also Settings → Agent): `maxTasks` ≤ 4 and `maxParallel` ≤ 3 can only be *lowered*; `maxModelCalls` (default 120) is spent by the whole swarm and no new sub-agent starts after it; `maxCostUsd` stops new sub-agents once the **known** cost reaches it. Unknown cost is never counted as zero, so the call cap is the guard that always works.
- **One merged report:** a header (done / failed / skipped, calls, cost) and every report in plan order; if a file-editing agent ran, the parent is told to verify before claiming anything.
- **Live:** each status change is a `subagent` event (id, title, role, dependsOn, status `waiting|running|done|failed|skipped`) shown in the terminal and as a board in the browser.

Each agent is an **ephemeral** session (not saved, events not logged) with the parent's mode **and custom-mode policy**, the parent's per-session skill/MCP switches, a small budget (25 turns for `work`, 12 for `explore`), the cheaper model, and no `delegate` of its own. Its model calls are added to the parent's ledger.

## 7.4 MCP (`src/mcp`)

`McpClient` speaks JSON-RPC over stdio (JSON lines) or HTTP (JSON/SSE with `mcp-session-id`). `McpHub` manages connections in the background (a broken server does not affect the others) and turns server tools into `Tool`s named `mcp__<server>__<tool>`, with the server's raw JSON schema. `readOnlyHint` decides what runs in PLAN and in questions. **Secrets:** the config holds vault secret names (`secretEnv`, `bearerSecret`), never their values. `src/mcp/input.ts` turns what a person types (a command line or a URL) into a server config.

## 7.5 Skills

`discoverSkills(cwd)`: built-in → `~/.vara/skills` → `<project>/.vara/skills` (the later one wins a name clash). The index (name + description) goes in the system message; the body is loaded through the `skill` tool only when needed. Skills named in `skills.disabled` are hidden from the agent.

---

## 7.6.1 Custom modes (`core/modes.ts`)

`config.json` → `modes` (or Settings → Agent in the browser) defines named modes. A mode **stands on** `plan` or `build` and can only narrow it: `allowTools` / `denyTools` (wildcards like `mcp__github__*`) and `allowCommands` / `denyCommands`. The session stores the base in `config.mode` — so every existing plan/build rule still runs first — and the name in `config.customMode`. The policy reaches `authorize()` through `ToolContext.modePolicy`, is also used to hide refused tools from the model, and is inherited by sub-agents. A name that no longer exists fails **closed** (read-only). A guest can only pick a mode whose base is within their grant. Select with `/mode <name>` or `Tab` (cycles) in the terminal, or the selector next to the message box.

## 7.7 Self-management with approval (`tools/self-tools.ts`, `core/selfmanage.ts`)

Four tools let the agent change its own setup: `skill_write`, `skill_toggle`, `mcp_manage`, `switch_mode`. None acts alone: the tool calls `ctx.approve()`, the engine emits `approval_request` with the exact change (the full command line of an MCP server, the full text of a skill), puts the session in `waiting_user`, and waits. The owner answers with **Allow / Decline** in the browser (`POST /api/sessions/:id/approvals/:aid`) or `/approve` / `/deny` in the terminal; stopping the run declines. No approver means *denied*: headless runs, sub-agents and **guests' agents** (the host gives an admin port only to the owner's own sessions) cannot use these tools at all. The change itself goes through `AdminPort` — one implementation shared by both front ends. A custom mode that does not list a tool cannot use it; `skill_write`, `skill_toggle` and `mcp_manage` are build-only, `switch_mode` also works in plan.

**Per-session switches:** `config.disabledSkills` and `config.disabledMcp` hide a skill (from the prompt, so `/skill-name` refuses it) or an MCP server (its tools and its line in the prompt) for one session only. Browser: *Tools* tab of the side panel (`POST /api/sessions/:id/toggle`); terminal: `/disable <name>` and `/enable <name>`.

## 7.6 Hosting and shared sessions (`src/server`)

`vara ui` / `vara serve` runs a **host** on your machine: a local HTTP server (REST for commands + Server-Sent Events for live output, no dependencies). The engine, keys and folder are all yours; a guest sends text and receives events — no key ever reaches them.

| File | Responsibility |
| --- | --- |
| `access.ts` | Roles and powers (`Grant`), invites and guests (tokens stored only as SHA-256), and `authorize()` — **the single decision point** |
| `host.ts` | `VaraHost`: hosts sessions and runners, a per-session event buffer (replay with `after=id`), per-guest usage, per-session extras (insights, markdown export, stop, task↔goal, project file search for `@`) |
| `http.ts` | The server and its hardening; routes |
| `manage.ts` | `Manager`: owner-only management of providers, models, settings, skills and MCP (`/api/manage/*`). Every change goes through one queue and then `apply()`, which builds the provider **first** (a change that cannot work — e.g. a missing key — is refused before it is saved). Network and vault dependencies are injected for tests. |
| `commands.ts` | `vara ui/serve/invite/guests`; owns the live config and swaps the provider when settings change |
| `ui-assets.ts` | Generated (git-ignored) from `ui/` by `scripts/build-ui.mjs`: the esbuild bundle of the React UI embedded as strings, served at `/`, `/join/*` and `/assets/*` with a strict CSP. The owner token arrives in `#token=`, is moved to sessionStorage and removed from the address bar; powers are computed on the server (`view.can`) and the UI only displays them. |

**API surface:** `GET /api/me`, `/api/models`, `/api/files?q=` (owner); `/api/sessions` (list, create), `/api/sessions/:id` (get), `…/messages`, `…/pause`, `…/mode`, `…/model`, `…/share`, `…/kind`, `…/stop`, `…/events` (SSE), `…/insights`, `…/export`; `/api/admin/*` (overview, invites, guests — owner only); `/api/manage/*` (providers, settings, skills, MCP — owner only).

**Also:** `POST /api/uploads` (raw bytes, `x-file-name`; returns an id to send as `attachments:[…]` with a message), `GET /api/sessions/:id/attachments/:file` (whoever can read the session), `GET|POST|DELETE /api/sessions/:id/preview` (owner only).

**Roles:** the owner (everything) · a guest with a `Grant`: `watch` (see the shared session), `sendShared` (write in it — the model receives it prefixed `[from <name>]`), `ownSession` (their own session in the same folder), `modelPolicy` (`locked` | `list` | `any`), `mode` as a power ceiling (`plan` = read-only | `build`) and `canChangeMode`, `canInterrupt`, caps `maxModelCalls`/`maxCostUsd`, and an expiry. Presets: `viewer` · `participant` · `collaborator`. The owner can edit or revoke a grant and it takes effect on the guest's **next request** (their agents are stopped within seconds).

**Rules that are never broken:**
1. Permissions are enforced in `authorize()` on the server, not in the interface.
2. Another guest's session **does not exist** for you (404, not 403).
3. The working folder is always the host's; a guest does not choose it, and `allowPublish` is off for their sessions.
4. Unknown cost ≠ zero: the cap that protects the owner when cost is unknown is `maxModelCalls`.
5. The model's private reasoning is streamed to the owner only.
6. Management (providers, keys, settings, skills, MCP), `@file` attachments and project file search are owner-only; no key is ever returned in any response.

**Hardening:** binds to `127.0.0.1` unless `--lan` is given; a secret token on every call (the owner's is random per run and travels in the URL fragment, so it is never sent to the server); `Host` check (blocks DNS rebinding — on a LAN only private IP addresses are accepted, not domain names) and `Origin` check (blocks cross-site requests); rate limits on failed attempts and invite guessing; a body size limit; security headers (strict CSP, no framing, no sniffing); internal errors are never leaked to the client.

> **Core warning:** a guest with `build` power is an agent running commands on **your machine**. The default is `plan` (read-only); the owner must raise it explicitly, and the tool warns when the invite is created. Remote access (outside your network) goes through a tunnel — one you run yourself (`--public-host`) or the temporary one VARA opens for you (`--share`, §7.7); VARA has no relay server of its own.

---

## 7.7 Attachments, live preview, public link, updates

| Piece | Where | The rule that matters |
| --- | --- | --- |
| **Attachments** | `core/attachments.ts`, `server/uploads.ts`, `tui/mentions.ts` | A file is judged by its **bytes** (PNG/JPEG/GIF/WebP, PDF, text; SVG and binaries refused). An image waits in staging (`~/.vara/uploads`, bound to who uploaded it, expires in 1 h), is moved into `sessions/<id>/attachments/` when its message is sent, and the transcript holds only `<image id="…"/>`. The id must match a fixed pattern and is resolved **inside that session's folder only**; typed text is `neutralize()`d so nobody can forge a marker. |
| **Vision** | `llm/capabilities.ts` (`visionSupport`), engine `toModelMessages` | Detected from the model id or the provider's list (`models[].vision` overrides). With vision the marker becomes an image block (OpenAI `image_url` data URL / Anthropic `image` base64); without, a one-line honest note. Each image counts ~1,600 tokens against the context budget. |
| **Live preview** | `preview/manager.ts`, `tools/preview-tool.ts` | The dev server runs with `PORT` set; VARA fronts it with a reverse proxy on **127.0.0.1 and its own port** (own origin, websockets relayed, `Host` checked, framing limited to the host page). The web UI frames it with `sandbox`. The tool is build-mode only and obeys the same command policy as `shell`. API `/api/sessions/:id/preview` is **owner-only** (404 for guests). |
| **Public link** | `server/tunnel.ts`, `server/share.ts` | A tunnel *provider* is a recipe (binary, arguments, how to spot the public URL): cloudflared quick tunnel, or an ssh reverse tunnel. On a request whose `Host` is the tunnel's: the **owner token is refused**, rate limits use the forwarded client address in their own namespace (so strangers cannot lock the owner out), `/api/me` tells the owner the link is live. Torn down on expiry, tunnel death or host close. |
| **Updates** | `update/updater.ts` | Latest stable release → archive for this OS → SHA-256 against `SHA256SUMS.txt` → unpack → run the new `--version` and require the release's version → swap entry by entry (atomic renames; unchanged launchers untouched) with the old files kept in `<install>.prev`; any failure restores. Only for the packaged install. The notice checks once a day, never throws, and is off with `updates.check=false` or `VARA_NO_UPDATE_CHECK`. Network, extraction and process execution are injected for tests. |

---

## 8. Security

| Component | What it does |
| --- | --- |
| `security/vault.ts` | AES-256-GCM. The master key is generated locally and protected by **DPAPI** (Windows) or the login **Keychain** (macOS); elsewhere it is a `0600` file. Secrets carry a scope (`global` or a session scope). Nothing is unlocked when no secret is stored. |
| `security/redact.ts` | Every text leaving a tool or the model passes `scrubAll` before saving: known key patterns plus every secret registered live are wiped. |
| `.gitignore` | `.env` and variants are ignored; only `.env.example` is tracked. |

**Non-negotiable:** any new path that shows model or tool output must pass `scrubAll` before it is saved or displayed.

---

## 9. Terminal UI

- **Ink** (React for the terminal). State lives in `App.tsx`; rendering is in small components (`home`, `palette`, `sessions`, `entries`, `markdown`, `sidebar`, `tabs`, `settings`, `providers`, `mcp`, `format`). **Theme** `theme.ts`: a live palette swapped in place (`applyTheme`).
- **Frame stability:** full-screen mode (alternate buffer) with a frame of `rows-1` height (a frame as tall as the terminal makes Ink redraw everything); fixed rows are `flexShrink={0}`, otherwise they are squeezed when content overflows. Streaming updates are batched every 80 ms. Scrolling: mouse wheel (SGR 1006) or arrow keys.
- **`resolveKey` in `keymap.ts` is the only input policy:** every key becomes one `KeyAction`; labels and tests derive from it. No competing scattered handlers.
- **Documented design lesson:** `useInput` is re-attached on every render and a key can arrive before effects run, so a bound handler could read a stale closure. The fix: **ref mirrors** written every render (`overlayRef`, `escArmedRef`, `draftKindRef`…) from which the handler reads exclusively.
- `Esc` closes the layer at **application level** in `resolveKey` — it works even before an overlay's subscription attaches, and `onClose` closes again safely (idempotent).
- Multi-character input arriving as one chunk is a paste; its line breaks are kept.

The reference list of shortcuts is `KEYS_HELP` in `tui/commands.ts` (shown by `/help`).

## 9.1 Web UI (`ui/`)

React 18 bundled by esbuild into the host (see `ui-assets.ts`). Key points:

- **Same powers, one source:** the UI shows controls from what the server computed (`view.can`, `me.role`), never from guesses.
- **Safe rendering:** a small markdown parser produces nodes (no `innerHTML`); only `http(s)` and `mailto` links are clickable.
- **Live updates:** `fetch`-based SSE so the token stays in a header; reconnects with backoff and resumes after the last event id.
- **Commands everywhere:** one command list (`ui/src/commands.ts`) feeds `/` in the message box, the palette (`Ctrl K`) and help; a command that is not allowed for the person is simply absent.
- **Pages:** home (start screen), session (conversation, composer, side panel with Proof / Cost / Files), Team (owner), Settings (owner: models & providers, agent, skills, MCP; everyone: look & feel, this host). English and Arabic (`i18n.ts`, right-to-left via logical CSS properties), 9 themes, a mobile layout.
- **Owner token** lives in sessionStorage; a guest's in localStorage. Tests cover the pure logic (`tests/ui-logic.test.ts`).

---

## 10. Data on disk

```
~/.vara/                    # moved entirely by the VARA_HOME environment variable
├── config.json             # settings (no secrets — only the names of secrets)
├── vault/                  # encrypted secrets + the device-protected key bundle
├── host/                   # shared-session state: invites, guests, last server address
├── skills/<name>/SKILL.md  # your skills (projects add <cwd>/.vara/skills)
└── sessions/<id>/
    ├── state.json          # full state snapshot (Session)
    └── events.jsonl        # complete event log (append-only)
```

**The choice:** state is kept as a snapshot plus an event log, not one log that overwrites itself. Resume reads the snapshot; the log stays for archive and diagnosis — so a crash mid-write cannot corrupt history. Snapshots are saved atomically (write, then rename), so a second reader never sees a half-written file.

Sessions are filtered by `cwd` (with a Windows-safe comparison) — `vara sessions` lists the current folder's sessions only (`--all` for every folder).

---

## 11. Current design limits

These are **deliberate decisions**, not omissions:

- **Context is trimmed, not summarised** — old text is dropped as the window fills. Smart summarisation is deferred.
- **Pricing is limited to the registry** — an unregistered model has cost `null` by design (more correct than guessing).
- **The provider is chosen per session, not per turn** — a session stores the model name, not the provider, so reopening an old session after switching provider may send a model name the new provider does not know.
- **Stall detection is simple** (counting empty turns) — a finer detector is deferred.
- **Remote guests need a tunnel** — one you run (`--public-host`) or `--share`, which uses cloudflared or ssh; there is no VARA relay. The preview is never offered to guests.
- **A PDF is attached as its extracted text** (simple text PDFs; scanned or encrypted ones are refused with a reason) — no layout, no images.
- **`vara update`'s checksum list comes from the same release as the archive**, so it detects corruption and wrong files, not a compromised release.
