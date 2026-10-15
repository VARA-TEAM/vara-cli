# Roadmap — VARA

**English** · [العربية](ar/ROADMAP.md)

What is left, in what order, and how to do it safely. **Read this file before proposing a feature or starting work.**

---

## 0. How to choose what to work on

1. **One branch from `main` per item** — one item, not two. Small batches get reviewed and merged quickly; big ones stall and are abandoned.
2. **Proof is mandatory:** a test that fails before the fix and passes after. No exceptions.
3. **`npm run check` is green before every push** — a failure is reported as it is, never frozen or bypassed.
4. **Disputes are settled by experiment:** a small test shows who is right — no circular debate.
5. **Update `CHANGELOG.md` (and `CHANGELOG.ar.md`) in the same batch** — if it is not there, it did not happen.

---

## 1. Done

- ~~R1 · Trim context by tokens instead of characters~~ — `toModelMessages` honours the real `requestBudgetTokens` from `context.ts` (newest to oldest, dropping the oldest tool output first, never dropping a message that carries `toolCalls`), and stall detection is unified (`noteNoProgress`).
- ~~Multiple providers · MCP · sub-agents · the cost-saving engine · intent routing · thinking levels · skills~~
- ~~Shared sessions (invites, roles, permissions) and the browser interface — with every terminal feature available in it~~ (see `CHANGELOG.md`)
- ~~R8 · Agent self-control: custom modes, self-management tools with approval, per-session skill/MCP switches, sub-agent swarm~~ (see §7.3, §7.6.1, §7.7 of `ARCHITECTURE.md`)
- ~~Self-contained releases for Windows x64, macOS arm64 and Linux x64 with one-command installers~~

## 2. Ready to do (by priority)

### ~~R2 · Automatic verify commands by project type~~ — done (`core/project.ts`: detects npm/pnpm/yarn/cargo/go/pytest, nothing when unsure)
- **Idea:** detect `package.json` / `pyproject.toml` / `Cargo.toml` and suggest the verify command (`npm test` / `pytest` / `cargo test`) instead of leaving it empty.
- **Proof:** a test per project type, and an explicit refusal when the type is unknown (no guessing).

### R3 · Scheduled, recurring goal sessions
- **Idea:** a goal re-evaluated periodically ("review this branch every morning") instead of a session that runs once.
- **Constraint:** the biggest architectural item — discuss the design with the team first (the shape of renewal, budget limits, what prevents repetition).

### R4 · Run read tools in parallel within one turn
- **Idea:** several `read_file`/`grep`/`glob` calls in one turn run together (writing tools stay sequential).
- **Effect:** speed, not cost saving. Sub-agents cover the big need today.

### R5 · Summarise the conversation with a cheap model
- **Idea:** near the window limit, summarise the old part instead of trimming/compacting it. Today's compaction (`compactIfNeeded`) uses no model and costs nothing; this would add quality for one extra cheap call.

### R6 · Provider per session
- A session stores the model name, not the provider; storing `providerName` would stop a model name being sent to a provider that does not know it when a session is resumed.

### R7 · Host without a tunnel
- **Partly done:** `vara ui --share` opens a temporary tunnel for the owner (cloudflared or ssh, no VARA relay). What is still open is a way to reach a host with **no** third-party tunnel at all.
- **Idea:** let remote guests reach a host without the owner running a tunnel. **Constraint:** there is deliberately no relay server today; any design must keep keys and execution on the owner's machine.

### R8 · Agent self-control — DONE; design note for the protected files (kept as the record)

Goal: the agent can be given named modes, and can manage its own setup (skills, MCP servers, mode) — **always through an approval the user sees, never silently**. This note is written *before* touching `permissions.ts` and `engine.ts`, as the rules require.

**`src/tools/permissions.ts` — what changes and what must not**
- `ToolContext` gains an optional `modePolicy` (from a user-defined mode: `allowTools`, `denyTools`, `allowCommands`, `denyCommands`).
- `authorize()` gets one more check **after** the existing plan/build check and guard; `checkCommandAllowed()` gets the command lists **after** the forbidden and publishing checks.
- **A policy can only narrow.** A custom mode names a base (`plan` or `build`); the base's rules still run first and unchanged, so a custom mode can never allow what plan/build refuse. A mode whose base is `build` is refused for a guest whose grant ceiling is `plan`.
- No existing rule is removed or reordered; every existing defence-line test stays and new tests are added first (`tests/modes.test.ts`).

