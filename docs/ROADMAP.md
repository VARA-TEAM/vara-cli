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
- ~~Self-contained releases for Windows x64, macOS arm64 and Linux x64 with one-command installers~~

## 2. Ready to do (by priority)

### R2 · Automatic verify commands by project type
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
- **Idea:** let remote guests reach a host without the owner running a tunnel. **Constraint:** there is deliberately no relay server today; any design must keep keys and execution on the owner's machine.

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
