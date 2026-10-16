# VARA

**English** · [العربية](README.ar.md)

A coding agent for your terminal and your browser that runs on **your own provider key**. It does the work of the paid tools at a much smaller bill, because everything sent to the model passes through a cost-saving engine. You give it a message; it works out whether that is a chat, a question, a task or an ongoing goal, does the work, and proves the result with recorded evidence — not with the model's say-so.

```
vara            # terminal interface: start screen, type anything or reopen a session
vara ui         # the same agent in your browser
vara setup      # add a provider, paste the key, fetch and test models
```

---

## What it looks like

<p align="center"><img src="docs/img/demo.gif" alt="VARA fixing a bug: the message is typed, the agent reads, edits and tests, and the evidence panel fills in" width="900"></p>

<p align="center"><img src="docs/img/session.png?v=2" alt="VARA in the browser: the agent reads, edits, runs the tests and shows the evidence" width="900"></p>

<p align="center"><img src="docs/img/tui.gif?v=1" alt="The terminal interface: the start screen, a message typed, the agent working and the proof panel at the side" width="760"></p>

<p align="center"><img src="docs/img/tui-start.png?v=1" alt="The terminal start screen" width="760"></p>

<p align="center"><img src="docs/img/mobile.png?v=2" alt="The same interface on a phone" width="260"> <img src="docs/img/session-dark.png?v=2" alt="Dark theme" width="620"></p>

These are the real interface, produced by [scripts/capture-screens.ts](scripts/capture-screens.ts). The model in them is a **script** (no provider, no key), so they show the interface and the evidence panel, not how smart any model is.

---

## Why VARA

| | |
| --- | --- |
| **Understands what you want** | Every message is classified: `chat` (answered without tools) · `question` (reads the project, answers) · `task` (does the work and proves it) · `goal` (keeps going). When unsure it picks the least powerful option, so a guess never changes your files. The model can still `escalate`. |
| **A smaller bill** | Provider prompt caching, compaction of old tool output, no re-reading of unchanged files, a cheaper model for chat/questions/sub-agents, thinking only for real work. `/cost` shows what was saved. **v2:** a model router with a quality floor you set, long-output compression, repo map, summaries of old turns, a limit meter with pace ("lasts N hours") and a savings report — measured offline in [docs/COST.md](docs/COST.md); `vara eval` checks ON vs OFF on 19 coding tasks for quality *and* cost ([docs/EVAL.md](docs/EVAL.md) — only the offline harness has run; no real-provider result is published yet). |
| **Any provider** | OpenAI · Anthropic · OpenRouter · DeepSeek · Groq · Gemini · Mistral · xAI · Together · Ollama · LM Studio · any custom OpenAI-compatible or Anthropic endpoint. Every model has a tested status (works / failed / untested) and an editable context window. |
| **Sub-agent swarm** | The `delegate` tool runs up to 4 sub-agents (3 at a time) with named roles (researcher, reviewer, implementer, tester), a shared task list and dependencies, a call/cost budget, live status in the browser — and returns one merged report. |
| **Your own modes** | Beyond plan/build: named modes with tool and command allow/deny lists. A mode can only narrow plan or build, never widen it. |
| **The agent manages itself — with your yes** | It can write a skill, add/toggle an MCP server or switch mode, but each change is an approval card you must allow; skills and servers can be switched off per session. |
| **MCP** | Connect any Model Context Protocol server (local command or remote URL). Its tools reach the agent directly; read-only tools also work in PLAN mode. |
| **Skills** | `SKILL.md` playbooks the agent loads when they fit. 5 are built in (`code-review`, `debug`, `write-tests`, `explain-code`, `git-commit`); add your own for every project or for one. |
| **Controllable thinking** | VARA detects which models support extended thinking / reasoning effort and offers only the levels they support. |
| **Proof, not claims** | Finishing goes through an independent check run by the **engine** (your verify command + git state). If it fails, the work is not complete. |
| **Browser and desktop** | The agent can drive an isolated browser (`browser` tool) and, if you allow it, see and operate your screen (`desktop` tool). Both are off by default, ask before risky steps, never type passwords, and the desktop tool has a kill switch. |
| **Connectors** | One-click GitHub, Notion, Sentry, Supabase and more as ready-made MCP servers, with tokens kept in the encrypted vault. |
| **Web search, from your machine** | `web_search` and `web_fetch` look things up on the internet with no paid API: DuckDuckGo from your own connection first, your real browser if you allow it, optional Brave/Tavily/Serper keys if you have them. Results are treated as untrusted text. See [docs/WEB-SEARCH.md](docs/WEB-SEARCH.md). |
| **Remembers, repeats, learns** | Notes that persist between sessions (`/memory`), skills the agent *proposes* and you approve, and scheduled runs (`vara schedule`). All off by default. |
| **Long sessions that stay cheap** | `/compact [what to keep]` folds old turns into a summary on demand; auto-compact does it by itself near the window limit (`/autocompact`). |
| **Point at things** | `/skill-name` runs a skill; `@skill`, `@mcp-server`, `@agents` (parallel sub-agents), `@web`, `@browser` tell the agent what to use. Tab completes them in the terminal; the browser has the same menus. |
| **Sign in, don't paste tokens** | OAuth sign-in for remote connectors (GitHub, Notion, Sentry, Supabase); tokens go straight into the vault. Tried only against a local test server so far — [docs/OAUTH.md](docs/OAUTH.md) says exactly what you do yourself. |
| **Reachable from your phone** | `vara ui --public` on a server prints a link that works from anywhere; `vara ui` asks how you want to reach it. A native phone app is not built yet; the browser interface works on a phone. |
| **From your phone, via Telegram** | Off by default: one paired private chat, replies when a turn ends, Approve / Reject buttons for anything risky. See [docs/GATEWAY.md](docs/GATEWAY.md); not yet run against the real Telegram service. |
| **Safety** | Permissions are enforced inside the tools, not in the prompt · encrypted secret vault · every output is scrubbed of secrets · unknown cost is `null`, never `0`. |
| **Share a session** | Invite people by link or QR into your host with exactly the powers you choose; see what they use. Your keys never leave your machine. |