**`src/core/engine.ts` — what changes**
- The engine receives the active policy through `EngineOptions` (a getter, read every turn) and passes it to the tool context and to the tool-list filter, so a forbidden tool is also hidden from the model. Sub-agents inherit it (they copy `options`).
- An optional approval hook (`EngineOptions.approve`) is exposed to tools as `ctx.approve()`. A tool that changes the agent's own setup must call it; **no hook (headless run, sub-agent) means denied**, never auto-approved. The engine emits `approval_request` / `approval_resolved` and keeps the session in `waiting_user` while it waits; `stop()` denies everything pending.
- The sub-agent runner is generalised (roles, a shared task list, limits) in a new file `src/core/swarm.ts`; `engine.ts` only wires it. The existing caps (4 tasks, 3 parallel, ephemeral, no nesting) stay as the hard ceiling.

Proof: tests are written first; `npm run check` green before every push.

### R9 · Browser use — design note for the protected file (`engine.ts`)

`engine.ts` gets one small, additive change: a tool may return `images` (image markers); after ALL tool results of a turn are recorded, the engine appends one hidden `[ENGINE]` user message carrying those markers, which the existing `resolveImages` path turns into image blocks for vision models (and an honest "cannot view images" note for the rest). Why in the engine: providers require every tool result of a turn to be consecutive before any other user message. Why it is safe: no permission logic is touched; images are only ever read from the session's own `attachments/` folder; at most 4 per turn; the message is hidden from the interfaces like other `[ENGINE]` messages. Defence-line tests are unchanged and pass. Everything else (policy, CDP, tool) lives in new files under `src/browser/` and `src/tools/browser-tool.ts`, and the tool is offered only when `agent.browser` is on.

### R10 · Still open after the browser/desktop/connector work
- **Desktop control on macOS and Linux is written but unverified** — needs a hand test on real machines (checklist in `docs/DEVELOPMENT.md`).
- **Connectors that need OAuth** (Linear, Google Drive/Gmail/Calendar, Slack remote…) — needs an OAuth/device-flow in the MCP client; until then they are not listed.
- **Prompt-injection residual risk in the browser** — origin/approval/secret controls limit the damage but no model-side defence is perfect; an engine-level "taint" (writes after reading untrusted pages need approval) is the next step.
- **Agent evals** — an offline harness of scripted scenarios (refuses false completion, recovers after a failing tool, does not write in plan mode) beyond the unit tests that exist.
- **R4 (parallel read tools), R5 (cheap-model summaries), R6 (provider per session)** remain open above.

### R12 · System-aware agent, visible sub-agents, run anywhere — design note for the protected file (`engine.ts`)

Written *before* touching `engine.ts`. `permissions.ts` and `vault.ts` are **not** touched.

