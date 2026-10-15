# Plan — closing the gap with the best agents

**English** · [العربية](ar/PLAN.md)

Status: **proposal, no code yet.** Written against VARA v0.3.0. Competitor facts come from public pages (list in §9); many are third-party write-ups, and anything I could not confirm on a vendor's own page is marked **(unverified)**. VARA facts were read from the code and `docs/ARCHITECTURE.md`.

Rules that apply to every item (from `CONTRIBUTING.md`): `npm run check` green before push · a test that fails before and passes after · unknown ≠ 0 · no secrets in the repo · permissions enforced inside the tools, never in the prompt · every new output path goes through `scrubAll`.

---

## 1. What the others do well, and where they are weak

| Product | Standout | Real weakness (with source) |
| --- | --- | --- |
| **Claude Code** | Skills loaded on demand (and invocable by slash command), subagents with own context/model/tools, hooks that run deterministically on events, plugins bundling all of these, checkpoints/rewind, MCP, a Chrome integration, artifacts published from a session ([overview][cc-ext], [Chrome][chrome], [artifacts][artifacts]) | Subagents cannot spawn subagents ([overview][cc-ext]); tied to Anthropic models; a reviewer says recent harness issues make reliability/reasoning defaults part of the buying decision ([comparison][cmp-1]) — an opinion, not a measured fact |
| **OpenCode** | Client/server design (TUI is one client, remote/mobile drive possible), LSP loaded automatically, session share links, multiple agents in parallel, custom agents, MCP, any provider ([webkul][oc-1], [README mirror][oc-2]) | Share links are public URLs — anyone with the link can read the session; remote-client auth/security model is not explained in what I found **(unverified)**; desktop app described as beta |
| **Hermes Agent** (Nous Research) | A learning loop: creates skills from experience, patches them in place, FTS5 recall across sessions, user model; agentskills.io-compatible skills; model-agnostic; many messaging platforms ([docs][hermes], [analysis][hermes-2]) | Mostly third-party descriptions; self-written skills are code-adjacent instructions the agent trusts later — a poisoning risk the sources do not discuss (my inference) |
| **Claude Cowork** | Desktop agent for non-code work; computer use (screenshots, clicks, typing) as a fallback after connectors; Claude Code inside the same app ([support][cowork-use]) | Research preview; machine must stay awake with the app open; slower than connectors; weak on long multi-step flows; Anthropic advises against use with health/financial records ([support][cowork-use], [limits][cowork-lim]) |
| **Cursor** | Up to 8 parallel agents, each in its own git worktree or remote worker; built-in browser the agent can drive and inspect; own Composer model ([changelog][cursor], [review][cursor-2]) | IDE-first, not scriptable from a terminal; coordination of parallel agents is hard (conflicts, drift); users report rules being ignored ([review][cursor-2]) |
| **Codex CLI** | OS sandbox + approval policies (`never`/`on-request`/`on-failure`/`untrusted`); mid-session permission requests; subagents inherit sandbox; can run as an MCP server; cloud tasks in parallel ([subagents][codex-sub], [approvals][codex-appr], [cloud][codex-cloud]) | OpenAI-model lock-in ([comparison][cmp-1]); third-party MCP servers run **outside** the sandbox ([README][codex-mcp]) |
| **Gemini CLI** | GEMINI.md context, shadow-git checkpoints with `/restore`, container sandbox, extensions, multimodal input, 1M context ([guide][gemini]) | Free tier ended 2026-06-18 and the project is being replaced by a closed-source Antigravity CLI ([report][gemini-end]) — secondary sources, **(unverified on Google's pages)** |
| **Claude on the web** (claude.ai: artifacts, connectors, Claude in Chrome) | Artifacts can call MCP connectors with per-artifact approval; Claude in Chrome with classifiers on input and on every action, blocked high-risk site categories ([artifacts][artifacts], [Chrome safety][chrome]) | Prompt injection remains the open risk: Anthropic reports 23.6% attack success without mitigations and ~1% with them (its own tests) ([Anthropic][chrome]). Artifacts: single page, no backend, no outbound fetch ([third-party][artifacts-2]) |

**What the weaknesses tell us.** (1) Browser/computer agents are the highest-risk surface — the vendor with the most resources still reports non-zero attack success. (2) Parallel agents fail on file conflicts — isolation must be structural (worktrees), not a prompt rule. (3) Public share links and self-modifying skills are the two places where convenience quietly becomes a data leak or a persistent backdoor. VARA's advantage is already its engine-enforced permissions and proof path; the plan keeps that rule for every new capability.

## 2. Gap analysis against VARA v0.3.0

| Capability | VARA today (verified in code/docs) | Gap |
| --- | --- | --- |
| Modes | `Mode = 'plan' \| 'build'` hard-coded in `core/types.ts`; checked by `checkToolAllowed` | No user-defined modes |
| Skills | 5 built-in + user/project `SKILL.md`; `skill` tool loads body; `/skill <name>` exists in TUI (`App.tsx`) and web | `/skill` only *asks* the model to load the skill; no arguments, no per-skill tool limits, no "user-only" flag; the agent cannot create/edit skills itself |
| MCP | stdio + HTTP, presets, owner-managed in `/mcp` and web settings | Agent cannot add/toggle servers; no OAuth for remote servers (listed as "under study" in ROADMAP) |
| Connectors | Only raw MCP | No catalog, no per-connector enable switch, no OAuth |
| Sub-agents | `delegate`: ≤4 tasks, 3 parallel, ephemeral, no nesting; `work` agents share the **same folder** | No filesystem isolation, no live view per agent, no nesting, no result merge |
| Attachments | `@file` text only (≤120 KB, 6 files, owner) | No images/PDF; messages are `content: string` — no vision path |
| Updates | Installer re-run ("run the same command again") | No `vara update`, no update notice |
| Preview | none | No running-project preview |
| Sharing | invites over LAN or a user-run tunnel (`--public-host`), no relay | No built-in temporary public link |
| Browser use | Playwright MCP preset only | No first-class browser agent, no injection defence |
| Computer use | none | none |

## 3. Sequencing

```
P0  Foundations (everything else depends on them)
    F1 approval gate + capability scopes     F2 message parts (text+image)
P1  Small, high-value, low-risk
    1 custom modes · 2 /skill hardening · 3 attachments→vision · 4 vara update
P2  The agent manages itself
    5 self-management tools · 6 connectors
P3  Parallelism and visibility
    7 swarm (worktree-isolated) · 8 live preview · 9 temporary share link
P4  Highest risk — only after P0–P3 are stable
    10 browser-use agent · 11 computer-use
```

Why this order: 10 and 11 need vision (F2/3) and the approval gate (F1); 9 needs 8; 5 and 6 need F1 because the agent changing its own tools must never be silent. Each item ships on its own branch with its own changelog entry (ROADMAP rule 0).

### F1 · Approval gate and capability scopes (foundation)
- **Design:** a new `ToolResult`/`authorize()` outcome `needs_approval` carrying `{capability, summary}`. Capabilities are named (`self.skill.write`, `self.mcp.add`, `browser.navigate`, `desktop.control`, `net.share`). The engine pauses the session in `waiting_user` (same mechanism as `ask_user`) and resumes on yes/no; "always for this session" is stored in the session, never globally. Headless runs (`vara run`) deny by default unless `--allow <capability>`.
- **Risks:** approval fatigue → coarse capabilities, clear one-line summaries; a guest must never be able to approve for the owner → approvals are owner-only in `server/access.ts`; approval text shown to the user must come from the engine (the tool args), not from model prose.
- **Files:** `src/tools/permissions.ts`, `src/tools/types.ts`, `src/core/engine.ts` (protected: needs team discussion), `src/core/types.ts`, `src/server/access.ts`, `src/server/http.ts`, `src/tui/App.tsx`, `ui/src/` (approval card).
- **Tests:** a capability without approval never executes; denial is reported to the model as text; a guest approval attempt returns 403; headless default-deny; approval survives pause/resume; "always for session" does not leak into a new session.

### F2 · Message parts (text + image)
- **Design:** extend `TranscriptMessage` with optional `parts?: Array<{type:'image', mediaType, ref}>`; the bytes live in `~/.vara/sessions/<id>/blobs/<sha256>`, not inside `state.json` or `events.jsonl` (keeps snapshots small). `openai.ts` and `anthropic.ts` serialise parts to each API's image format. Models without vision (known from `llm/capabilities.ts`/registry; **unknown ⇒ treated as no vision**, image refused with a clear message) never receive an image.
- **Risks:** huge files (size/dimension caps, re-encode), token cost of images (count as `null`/estimated unless the provider reports usage — unknown ≠ 0), EXIF/metadata leakage and prompt injection hidden in images (images are data, state this in the system prompt; the approval gate protects any action).
- **Files:** `src/core/types.ts`, `src/core/store.ts`, `src/llm/openai.ts`, `src/llm/anthropic.ts`, `src/llm/capabilities.ts`, `src/llm/usage.ts`, `src/core/context.ts` (image token estimate).
- **Tests:** serialisation per provider (golden request bodies); non-vision model refuses; blob stored once per hash; resume replays parts; a text-only session's `state.json` is byte-identical to before (backward compatibility).

---

## 4. Item plans

### 1 · Custom user-defined modes
- **Design:** modes become data, not a union. `~/.vara/modes/<name>.json` (and `<project>/.vara/modes/`): `{name, description, tools: allow-list or "readonly"|"all", shellPolicy: "none"|"policy"|..., prompt: extra system text, model?, thinking?}`. `plan` and `build` stay built in and cannot be overridden. A mode can only **narrow** what `build` allows, never widen — it can't unlock `allowPublish` or a tool `build` forbids. `Tab` cycles through configured modes; `/mode <name>`; web mode picker.
- **Risks:** a mode file in a cloned repo silently granting power → project modes may only restrict, and a project mode that sets a prompt is shown to the user on first use (trust prompt via F1); name clash with built-ins.
- **Files:** `src/core/types.ts` (`Mode` → `ModeName = string` + `ModeDef`), new `src/core/modes.ts`, `src/tools/permissions.ts`, `src/core/prompt.ts`, `src/config/config.ts`, `src/tui/keymap.ts` and `App.tsx`, `ui/src/` mode picker, `src/server/access.ts` (guest power ceiling must map custom modes to plan/build).
- **Tests:** a mode with an allow-list rejects other tools inside `authorize()`; a mode cannot widen; guest ceiling `plan` cannot select a build-class mode; invalid JSON is refused with a reason; `Tab` order; old sessions with `mode:'plan'|'build'` load unchanged.

### 2 · `/skill` invocation, hardened
- **Today:** `/skill name about` sends a prompt asking the model to load the skill. **Plan:** deterministic invocation: the engine injects the skill body as a user-turn context block (no extra model round-trip to call `skill`), with `$ARGUMENTS` substitution. Optional frontmatter: `allowed-tools`, `user-invocable`, `disable-model-invocation` (these names follow Claude Code's skill format — **unverified field-by-field**; keep ours a documented subset). Autocomplete of skill names in TUI and web.
- **Risks:** a skill body is trusted instructions — project skills from a cloned repo are the injection vector (already flagged in ROADMAP "skills from external repositories"); `allowed-tools` must only narrow.
- **Files:** `src/core/skills.ts`, `src/core/engine.ts` (injection point), `src/core/prompt.ts`, `src/tools/control-tools.ts`, `src/tui/App.tsx` (~line 1127), `src/tui/commands.ts`, `ui/src/commands.ts`.
- **Tests:** `/skill x args` yields a transcript block containing the body and args without any model call; unknown skill refused; disabled skill refused; `allowed-tools` narrowing enforced; autocomplete list matches `discoverSkills`.

### 3 · File and image upload (TUI and web) to vision models
- **Design:** depends on F2. Web: drag-drop/paste/file picker → `POST /api/sessions/:id/attachments` (multipart, size cap, magic-byte check, owner or guest with `sendShared`/`ownSession`). TUI: `@path/to/img.png` already parsed by `tui/mentions.ts` — extend to images (png/jpeg/webp/gif, and PDF as text extraction **only if** a vetted extractor is added, otherwise refuse); terminals cannot paste binary, so paths only, plus `/attach <path>`. Text files keep the existing 120 KB rule. Files stay inside the working folder (existing rule); web uploads go to the session blob store, not the project.
- **Risks:** path traversal and symlinks (reuse `@file` checks); SVG (script-bearing — refuse or rasterise), zip bombs/oversized images, MIME spoofing; a guest uploading to the owner's disk (blob store only, caps per guest); cost spikes (per-message image cap, shown in `/cost`); the model asked to act on instructions found inside an image.
- **Files:** `src/server/http.ts`, `src/server/host.ts`, `src/tui/mentions.ts`, `src/tui/App.tsx`, `src/core/store.ts`, `ui/src/` (composer, thumbnails), `src/server/access.ts`.
- **Tests:** type sniffing rejects renamed executables/SVG; size caps; traversal and symlink refused; guest without power gets 403; non-vision model gets a refusal, not a silent drop; image part reaches the provider request body (mock provider); blob survives resume.

### 4 · OTA updates: `vara update` and a notice
- **Design:** `vara update` downloads the release asset for this platform from the GitHub Releases of `VARA-TEAM/vara-cli`, **verifies `SHA256SUMS.txt`**, unpacks beside the current install, and swaps atomically (on Windows the running exe cannot be replaced: stage and swap on next launch via a small helper, or rename-then-copy). `vara update --check` prints the latest version without installing. Notice: at most once per 24 h, a non-blocking background `GET` of the latest release tag, cached in `~/.vara/update.json`; shown as one line on the start screen and in `vara doctor`. Opt-out: `update.check: false` in config. Source installs (`npm link`) print "run git pull && npm run build" instead of self-updating. No telemetry is sent beyond the HTTP request itself.
- **Risks:** supply chain — checksum is only as trustworthy as the release page; a compromised release is not detected (**sign releases, e.g. minisign/sigstore, in a later step** — not in scope, state it honestly); downgrade attacks (refuse older versions unless `--force`); partial download leaving a broken install (stage then swap, keep previous version for rollback); no admin rights (install is per-user already).
- **Files:** `src/cli.tsx`, new `src/update.ts`, `src/version.ts`, `src/doctor.tsx`, `src/tui/home.tsx`, `src/config/config.ts`, `install.ps1`/`install.sh` (share the verify logic), `.github` release workflow if it exists **(not inspected)**.
- **Tests:** semver compare; checksum mismatch aborts and leaves the install untouched; refuses downgrade; throttle (second check within 24 h makes no request — mock fetch); offline ⇒ silent; source install path prints guidance; opt-out honoured.

### 5 · The agent manages its own system
- **Design:** new tools, all behind F1 approvals and none available in `plan`: `skill_write {name, scope, body}` (writes `SKILL.md` through the existing `validSkillName`/`scaffoldSkill`), `skill_toggle`, `mcp_add {command|url}` (reuse `mcp/input.ts` parsing), `mcp_toggle`, `mcp_remove`, `config_get/set` for a **whitelist** of settings (never providers, keys, `allowPublish`, permissions, or modes' widening). Every change is shown as a diff-like summary, recorded as evidence, and reversible (`/undo-self` restores the previous file from a backup copy). New skills/servers start **disabled until the user approves**. Secrets for an MCP server are never typed to the model: the agent names the secret, the user sets it in the vault.
- **Risks (the highest in P2):** persistence — a poisoned skill or MCP server outlives the session and acts later; an MCP server is arbitrary code run as the user. Mitigations: approval per change, no auto-enable, skills written by the agent are tagged `source: agent` and shown differently; installing a server from a model-supplied command line is the same as `shell` and must show the exact command; a quarantine rule — content that came from a web page or tool output is not allowed as the *body* of a new skill without the user reading it (the approval card shows the full body, not a summary).
- **Files:** new `src/tools/self-tools.ts`, `src/tools/registry.ts`, `src/core/skills.ts`, `src/mcp/hub.ts`, `src/mcp/input.ts`, `src/server/manage.ts` (reuse its apply-then-save path so a broken server is refused before saving), `src/config/config.ts`, `src/core/prompt.ts`.
- **Tests:** `plan` mode rejects every self tool; without approval nothing is written; approved skill appears in `discoverSkills` and is disabled until enabled; whitelist rejects `providers`/`allowPublish`; MCP add with an unreachable server is refused before saving (as in `manage.ts`); undo restores bytes; a guest cannot invoke self tools; scrub test — a secret value in the body is redacted.

### 6 · Connectors
- **Design:** a connector is a named, curated MCP server definition with metadata (id, label, auth type, scopes, `readOnly` tool list) — a catalog file shipped in the release (`src/mcp/connectors.ts`) plus user additions. States: `available → configured → enabled`. Toggle per connector, per session (like skills' disable list). Auth: bearer secret in the vault (exists today); **OAuth** for remote servers is the open item (ROADMAP "under study") — implement device-code or loopback-redirect flow only after the safety question is agreed. Web: a Connectors page in Settings; TUI: `/connectors`. Writes by connector tools go through F1 (`connector.<id>.write`) unless the tool is marked read-only by the server **and** the catalog.
- **Risks:** tool descriptions from a remote server are model-visible text (injection); a connector that exfiltrates what the agent read — keep the per-tool allow-list from the catalog, show data-leaving calls in the proof panel; OAuth tokens in the vault only, scrubbed; third-party servers run outside any sandbox (Codex has the same property, [README][codex-mcp]).
- **Files:** new `src/mcp/connectors.ts`, `src/mcp/hub.ts`, `src/server/manage.ts`, `src/config/config.ts`, `src/tui/mcp.tsx` (+ `connectors.tsx`), `ui/src/` settings page, `src/tools/permissions.ts`.
- **Tests:** catalog schema validation; disabled connector's tools are absent from the model's tool list; read-only tool allowed in `plan`, write tool not; token never appears in any API response (`manage.test.ts` pattern); OAuth state/PKCE tests with a fake server (when built).

### 7 · Sub-agents and swarm
- **Today:** `delegate` — fine for research; `work` agents edit the **same working tree**, relying on the prompt "never give two agents the same file".
- **Plan:** (a) `work` agents run in their own **git worktree** (`.vara/worktrees/<run>/<n>`, branch `vara/<run>-<n>`) when the folder is a git repo; otherwise at most one `work` agent at a time. (b) The parent receives a report plus a diffstat and **merges** through the engine (fast-forward or cherry-pick; conflicts surface as a `ask_user` decision, never auto-resolved). (c) A swarm planner: `delegate` accepts a dependency list; independent tasks run in parallel up to a configurable cap (default 3, hard max 8 — Cursor's published figure is 8, [changelog][cursor]); a shared cost/turn budget is split among them, and a stalled child is killed. (d) Named, user-defined sub-agent profiles (model, tools, prompt) reuse the **modes** format from item 1. (e) Live per-agent view: web side panel list with state and last tool; TUI sidebar entry. Nesting stays off by default (matches Claude Code's rule, [overview][cc-ext]); one level of "lead → workers" only.
- **Risks:** parallel writes (solved structurally by worktrees); runaway cost (shared budget, `maxModelCalls` still caps); worktree disk use and cleanup on crash (registry file, `vara doctor` reports orphans); sub-agents inheriting approvals — they inherit the parent's grants **at spawn time only** and cannot request new ones silently (Codex surfaces child approvals to the parent, [docs][codex-sub] — same model); secrets in worktrees (`.env` copied? **no**: only tracked files).
- **Files:** `src/core/engine.ts` (`spawnSubagents`; protected), `src/tools/control-tools.ts`, new `src/core/worktree.ts`, `src/tools/git-tools.ts`, `src/core/runner.ts`, `src/server/host.ts` (events), `src/tui/sidebar.tsx`, `ui/src/` agents panel.
- **Tests:** two work agents editing the same file path do not collide (real temp git repo); merge conflict becomes a question, not an overwrite; non-git folder serialises work agents; budget split sums to the parent's limit; killed child leaves no worktree (cleanup test); cost of children appears in the parent ledger (existing invariant); `plan` mode still downgrades `work` to `explore`.

### 8 · Live preview of a running project
- **Design:** a `preview_start {command, port}` tool (build mode, F1 capability `net.preview`) runs the dev server as a managed child process (not through the free `shell`), detects the port from output or the given port, and exposes it through the host at `/preview/<sessionId>/…` as a **reverse proxy** bound to loopback, with the host's token required. Web: an iframe/"Preview" tab in the side panel; TUI: prints the URL and opens the browser. Logs stream into the session; the process dies with the session or the app. Screenshots for the model come from item 10, not here.
- **Risks:** the previewed app is untrusted code on the owner's origin → serve it from a **different origin** (separate port, or subdomain `*.localhost`) with iframe `sandbox`, so it cannot read the owner's token in sessionStorage; open proxy / SSRF (proxy only to the registered `127.0.0.1:<port>` of that preview, never a client-supplied host); WebSocket HMR needs upgrade support; port collisions; the `Host`/`Origin` rules in `http.ts` must be extended without weakening them.
- **Files:** new `src/server/preview.ts`, `src/server/http.ts` (routes + CSP for the preview frame), `src/server/host.ts` (process lifecycle), new tool in `src/tools/`, `ui/src/` preview tab, `src/tui/App.tsx`.
- **Tests:** proxy refuses any target but the registered port; preview origin ≠ app origin (token not readable — assert header/CSP and origin split); process killed on session stop and on host close; unauthenticated request → 401; DNS-rebinding `Host` still blocked; guest without power cannot start or view.

### 9 · Temporary public share link
- **Design:** `vara share` / a button in Team: start an outbound tunnel to the **owner's own** choice of provider, process-bound so it closes when the host exits. VARA runs no relay (ROADMAP R7: keys and execution stay on the machine). Implementation: a pluggable `TunnelProvider` interface; first adapter spawns an installed tunnel binary (e.g. `cloudflared`, which offers quick tunnels without an account — **unverified here**, check its current terms before shipping) and parses the public URL; the adapter must not be bundled silently. Link = existing invite link with `viewer` preset by default, an **expiry** (default 1 h), a visible "link is live" banner, one-click revoke, and automatic teardown on `SIGINT`/exit/idle timeout. Can also expose a **preview** (item 8) read-only. Distinct from OpenCode's session share, which publishes a public URL of a session ([webkul][oc-1]); ours serves live from your machine and dies with it.
- **Risks:** this is internet exposure of a machine that can run commands. Mitigations: default `viewer`/`plan`, never `build` over a public link without an explicit second confirmation; token-in-path invites are brute-forceable → keep the existing invite-guessing rate limit and long random tokens; the tunnel URL becomes an allowed `Host` only while live; the share never includes the owner token; tunnel binary integrity (user-installed, path shown); logs must not print the full invite URL into shared channels (`scrubAll`-style masking for tokens).
- **Files:** `src/server/commands.ts`, new `src/server/tunnel.ts`, `src/server/access.ts` (expiry, ephemeral grant flag), `src/server/http.ts` (dynamic allowed host), `src/tui/App.tsx`, `ui/src/` Team page, `doctor.tsx` (tunnel binary check).
- **Tests:** link stops resolving after process exit and after expiry (fake tunnel provider); revoke is immediate; a `build` grant over a public host requires the explicit flag; dynamic host removed on teardown; URL parser against sample tunnel outputs; expired/unknown token → 404 with no information leak; teardown on signal (spawned child test).

### 10 · Browser-use agent
- **Design:** a first-class `browser_*` tool family (`navigate`, `snapshot` (accessibility tree + text), `click`, `type`, `screenshot`, `read_console`, `tabs`) over Playwright, run by VARA in an **isolated, throwaway profile** — not the user's logged-in browser (Claude in Chrome deliberately uses the real one, which is where its risk comes from, [Anthropic][chrome]). Reads (`navigate` to allowed origin, `snapshot`) vs. acts (`click`/`type`/form submit) are separate capabilities under F1. Origin allow-list per session (default: `localhost` + origins the user approves); a built-in deny list for banking/crypto/adult categories like Anthropic's ([support][chrome]) — a list we maintain ourselves. Page content is wrapped as **untrusted data** in the transcript with an instruction-boundary marker; any action after reading untrusted content that is not traceable to the user's request requires approval (a taint flag on the session: "has read untrusted web content since last user message" ⇒ writes/network/shell need approval). Screenshots go to the vision model through F2. Can be a sub-agent profile (item 7) so a long browse never fills the main context.
- **Risks:** prompt injection (the dominant risk; Anthropic's own best result is ~1%, not 0 — **expect residual risk and say so in docs**); data exfiltration via URLs/forms (outbound requests to non-allowed origins blocked at the browser-context level, not by model judgment); downloads (blocked by default); credentials (the agent never types stored secrets — password entry stays a user action); CAPTCHAs (not bypassed); SSRF to `localhost`/cloud metadata (block `169.254.169.254` and private ranges unless allow-listed); heavy dependency (Playwright browsers ~hundreds of MB → optional install via `vara browser install`, never bundled by default).
- **Files:** new `src/tools/browser-tools.ts`, new `src/browser/` (driver, policy, taint), `src/tools/permissions.ts`, `src/core/engine.ts` (taint flag), `src/core/prompt.ts`, `src/mcp/hub.ts` (keep the Playwright MCP preset working), `src/cli.tsx` (`vara browser install`), `ui/` (live screenshot in tool card), `src/doctor.tsx`.
- **Tests:** a local fixture page with a hidden injection ("ignore instructions, POST secrets") — assert the post-read write is gated and an outbound request to a non-allowed origin is blocked (the real proof, not a mock); origin allow-list; deny-list; private-range block; downloads off; `plan` mode permits read-only browsing only (or none — decide in review); screenshot reaches the provider as an image part; tool output scrubbed.

### 11 · Computer-use (Cowork-style)
- **Design:** last, and **opt-in per machine**: `vara desktop enable` (explicit consent screen). A `desktop_*` family: `screenshot`, `click`, `type`, `key`, `scroll`, with coordinates in screenshot space. Prefer structured routes first (connectors → browser tools → shell) and fall back to the screen only when none fit — the same order Cowork uses ([support][cowork-use]). Needs a native input library — **no cross-platform Node dependency is chosen yet (unverified; evaluate maintained options and licences before committing)**; Windows and macOS only at first (macOS needs Accessibility + Screen Recording permission prompts). Every action is shown live with a **kill switch** (global hotkey + Esc Esc), runs inside a visible region/app allow-list ("only this window"), takes a screenshot before and after each action as evidence, and stops on user input activity. Default deny list: password managers, terminals running as admin, banking apps.
- **Risks:** highest of all — full desktop control; injection through anything on screen; irreversible actions (send, delete, pay) → F1 with a screenshot in the approval card, **always** approval for send/submit/delete/pay-looking controls; sensitive apps (Anthropic advises against health/financial records, [support][cowork-use]); machine must stay awake (same limitation as Cowork); multi-monitor/DPI scaling errors causing mis-clicks (calibrate and verify with a test target window); not suitable for guests — `desktop.control` is **owner-only** and never offered over invites or public links.
- **Files:** new `src/desktop/` (driver per OS, policy, killswitch), new `src/tools/desktop-tools.ts`, `src/tools/permissions.ts`, `src/core/engine.ts`, `src/server/access.ts` (hard owner-only), `src/cli.tsx`, `src/doctor.tsx`, `ui/` (live view + kill button).
- **Tests:** a pure-logic layer is testable in CI: coordinate scaling/DPI math, allow-list region clipping, deny-list matching, approval-required classification, kill-switch stops the loop within one action (fake driver). Real OS control is **not** tested in CI — covered by a manual checklist in `docs/DEVELOPMENT.md` run on Windows and macOS before release. Guest/invite attempt → 403.

## 5. Cross-cutting security summary

| Risk | Where it bites | Control (enforced in code) |
| --- | --- | --- |
| Prompt injection from web/images/files | 3, 10, 11, 6 | taint flag + approval for post-read actions; origin allow-list; egress block at driver level; untrusted-data marking |
| Persistence / self-modification | 5, 2 | approval per change, agent-written items disabled until reviewed, full-body review, undo |
| Internet exposure | 9, 8 | viewer default, expiry, revoke, teardown on exit, separate preview origin |
| Parallel write conflicts | 7 | worktree isolation, merge via question |
| Supply chain | 4, 6, 5 | checksum now, signing later; connector catalog reviewed; MCP = arbitrary code, shown plainly |
| Guest escalation | all | every new capability owner-only unless explicitly granted in `access.ts`; tests per item |
| Cost blow-up | 7, 10, 11, 3 | shared budgets, image caps, unknown cost stays `null` with call caps |

## 6. Where VARA can beat the field (and is not claimed yet)

Nothing below is built; these are targets, not claims.
- **Proof for UI work:** the engine already proves code changes with a verify command. Browser/preview + screenshots could add *recorded visual evidence* to `complete` — no competitor I found documents this **(unverified absence)**.
- **Cost honesty with browsing/vision:** images and screenshots are the next place tools hide cost; keeping `null` where unknown is a differentiator.
- **Engine-enforced scopes everywhere** (F1) instead of prompt-level rules.
- **Bring-your-own-key with swarm:** cheap-model workers (already how sub-agents work) at 3–8 in parallel.

## 7. Open questions for the maintainers
1. F1 touches `engine.ts` and `permissions.ts` (protected files) — agree the `needs_approval` shape first.
2. Tunnel adapter: which provider is acceptable as first adapter, and who maintains the allowed-terms check?
3. Release signing (4): minisign vs sigstore.
4. Desktop control library (11): choose after a licence and maintenance review.
5. Should `plan` mode allow read-only browsing (10)?

## 8. Not verified in this document
- Exact release workflow/files (`.github/`) — not inspected.
- Claude Code skill frontmatter fields beyond what the overview page states; Hermes internals; OpenCode share-link privacy and remote auth; Gemini CLI sunset details; `cloudflared` quick-tunnel terms; all benchmark/ranking claims in third-party comparisons (deliberately not used).
- Everything about unreleased/new competitor versions after my sources' dates.

## 9. Sources

[cc-ext]: https://code.claude.com/docs/en/features-overview
[cmp-1]: https://codex.danielvaughan.com/2026/04/19/three-terminals-meet-the-editor-cli-agents-vs-cursor/
[chrome]: https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely
[artifacts]: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
[artifacts-2]: https://www.eesel.ai/blog/what-are-claude-code-artifacts
[oc-1]: https://webkul.com/blog/opencode-terminal-coding-agent/
[oc-2]: https://github.com/9j/opencode
[hermes]: https://hermes-agent.nousresearch.com/docs
[hermes-2]: https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving
[cowork-use]: https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork
[cowork-lim]: https://www.graduateschool.edu/learn/ai/claude-cowork-limitations
[cursor]: https://cursor.com/changelog/2-0
[cursor-2]: https://www.i-programmer.info/news/90-tools/18466-cursor-2-enables-multi-agent-working.html
[codex-sub]: https://developers.openai.com/codex/subagents.md
[codex-appr]: https://codex.danielvaughan.com/2026/04/08/codex-cli-approval-framework
[codex-cloud]: https://developers.openai.com/codex/cloud
[codex-mcp]: https://github.com/leonardsellem/codex-subagents-mcp
[gemini]: https://computingforgeeks.com/gemini-cli-cheat-sheet/
[gemini-end]: https://thenewstack.io/gemini-cli-antigravity-replacement/

Markdown reference links above are the sources cited in §1 and the item plans. Most are third-party; prefer vendor pages when re-verifying.
