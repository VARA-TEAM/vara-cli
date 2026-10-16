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
| Memory · proposals | `src/core/memory.ts`, `proposals.ts`, `tools/memory-tool.ts`, `tools/proposal-tool.ts` | Notes that persist between sessions (token-budgeted, secrets refused); skills the agent proposes (the owner approves) — [AUTOMATION.md](AUTOMATION.md) |
| Schedule | `src/schedule/*` | `vara schedule`: interval / cron specs, job store, headless runs with a log (off by default, local owner only) |
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

**Cost engine v2** (full detail, research and measured numbers: [COST.md](COST.md)) adds, all in new files except a few small hooks in `engine.ts`:

| Mechanism | File | Effect |
| --- | --- | --- |
| **Model router** (strong / standard / cheap, quality floor, escalation, hysteresis, eco, visible reason) | `core/router.ts`, `core/cost-wiring.ts` | the engine asks `decideRoute()` every turn and emits a `route` event; tiers may live on another configured provider (`EngineOptions.providerFor`) |
| **Output compression** + `tool_output` + identical-output pointers | `core/outputs.ts`, `tools/repo-tools.ts` | long command output keeps head, tail and error lines; the full text is stored per session and one tool call away |
| **Repo map**, `read_symbol`, outline for long files | `core/repomap.ts`, `tools/repo-tools.ts`, `tools/fs-tools.ts` | find code without reading files |
| **Summaries** of old turns (R5) | `core/summarize.ts` | one cheap-model call; messages are marked `summarized`, never deleted |
| **Four Anthropic breakpoints**, `prompt_cache_key` | `llm/cache.ts`, `llm/openai.ts` | cache survives unusual turns |
| **Waste control**: loop stop, skipped re-verification, parallel read-only tools (R4) | `engine.ts` | active when `EngineOptions.costSettings` is present |
| **Usage meter**: limit, pace, plan-percentage calibration, savings report, eco | `core/usage-meter.ts`, `core/cost-report.ts`, `server/cost-api.ts` | ledger `~/.vara/usage.jsonl`; `/limit`, `/savings`, `/route`; web `CostMeter`/`CostBoard` |

Every mechanism that changes what the model sees (compression, summaries, outline, loop stop, parallel reads, verification reuse) is off unless `EngineOptions.costSettings` is present, and the router with no tiers configured reproduces v0.4.0's model choice; `makeSessionRunner` passes everything through `costExtras()`. Always on: compaction keeps error lines, the four Anthropic breakpoints, two guidance lines in the work prompt, and the `route` event.

Counters live in `session.savings`, shown by `/cost`, the terminal side panel and the web *Cost* tab (which also estimates dollar savings from cache and compaction when pricing is known). Sub-agent cost is added to the parent's ledger so the numbers stay honest.

## 7.3 Sub-agents and the swarm (`delegate`)

`delegate` calls `Engine.spawnSubagents`, which validates a plan (`planSwarm` in `core/swarm.ts`) and runs it (`runSwarm`). A plan is up to 4 tasks; each may have an `id`, a **role** and `dependsOn`.