**`src/core/engine.ts` — what changes (all additive, no permission logic)**
- The `subagent` event gains optional fields: `swarm` (a counter, so a UI can group one `delegate` call), `kind`, `steps` (tool calls so far), `calls`, `costUsd` (`null` = unknown), `report` (the sub-agent's final text, scrubbed, ≤ 2 000 chars) and `cancelled`. A new event `swarm_report` carries the merged report and the totals. Why in the engine: only `spawnSubagents` knows the child engines; nothing else can produce these facts.
- `Engine.cancelSubagents(id?)` stops one child (or all) and makes the swarm stop starting new ones. It only calls `child.stop()`, which already exists; a cancelled task reports `failed` with the reason "cancelled", so its dependants are skipped by the existing rule. `SessionRunner` exposes it.
- Two more small things in the same function/area: a sub-agent that ends `paused`, `stopped` or `interrupted` (a provider error, its own budget) is now reported **failed** (before, any leftover text made it "done"); and `runTurn` passes one more option to `buildSystemPrompt` (`selfManage: true` when the owner's admin port has the system tools) — a prompt flag, no permission logic.
- `core/swarm.ts` passes the outcome to `onStatus` and accepts an optional `shouldStop` hook; limits and ceilings (4 tasks, 3 parallel, no nesting, ephemeral children) are unchanged.

**Why it is safe:** the new fields are display data; no tool, mode or approval decision reads them. The approval flow, `authorize()`, the custom-mode policy and the "no approver means denied" rule are untouched. Existing swarm and engine tests stay and new ones are added first.

**The system-aware agent** lives in new files (`src/core/systeminfo.ts`, `src/tools/system-tools.ts`) and extends `AdminPort`; every change still goes through `ctx.approve()`, and the read side never returns secrets (names and presence only, `scrubAll` on everything, sessions of other folders only through the owner's admin port).

## 3. Under study (do not implement before agreeing)

| Item | Open question |
| --- | --- |
| Switching provider inside one session between turns | One shared context window or one per model? Per-model pricing in the registry? |
| MCP: OAuth for remote servers | The flow needs a browser — how do we keep it safe from the terminal? |
| Skills from external repositories | Trust in the source: are they run without review? |

## 4. Not on the table now

A new feature before what exists is stable. If you see a real need, raise an **issue** and explain: the problem, the proposed solution, and its effect on the protected files (`engine.ts` `permissions.ts` `vault.ts`).

## 5. Docs to update with every change

| You changed | Update |
| --- | --- |
| User-visible behaviour | `README.md` / `README.ar.md` (commands, shortcuts) |
| File structure or an execution path | `docs/ARCHITECTURE.md` and `docs/ar/ARCHITECTURE.md` |
| A development mechanism, or a new trap | `docs/DEVELOPMENT.md` and `docs/ar/DEVELOPMENT.md` |
| You took an idea or code from an outside project | `THIRD_PARTY_NOTICES.md` and `.ar.md` (source / version / licence / changes) |
| Anything that reached `main` | `CHANGELOG.md` and `CHANGELOG.ar.md` (same batch) |

---

## 6. R11 · Cost engine v2 — design note for the protected file (`engine.ts`)

Goal: the same work in far fewer limit-units, with no change in what the user types and no lowering of quality. Written **before** touching `engine.ts` (the rule). `permissions.ts` and `vault.ts` are **not** touched; no defence-line test is edited.

**What changes in `src/core/engine.ts` (all additive, each behind an option that is absent by default, so behaviour without the new options is byte-identical to v0.4.0):**
- `EngineOptions.router` (a getter): the per-turn model choice moves out of the engine into the pure `src/core/router.ts`. The engine only calls `decideRoute()` and emits a `route` event with the visible reason. A user-set quality floor is enforced inside `decideRoute()`, never in prompts.
- `EngineOptions.meter`: every model call is also appended to the usage meter (`src/core/usage-meter.ts`) together with an estimate of what the same call would have cost with no technique ("naive baseline"). The engine reads `meter.status()` for soft warnings and the opt-in eco mode.
- Tool-output handling: one call to `compressToolOutput()` (new file) replaces the blind 12 000-character cut; the full output is stored on disk and the model can ask for more with the new read-only `tool_output` tool. Identical repeated outputs are replaced by a pointer.
- Summaries of old turns (ROADMAP R5) through `src/core/summarize.ts`: old messages are *marked* (`summarized`), never deleted from the transcript, so the interfaces keep the full history; the summary message is created once, in one batch, so the cached prefix stays stable.
- Runaway loops: a hard stop after 5 identical calls in a row (the 3rd already warns).
- Re-verification is skipped only when no mutating tool succeeded since the last verification (shell counts as mutating).
- Read-only tools of one turn run in parallel (R4); results are appended in call order.

**Why it is safe:** `authorize()` still runs before every execution, in the same place and order; the prefetch for parallel reads happens only after `authorize()` allowed the call. Verification evidence is still written by the engine only. Escalation to a stronger model can only *raise* the tier; the floor can only be raised by the user.

**Proof:** tests are written with the code (`tests/router.test.ts`, `tests/cost-v2-engine.test.ts`, `tests/usage-meter.test.ts`, …) and the measured numbers come from `scripts/cost-bench.ts` (see `docs/COST.md`).