---

## Install (one minute, no Node or npm needed)

Each download carries its own Node.js runtime, so nothing has to be installed first.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/VARA-TEAM/vara-cli/main/install.ps1 | iex
```

**macOS (Apple Silicon) and Linux (x64):**

```bash
curl -fsSL https://raw.githubusercontent.com/VARA-TEAM/vara-cli/main/install.sh | sh
```

Then open a new terminal window:

```bash
vara setup     # provider + key + model
vara           # start
vara doctor    # check that everything works
```

The installer verifies the download's SHA-256 before running anything and needs no administrator rights. To update, run `vara update` (it verifies the download, keeps the old version for `vara update --rollback`, and tells you when a new release exists — switch the notice off in Settings).

Manual downloads are on the [Releases](https://github.com/VARA-TEAM/vara-cli/releases) page: `vara-win-x64.zip`, `vara-macos-arm64.tar.gz`, `vara-linux-x64.tar.gz`, with `SHA256SUMS.txt`. macOS on Intel and ARM builds for Windows/Linux are not published yet — use the source install below.

**Uninstall:** delete `%LOCALAPPDATA%\vara` (Windows; also remove it from your user PATH) or `~/.local/share/vara` and `~/.local/bin/vara` (macOS/Linux). Your data in `~/.vara` is separate and stays until you delete it.

Installer options (macOS/Linux): `VARA_INSTALL_DIR` (default `~/.local/share/vara`) and `VARA_BIN_DIR` (default `~/.local/bin`).

## From source (for developers)

```bash
git clone https://github.com/VARA-TEAM/vara-cli.git
cd vara-cli
npm install
npm run build
npm link            # provides the `vara` command
vara setup
vara
```

After any `git pull`, run `npm run build` again — `vara` runs `dist/`. While developing, `npm run dev` runs straight from source.

Requirements: Node ≥ 20. Optional: `rg` (ripgrep) for faster search — without it a built-in engine is used; `npx` / `uvx` for MCP servers; `git` for diffs and commits.

---

## In the terminal

Type your message. For commands press `Ctrl+K` or type `/`.

| Command | What it does |
| --- | --- |
| `/providers` · `/models` · `/model [id]` · `/provider <name> [model]` | Providers and models. In the provider screens: `t` test a model · `a` test all · `r` fetch the model list · `c` edit context · `h` thinking level · `k` set the key · `n` add a model · `x` remove a model · `d` remove a provider |
| `/think [off\|low\|medium\|high]` | Thinking level for the current model, if it supports it |
| `/mcp` | MCP servers: add from a built-in list (filesystem, fetch, memory, playwright, github, context7) or any command / URL |
| `/skills` · `/skills new <name>` · `/skills proposals\|show\|approve\|reject` · `/skill <name> [about]` · `/<skill-name> [about]` | Skills (and the ones the agent proposed) |
| `/memory [add\|edit\|remove\|on\|off]` | Notes that persist between sessions ([docs/AUTOMATION.md](docs/AUTOMATION.md)) |
| `/enable <name>` · `/disable <name>` | Turn a skill or MCP server on/off for this session only |
| `/approve` · `/deny` | Answer a change the agent asked to make to itself |
| `/settings` (`Ctrl+O`) | Theme, side panel and its sections, intent routing, default mode, verify command, cheaper model, publishing, task/goal budgets, context, skills |
| `/theme <name>` | 9 themes, applied instantly |
| `/cost` | Spend and savings: cache, compaction, repeated reads, cheaper model, sub-agents |
| `/limit` | Your limit: `5000000 tokens per 5h`, `$20 per month`, `percent 37`, `eco on`; shows how long it lasts |
| `/savings` | What VARA saved (this session, 7 days, all time) with the method stated |
| `/route` | Which model handles which turn, and your quality floor |
| `/context` · `/status` · `/evidence` · `/last` | Context window · budget and progress · recorded evidence · full output of the last tool call |
| `/export [file]` | Save the conversation as markdown |
| `/new` (`Ctrl+N`) · `/sessions [--all]` · `/resume <id>` | Sessions — tabs; the start screen asks for nothing |
| `/mode plan\|build\|<your mode>` · `/kind auto\|task\|goal` · `/pause` · `/stop` · `/quit` · `/help` | |

In any message, `@src/app.ts` attaches that file (inside the working folder only, up to 120 KB, at most 6 files per message).

**Keys:** `Enter` send · `Ctrl+J` newline · `Tab` PLAN/BUILD · `Ctrl+N` new session · `Ctrl+K` commands · `Ctrl+O` settings · `Ctrl+B` side panel · `Ctrl+W` close tab · `Alt+←/→` switch tabs · mouse wheel or `↑↓` scroll (`PgUp/PgDn` faster) · `Ctrl+G` jump to latest · `Esc Esc` interrupt the agent · `Ctrl+C` save and quit.

## Command line

| Command | What it does |
| --- | --- |
| `vara` · `vara -c` | Open the tool · reopen the latest session in this folder |
| `vara resume <id>` · `vara sessions [--all]` | Resume a saved session · list sessions (this folder, or all) |
| `vara setup` · `vara providers` | Set up providers · show their status |
| `vara run "<task>" [--goal] [--plan] [--cwd dir] [--verify "npm test"] [--publish] [--provider p] [--model m]` | Headless run; prints events |
| `vara ui` · `vara serve` | Browser interface · run VARA as a headless service (VPS, Docker, CI) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| `vara ui --share` | Temporary **public** link through `cloudflared` or `ssh` — see below |
| `vara update [--check] [--rollback]` | Update this install from the latest release (SHA-256 verified) · go back |
| `vara invite` · `vara guests` | Invite someone · list and revoke guests |
| `vara secret set\|list\|delete <NAME>` | The encrypted vault |
| `vara config init\|show` | Write the default config · print it (secrets never shown) |
| `vara connectors [list\|add <id>\|remove <id>]` | Ready-made connectors (GitHub, Notion, Sentry, Supabase…); tokens go to the vault |
| `vara eval --offline` · `vara eval --provider <name> --yes` | Measure the cost engine ON vs OFF on small coding tasks: pass rate, tokens, cost, time → JSON + Markdown report ([docs/EVAL.md](docs/EVAL.md)) |
| `vara memory [list\|add\|edit\|remove]` · `vara skills [proposals\|show\|approve\|reject]` | Memory notes · skills the agent proposed (off until enabled; nothing installs until you approve) |
| `vara schedule [enable\|add\|list\|run\|logs\|tick\|daemon…]` | Recurring headless runs on an interval or cron spec — off by default, read-only unless `--build`, local owner only |
| `vara doctor [--server]` · `vara --version` | Check the install (`--server`: also a service setup) · print the version |

`VARA_HOME` overrides the data folder (default `~/.vara`).

---

## In the browser

```bash
vara ui                                         # opens the interface; only this machine can reach it
vara ui --lan                                   # let devices on your network join
vara invite --preset collaborator --label Sam   # an invite link with the powers you set
vara guests                                     # who joined, what they use · vara guests revoke <id>
```

**Files, images and the running app**

- **Attach:** drag a file onto the message box, paste a screenshot, or click the paper-clip (terminal: `/attach <file>`, `@path`, or drag onto the terminal). Images are sent as images to models that can see them (otherwise the agent is only told one was attached); text files up to 120 KB and PDFs (text only) are attached as text. 6 files per message, images up to 5 MB.
- **Live preview:** ask the agent to start your dev server (or `/preview start npm run dev`); the app appears in the bottom panel's *Preview* tab. The server must read the `PORT` variable. Owner only.
- **Public link:** `vara ui --share` (needs `cloudflared` or `ssh`; `--share-via`, `--share-minutes N`, `--share-preset`). It prints a read-only invite on a public address and closes when the time is up or you stop the host. **Anyone with an invite can reach this host from the internet, through a third-party tunnel provider. A guest with Build power runs commands on your machine — keep guests on Plan unless you trust them completely.**

`vara ui` opens a full app with everything the terminal has:

- **Conversation:** live streaming, markdown with tables and code, tool cards, sub-agents drawn as a team, `@file` attachments, `/` commands, a command palette (`Ctrl K`), drafts kept per session.
- **A workbench:** sidebar, session tabs (drag to reorder; two sessions side by side), side panel and a bottom dock, all with drag handles that also work from the keyboard (double-click resets one); four layout presets; remembered per browser. On a phone the panels become drawers.
- **Side panel (per session):** *Proof* (requirements, recorded evidence, limits, context) · *Cost* (spend, tokens, what VARA saved, context-window gauge) · *Agents* (every sub-agent run live: roles, status, a trace of who ran when and who waited for whom, calls and cost, reports, cancel one or all) · *Files* changed · *Tools*. **Bottom dock:** *Output* (what ran and what came back), *Preview*, *Events*. Export as markdown, pause, stop for good, switch task ↔ goal.
- **Settings (owner):** providers, keys, model lists, testing, context, thinking level · agent behaviour, budgets, context · skills (view, create, edit, switch off) · MCP servers · look and feel (9 themes, English/Arabic with right-to-left, mobile layout).
- **Team (owner):** invite by link or QR, edit or revoke a guest's powers, see who is working and what they use.

Invite presets: `viewer` (watch) · `participant` (watch + write in your shared session) · `collaborator` (+ their own session beside yours). Per guest you can set a power ceiling (`plan` = read-only, or `build`), a locked model or a model list, a cap on model calls or cost, and an expiry. Your keys and provider settings are never exposed to guests, and a guest with `build` power runs commands on **your machine** — invite only people you trust. Details and the threat model are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §7.6.

---

## Documentation

English is the default; Arabic versions are in `docs/ar/` and the `*.ar.md` files.

| Document | When |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How everything works and why |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running VARA on a PC, a VPS, Docker or a CI box (systemd, compose, TLS proxy) |
| [docs/EVAL.md](docs/EVAL.md) | `vara eval`: does the cost engine save money without lowering quality — method, results, what is not measured |
| [docs/WEB-SEARCH.md](docs/WEB-SEARCH.md) | Live web search and page reading for the agent: no paid API, runs from your machine, safety limits, what was verified |
| [docs/HERMES-COMPARISON.md](docs/HERMES-COMPARISON.md) | What we learned from Hermes Agent: what VARA has, what it lacks, and the order we will close the gaps |
| [docs/OAUTH.md](docs/OAUTH.md) | Browser sign-in for remote MCP connectors (GitHub, Notion, Sentry, Supabase) — what VARA does and what you must set up yourself |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Changing the code safely; known traps |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is open, what is deliberately not done |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Before your first commit |
| [CHANGELOG.md](CHANGELOG.md) | What actually changed |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Ideas taken from other projects |

## License

[MIT](LICENSE) — use, modify, redistribute and embed VARA in your work, commercial or not. The licences of the libraries bundled in the release packages are in `THIRD_PARTY_LICENSES.txt`.

## Project rules

1. **No secrets in the repository** — keys live in the encrypted vault or in environment variables; the config holds only their **names**.
2. **`npm run check` is green before every push** (typecheck + tests + build). A failure is reported as it is.
3. **unknown ≠ 0** — a value that is not known stays unknown.
4. **Proof by test** — new behaviour or a fix comes with a test that fails before it and passes after.
5. **Honest interface** — no success indicator without evidence, no "done" without verification.