- **Roles:** `researcher` and `reviewer` are read-only, `implementer` and `tester` may edit files; a role adds its instructions to the sub-agent's prompt. Your own roles go in `config.json` → `swarm.roles`. An explicit `kind` beats the role; in PLAN mode every task is read-only.
- **Shared task list:** every sub-agent is shown the whole plan (who does what) and, for a task that depends on others, the reports of those tasks. A task starts only when its dependencies are done; if one fails, what depends on it is skipped and the rest still runs. A plan with an unknown id, a duplicate or a cycle is refused with a reason the model can act on.
- **Limits** (`config.json` → `swarm`, also Settings → Agent): `maxTasks` ≤ 4 and `maxParallel` ≤ 3 can only be *lowered*; `maxModelCalls` (default 120) is spent by the whole swarm and no new sub-agent starts after it; `maxCostUsd` stops new sub-agents once the **known** cost reaches it. Unknown cost is never counted as zero, so the call cap is the guard that always works.
- **One merged report:** a header (done / failed / skipped, calls, cost) and every report in plan order; if a file-editing agent ran, the parent is told to verify before claiming anything.
- **Live:** each status change is a `subagent` event (id, title, role, dependsOn, status `waiting|running|done|failed|skipped`, plus `swarm` — which `delegate` call —, `kind`, `steps`, and when finished `calls`, `costUsd` (`null` = unknown, never 0), the scrubbed `report` and `cancelled`); a `swarm_report` event carries the merged report and totals. The terminal shows them in the conversation, in a side-panel section and in `/agents` (§9); the browser as a board.
- **Cancel:** `Engine.cancelSubagents(id?)` (via `SessionRunner.cancelAgents`) stops one running sub-agent or, with no id, the whole swarm: running ones are stopped (`child.stop()`), queued ones are skipped (`runSwarm`'s `shouldStop`), a cancelled agent reports `failed` + `cancelled`, and what depended on it is skipped by the normal rule. A sub-agent that ends *paused / stopped / interrupted* (a provider error, its own budget) is reported **failed**, whatever text it left.
- **Using it well:** the work prompt (`DELEGATION_NOTE` in `core/prompt.ts`) and the `delegate` description say: send every independent task in ONE call (they run together), give roles, make prompts self-contained, order with `id`/`dependsOn`, verify the merged report. `tests/delegation-eval.test.ts` measures it with a scripted model: three reviews in one call overlap (peak concurrency 3, measured), a dependency serialises, a failure skips dependants, a cancel stops one agent.

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

**A system-aware agent (`core/systeminfo.ts`, `tools/system-tools.ts`).** The agent also knows its own environment, like an assistant that can open its own settings. `AdminPort.system` (only in the owner's own sessions — the host never gives it to a guest, a sub-agent or a headless run) adds:
- **`vara_system` (read-only):** `overview`, `settings`, `providers`, `skills`, `skill <name>`, `mcp`, `connectors`, `modes`, `sessions` (this folder, another `folder`, or `all`), `session <id>` (`summary|transcript|usage|evidence`), `usage`, `update`, `host`. Offered in questions, plan mode and work turns of a session that can ask the owner; never in plain chat.
- **Changes, each behind `ctx.approve()` with the exact change on the card:** `skill_delete`, `mode_manage` (create / replace / delete a custom mode), `setting_change` (an allow-list: `agent.autoIntent|defaultMode|cheapModel`, `ui.*`, `swarm.*`, `updates.check`, task/goal budgets — **never** `allowPublish`, `agent.browser`, `agent.desktop`, the verify command, providers, keys), `connector_manage` (a connector that needs a token only connects when the token is already in the vault). With `skill_write`, `skill_toggle`, `mcp_manage` and `switch_mode` from above, "make me a skill", "install an MCP server", "turn off skill Q here", "switch to mode M" are all things the agent does itself, after a yes.
- **Prompt and skills:** `SELF_MANAGE_NOTE` (static, so the prompt stays cache-stable) is added only when the port exists; built-in skills `create-skill`, `setup-mcp` and `vara-environment` teach the procedure.

**The privacy rule — enforced in code, tested in `tests/system-privacy.test.ts`:** no tool in this family can return a secret. The vault is asked for **names only** (`namesOnly`: the listing's `hint` carries the first characters of a value and is never passed on); provider keys are `vault | env | none` plus the secret's *name*; MCP `env`, headers and `secretEnv` are listed by name, URLs lose credentials, query and fragment, and arguments after `--token`/`--api-key`/… are hidden; everything else — other sessions' transcripts, skill bodies, server errors — goes through `scrubSystem` (`security/redact.ts`: everything `scrubAll` removes plus `password=…`-style assignments, JWTs, well-known token shapes and VARA's own 43-character token format) and transcripts are wrapped as `UNTRUSTED_SESSION_DATA`. No query takes a path: a session is found by id through the session store (an id is `[A-Za-z0-9-]{3,64}`), so nothing here can open `~/.vara/vault` or `~/.vara/host`. Sessions of other folders are readable only because only the owner's agent has the port.

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

**As a service (`vara serve`, `server/daemon.ts`, `server/doctor-server.ts`; guide: [DEPLOYMENT.md](DEPLOYMENT.md)).** `parseServeSettings` turns flags and `VARA_*` variables into one validated object (an empty variable means "not set"; bad port, `--lan` with `--bind`, a short or doubled token, a malformed `--public-host` are refused with a reason; a non-loopback bind always warns). The owner's credential is a **digest**: `resolveOwnerAuth` uses a provided token (file / variable / flag — never stored, never printed) or the SHA-256 saved in `host/owner-token.sha256` (`0600`) by an earlier start, or makes a token, returns it ONCE to be printed and saves only its digest (`--rotate-token` replaces it). `startServer({ ownerTokenDigest, trustProxy })` compares in constant time and, behind a trusted proxy, counts failed logins per the last `X-Forwarded-For` entry (own namespace). `makeLogger` writes `text`, `json` or `journal` (syslog `<N>` priorities) and never logs a request. `makeShutdown` runs the steps in order, once, with a per-step timeout (stop sessions, close the public link, drop connections, close MCP), and a second signal exits at once. `/api/health` (no auth) is the probe for Docker and proxies. `vara doctor --server` checks the whole setup with injectable probes.

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

## 7.8 Browser use, desktop control, connectors, project instructions

**Browser (`src/browser/`, `src/tools/browser-tool.ts`).** The `browser` tool drives a real Chrome/Edge/Chromium/Brave found on the machine (VARA ships no browser) through the DevTools Protocol, with no new dependency (the WebSocket built into Node 22+; the release packages bundle Node 22). Each launch uses a **fresh throw-away profile** under `~/.vara/browser`, never the user's own browser, so nothing they are signed in to is reachable. Safety is enforced in code, not by asking the model to behave:
- `policy.ts` (pure, tested): `localhost` is always allowed; other sites need approval (once per site per session); private networks, link-local and cloud-metadata addresses are refused; a small built-in list of banking/crypto sites is always refused; every sub-request the page makes is checked too, so a page cannot send data to a host nobody approved; downloads are refused.
- The agent never types into password or payment fields (`isSecretField`); controls that look irreversible (pay, delete, send, submit…) and pressing Enter to submit each need approval; with nobody to approve (guests, headless runs) they are refused.
- Page text comes back inside an `UNTRUSTED_WEB_CONTENT` boundary with a reminder that it is data. This reduces, but cannot remove, prompt-injection risk — the controls above (origin, approval, no secrets) are what limit the damage.
- A screenshot is saved in the session's `attachments/` folder and returned as an image marker; the engine appends one hidden `[ENGINE]` message with the markers after all tool results of the turn (see ROADMAP R9), so vision models see it. Off by default: `agent.browser`.

**Desktop (`src/desktop/`, `src/tools/desktop-tool.ts`).** The `desktop` tool takes screenshots and moves the mouse/types like a person: PowerShell + user32 on Windows (verified on Windows 10), `screencapture` + AppleScript on macOS and `xdotool` + `scrot`/ImageMagick on Linux (written to the same interface but **not verified** in this build). Off by default (`agent.desktop`), offered only in sessions that can ask the owner, approved once per session, and never for guests, headless runs or public links. It refuses to act while a password-manager, bank, sign-in or security-prompt window is in front, never sends keys that leave the app (Win+R, Ctrl+Alt+Del, Alt+F4…), pastes non-ASCII or long text instead of typing it, keeps an action budget (40 a minute, 300 a session), returns a screenshot after every action as evidence, and has a **kill switch**: pausing or stopping the session cancels the next action at once (`killDesktop`, called from `SessionRunner.pause`). Coordinates are in the pixels of the last screenshot (downscaled to 1280 wide); `policy.ts` maps them back.

**Connectors (`src/mcp/connectors.ts`).** A catalogue of ready-made MCP servers (Filesystem, Memory, Sequential thinking, Context7, Fetch, Playwright, GitHub, Notion, Sentry, Supabase). Adding one stores its token(s) in the encrypted vault and writes an ordinary MCP server entry named after the connector, so it shows in `/mcp`, can be switched off per session and its tools reach the agent like any MCP tool. Only packages/endpoints that were checked are listed (each entry says how); the `*-remote` entries sign in with OAuth (`src/mcp/oauth.ts`, [docs/OAUTH.md](OAUTH.md)): discovery, dynamic client registration, PKCE, loopback redirect plus a paste fallback, refresh, revoke; the tokens are one vault secret per connector (`OAUTH_TOKENS_<ID>`), handed only to the HTTP transport (`McpClient`'s token provider, refreshed on expiry and once after a 401) and never to the agent, the API or the UI. The owner endpoints are `/api/manage/connectors/:id/login|login/code|logout`. Web: Settings → Connectors; terminal: `/connectors`, `vara connectors add <id>` (asks for the token without echoing it).

**Project instructions and verification (`src/core/project.ts`).** When a session is created VARA reads `VARA.md`, else `AGENTS.md`, else `CLAUDE.md`, else `.vara/instructions.md` (first found, 8,000 characters at most) and keeps it with the session, so the system prompt is identical every turn. It is labelled as repository data: guidance, never permission. If no verify command is configured, one is detected from the project (`npm`/`pnpm`/`yarn test` when a real test script exists, `cargo test`, `go test ./...`, `pytest`) — and nothing when unsure.

**The visible plan.** The read-only `todo` tool keeps a checklist; the web side panel shows the newest one (and plan mode allows it).

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

- **Agents (`tui/agents.ts`, `agents-view.tsx`):** a pure reducer folds `subagent` / `swarm_report` events into swarms of rows (status, role, dependencies, steps, calls, cost — unknown shown as "cost unknown", never `$0`), the single source for the three views: one line per agent in the conversation (replaced in place as it changes) plus a summary line when the swarm ends; a side-panel section (`ui.sections.agents`, Settings → Side panel) showing the latest swarm; and the `/agents` overlay (↑↓ pick, Enter report, `c` cancel it, `C` cancel all, `m` merged report, ←/→ older swarms). `/agents cancel <id|all>`, `/agents report`, `/agents list` work without the overlay. Settings → Agents has the swarm limits (tasks ≤ 4, parallel ≤ 3 — they can only be lowered —, model-call budget, cost cap).

The reference list of shortcuts is `KEYS_HELP` in `tui/commands.ts` (shown by `/help`).

## 9.1 Web UI (`ui/`)

React 18 bundled by esbuild into the host (see `ui-assets.ts`). Key points:

- **Same powers, one source:** the UI shows controls from what the server computed (`view.can`, `me.role`), never from guesses.
- **Safe rendering:** a small markdown parser produces nodes (no `innerHTML`); only `http(s)` and `mailto` links are clickable.
- **Live updates:** `fetch`-based SSE so the token stays in a header; reconnects with backoff and resumes after the last event id. Events carry the host's timestamp, so a replay after a reload keeps the real timeline.
- **Commands everywhere:** one command list (`ui/src/commands.ts`) feeds `/` in the message box, the palette (`Ctrl K`) and `/help`; a command that is not allowed for the person is simply absent.
- **A workbench, not a page** (`Workbench.tsx`): sidebar | tab strip with one or two sessions | side panel | bottom dock | status bar.
  - *Resizing is pure math* (`layout.ts`, unit-tested). Drag a handle, or focus it and press ← → (↑ ↓ for the dock); Shift takes 64 px instead of 16, Home / End go to the limits, Enter or a double click resets that pane. Handles are real ARIA separators (`aria-valuenow`). Limits: sidebar 200–440 px, side panel 280–720 px, dock 120–640 px. The conversation never gets narrower than 360 px: the side panel gives way first, then the sidebar, and the saved sizes are left alone, so a larger window brings the layout back.
  - *Layouts:* status bar → Layout, or `/layout-focus`, `/layout-review`, `/layout-swarm`, `/layout-preview`; `/layout-reset` restores the default. Remembered per browser (`localStorage`: `vara.layout.v1`, open tabs `vara.tabs.v1`, folder scope `vara.scope`) and never sent to the host.
  - *Tabs* (`tabs.ts`): open sessions are tabs (at most 12). Drag a tab to reorder it, or onto the right half of the conversation to open it beside the current one (split view, two sessions, from 1100 px wide); the divider between them resizes like the others. From the keyboard: Alt ← / → switch, Alt Shift ← / → move, Delete closes. A tab whose session no longer exists is dropped.
  - *Side panel* of the focused session: Proof, Cost, Agents, Files, Tools. *Dock:* Output (a terminal-like feed of what ran and what came back; `/last` jumps to the last call), Preview (the running app), Events (this page's live event log).
  - Below 900 px the side panel and the dock become drawers, the sidebar a menu, and split view is off.
- **Sub-agents are first-class** (`swarm-model.ts`, `AgentsPanel.tsx`, tested): every `delegate` call is a *run*. A run is rebuilt from two sources: the saved conversation (the call's plan and its merged report; survives a reload) and the live `subagent` / `swarm_report` events. The Agents panel shows the run's state, a **Trace** (one lane per agent on a shared time axis, elbow lines for dependencies; runs read back from the saved conversation have no timestamps, so their lanes are placed by dependency level and the panel says so) or a list, each agent's steps, calls, cost and report, and the merged report. The conversation draws the same team inline, the session header and the status bar show `n of m running`, and `Ctrl Shift A` or `/agents` opens the panel. **Cost is never invented:** a finished agent's calls and cost come from the host, an unknown cost shows as *unknown* (never `$0`), and the running total is "at least" while any agent's cost is unknown. A host that sends no per-agent figures falls back to the merged report's totals. **Cancel:** `POST /api/sessions/:id/agents/cancel` with `{ "id": "<task>" }` cancels one running agent, with no id the whole swarm; the session itself carries on (pause and stop are separate buttons).
- **Pages:** home (start screen), session (conversation, composer), Team (owner), Settings (owner: models & providers, agent, skills, connectors, MCP; everyone: look & feel, this host). English and Arabic (`i18n.ts`, right-to-left via logical CSS properties, including the layout and the trace), 9 themes, a mobile layout, visible keyboard focus, reduced motion respected.
- **Owner token** lives in sessionStorage; a guest's in localStorage. Tests cover the pure logic (`tests/ui-logic.test.ts`, `tests/ui-workbench.test.ts`) and the routes the UI depends on (`tests/agents-http.test.ts`).

### Terminal ↔ browser parity

The terminal is the reference. `ui/src/parity.ts` lists, for every command, key action and full-screen form of the terminal, where it lives in the browser; `tests/ui-workbench.test.ts` fails when a terminal command or key action has no row, when a row names a command the browser does not register, and when these tables stop matching the data. *Adapted* means the same job done the browser's way (the browser keeps Ctrl N, Ctrl W and Tab for itself, so those have other keys); *planned* means the terminal has it and the browser does not yet.

<!-- parity:begin -->

### Commands

| Terminal command | In the browser | Same? |
| --- | --- | --- |
| `/new` | New session tab (Ctrl Shift O); the + button in the tab strip | same |
| `/palette` | Command palette (Ctrl K) | same |
| `/sessions` | Sidebar filter and the "this folder / all folders" switch; /sessions --all | same |
| `/resume` | Open by the start of an id, or click a session in the sidebar | same |
| `/mode` | Mode menu in the message box; Alt M flips plan/build | same |
| `/kind` | In a session: task or goal; Auto is chosen on the start screen | adapted |
| `/providers` | Settings → Models & providers | same |
| `/provider` | Makes another provider (and optionally a model) the default | same |
| `/model` | Model menu in the message box | same |
| `/models` | Settings → Models: status, context and thinking per model, with a filter | same |
| `/context` | Side panel → Cost: window, usage and where the size comes from | same |
| `/settings` | Settings (Ctrl O) | same |
| `/theme` | Nine themes; Settings → Look and feel | same |
| `/agents` | Side panel → Agents (Ctrl Shift A): roles, status, trace, calls and cost, reports; cancel one agent or all | same |
| `/mcp` | Settings → MCP servers (add, switch, reconnect, remove) | same |
| `/connectors` | Settings → Connectors (guided token entry) | same |
| `/think` | Thinking menu in the message box | same |
| `/gateway` | /gateway opens Settings → Gateways: the whole setup (token, pairing code, on/off) on one page | same |
| `/undo` | /undo in the message box or the palette | same |
| `/checkpoints` | The list is not shown in the browser yet; /undo works | planned |
| `/compact` | /compact in the message box or the palette; auto-compact runs on its own | same |
| `/autocompact` | On by default; the web switch for it is not built yet (config context.autoCompact) | planned |
| `/cost` | Side panel → Cost, and the status bar | same |
| `/limit` | Not in the browser yet: arrives with the cost-engine board | planned |
| `/savings` | Not in the browser yet: the Cost tab shows this session’s savings; the 7-day and all-time view arrives with the cost-engine board | planned |
| `/route` | Not in the browser yet: arrives with the cost-engine board | planned |
| `/attach` | Clip button, drag and drop, paste; /attach opens the file picker | same |
| `/preview` | Bottom dock → Preview; /preview start <command>, stop, logs | same |
| `/export` | Downloads the conversation as a markdown file (the browser picks the folder) | adapted |
| `/skills` | Settings → Skills (list, create, edit, switch; skills the agent proposed wait at the top for your approval) | same |
| `/memory` | Settings → Memory (edit both note files, switch memory on or off) | same |
| `/skill` | Makes the agent apply a skill now; each skill is also its own /name | same |
| `/status` | Side panel → Proof: turns, calls, time limit, context, evidence | same |
| `/evidence` | Side panel → Proof: the evidence timeline | same |
| `/last` | Bottom dock → Output, scrolled to the last tool call | same |
| `/pause` | Pause button; Esc twice | same |
| `/enable` | Side panel → Tools, per session; /enable <skill\|server> | same |
| `/disable` | Side panel → Tools, per session; /disable <skill\|server> | same |
| `/approve` | Approval cards above the message box; /approve [id] | same |
| `/deny` | Approval cards above the message box; /deny [id] | same |
| `/stop` | Session menu → Stop (the page stays open) | same |
| `/quit` | Close the tab; the session is saved as it runs (guests: Sign out) | not applicable |
| `/help` | Help and shortcuts (commands and both keyboards) | same |

### Keys

| Terminal key action | In the browser | Same? |
| --- | --- | --- |
| `quit` | Not needed: the host keeps running; close the tab | not applicable |
| `overlay-input` | Dialogs and menus own the keyboard while open | same |
| `close-overlay` | Esc closes a dialog or menu | same |
| `open-palette` | Ctrl K | same |
| `open-settings` | Ctrl O | same |
| `open-home` | Ctrl Shift O (the browser keeps Ctrl N) | adapted |
| `close-home` | Close the tab, or open a session | same |
| `home-move` | Tab and arrow keys through the recent list | same |
| `arm-interrupt` | Esc once in the message box while an agent runs | same |
| `interrupt` | Esc a second time pauses it | same |
| `toggle-sidebar` | Ctrl B hides the sidebar; Ctrl . the side panel | adapted |
| `close-tab` | Alt W (the browser keeps Ctrl W) | adapted |
| `switch-tab` | Alt ← / Alt →; Alt Shift ← / → moves a tab | same |
| `scroll` | Page Up / Page Down in the conversation | same |
| `scroll-line` | Arrow keys and the wheel | same |
| `complete` | The / and @ menus in the message box (Tab or Enter picks) | same |
| `click` | Click (the browser is mouse-first) | same |
| `wheel` | Mouse wheel and touch scrolling | same |
| `scroll-latest` | Ctrl G, or the "New messages" button | same |
| `toggle-mode` | Alt M (Tab stays for moving focus) | adapted |
| `toggle-kind` | The Kind menu on the start screen | adapted |
| `submit` | Enter | same |
| `newline` | Shift Enter or Ctrl J | same |
| `delete-back` | Backspace (native text field) | same |
| `text` | Typing and pasting (native text field) | same |
| `none` | No effect | same |

### Full-screen forms

| Terminal screen or key | In the browser | Same? |
| --- | --- | --- |
| Providers: Enter use · k key · d remove | Settings → Models: Use, key field, remove provider | same |
| Models: t test · a test all · r refresh | Test, Test all, Fetch models | same |
| Models: c context · h thinking | Context dialog, Thinking menu on each model | same |
| Models: n add · x remove | Add a model field, Remove | same |
| Models: / filter | Filter field above the model list (more than six models) | same |
| MCP: Enter add · t on/off · r reconnect · d remove | Settings → MCP servers: Add, switch, Reconnect, Remove | same |
| Sessions overlay: type to filter · Tab scope · Enter open | Sidebar filter · folder/all switch · Enter opens the first match | same |
| Settings: theme, mode, verify command, cheap model, budgets, context, skills | Settings → Agent, Skills, Look and feel | same |
| Start screen: recent sessions, Ctrl N tabs | Home page and session tabs | same |

<!-- parity:end -->

---

## 10. Data on disk

```
~/.vara/                    # moved entirely by the VARA_HOME environment variable
├── config.json             # settings (no secrets — only the names of secrets)
├── vault/                  # encrypted secrets + the device-protected key bundle
├── host/                   # shared-session state: invites, guests, last server address
├── skills/<name>/SKILL.md  # your skills (projects add <cwd>/.vara/skills)
├── memory/MEMORY.md        # your cross-session notes (projects add <cwd>/.vara/memory.md)
├── proposals/<id>.json     # skills the agent proposed, waiting for you
├── schedules.json          # scheduled jobs; schedules/<id>.log = their logs
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
