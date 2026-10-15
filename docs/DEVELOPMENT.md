# Development guide — VARA

**English** · [العربية](ar/DEVELOPMENT.md)

A **deep** document: how to develop the project safely without breaking what works. To just run the tool see the [README](../README.md); to understand the structure see [ARCHITECTURE](ARCHITECTURE.md).

---

## 1. Environment

```bash
npm install          # Node >= 20 (CI runs Node 20 and 22 on Ubuntu, Windows and macOS)
npm run check        # the full gate: typecheck + test + build
npm link             # provides the `vara` command globally for hand testing
```

Individual commands:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` for the app and for `ui/` |
| `npm test` | `vitest run` (single-run mode) |
| `npm run dev [args]` | Run from source via `tsx` — develop VARA without rebuilding (e.g. `npm run dev run "a task"`) |
| `npm run dev:ui` | A development host with a **scripted fake model** and a throw-away data folder, so the web UI can be built and checked with no key and no cost; prints the owner and guest links |
| `npm run build:ui` | Bundle `ui/` into `src/server/ui-assets.ts` (generated, git-ignored; runs automatically before typecheck, test, build and dev) |
| `npm run test:watch` | Watch mode |
| `npm run build` | Build `dist/` |
| `npm run check` | The three-part gate — **mandatory before every push** |

**No commit before `npm run check` is fully green.** A failure is reported as it is — never hidden or frozen.

---

## 2. Project map

```
src/
  cli.tsx          entry points: TUI / run / resume / sessions / ui / serve / invite / guests / setup / providers / secret / config / doctor
  doctor.tsx       `vara doctor`
  runtime.ts       builds the provider; resolves keys (vault, then env)
  version.ts       version injected at build time
  core/
    types.ts       all types — the source of truth; a change here spreads, check every user
    engine.ts      the one loop, budgets, proof, rejecting false completion (the biggest file — handle with care)
    intent.ts      deterministic EN+AR message classifier
    prompt.ts      the system message
    session.ts     session creation + zod input validation
    store.ts       state snapshot + event log on disk
    runner.ts      engine lifecycle with a clean stop
    runner-factory.ts  the ONE place wiring a session to provider, skills, budgets, MCP
    skills.ts  builtin-skills.ts   SKILL.md discovery and the built-in five
    context.ts     token estimates and the context window
  tools/
    types.ts       the tool contract (Tool<T>) and zod → JSON Schema
    registry.ts    all tools + `toolsForMode(plan|build)`
    permissions.ts authorize() — the only path to any execution
    fs-tools.ts  shell-tool.ts  git-tools.ts  control-tools.ts  search.ts
  llm/
    provider.ts    provider contract + createProvider + stream event contract
    openai.ts  anthropic.ts  retry.ts  sse.ts
    registry.ts    model registry: context window + pricing
    usage.ts  cost.ts      usage normalisation; cost — never guesses (null, not 0)
    capabilities.ts        which models can think, and how
    presets.ts  discovery.ts   provider presets; list and test models
  mcp/             client.ts (stdio + HTTP), hub.ts, input.ts
  security/        vault.ts (AES-256-GCM), redact.ts (scrubAll)
  config/          config.ts (zod), providers.ts (pure multi-provider ops), paths.ts (VARA_HOME), refs.ts
  server/          access.ts, host.ts, http.ts, manage.ts, commands.ts, ui-assets.ts (generated)
  tui/             App.tsx + keymap.ts (the only key policy) + rendering components
ui/                the web interface (React): src/components, i18n.ts, commands.ts, md.ts, transcript.ts, styles
tests/             ~35 files — see §4
scripts/
  build-ui.mjs          bundles ui/ into src/server/ui-assets.ts
  dev-host.ts           the fake-model development host
  package-release.mjs   self-contained release packages (esbuild bundle + bundled Node)
  live-flow-check.ts    a real end-to-end flow against a provider (see §4)
  live-usage-check.ts   one real call to check usage normalisation and pricing
install.ps1  install.sh      one-command installers
.github/workflows/  ci.yml (3 OS × Node 20/22), release.yml (on a `v*` tag)
```

**Coding rules** (binding):

- **No mutation:** create new objects (`{...obj}`), do not modify what is passed in.
- **Small files:** 200–400 lines usually, 800 the ceiling. `App.tsx` and `engine.ts` are existing, documented exceptions — do not make them longer.
- **Every external input goes through zod:** config, user input, model calls.
- **No `console.log` in `src/`** except the command-line surfaces (`cli.tsx`, `doctor.tsx`, `server/commands.ts`).
- **Errors are reported with a message that helps the user**, never a silent `catch {}`.
- **unknown ≠ 0:** an unknown value stays `null`/`unknown` through every layer to the display.

---

## 3. How to add things

### A new tool

1. Create it in the right file under `src/tools/` following the `Tool<T>` pattern (name, description, zod schema, an honest `readonly`, `run`).
2. Register it in `tools/registry.ts` and add it to `toolsForMode` for the right mode.
3. **If it can write, never mark it `readonly`** — that flag is what enforces plan mode on the tool.
4. Add a test: success in build, refusal in plan, and the guard check if there is one.
5. Update the tool table in ARCHITECTURE (both languages).

### A new terminal command

Add it to `COMMANDS` in `src/tui/commands.ts` (the one source for the list, `/help`, the palette and dispatch), handle it in `submit`/`runCommand` in `App.tsx`, and add a test that actually types its name in `tests/tui-app.test.tsx`.

### A new shortcut

**Do not register a handler in a component.** All the policy is in `resolveKey` (`src/tui/keymap.ts`):

1. Add the branch and return a specific `KeyAction`.
2. Handle the `KeyAction` in `App.tsx` (via a ref mirror if it reads state).
3. Add the line to `KEYS_HELP` and the relevant hint in the UI.
4. Add the line to the shortcut matrix in `tests/keymap.test.ts` — that matrix is not documentation, it is the defence line.

### A new web UI command or setting

Commands: add a `Cmd` where the person can use it (`SessionPage.tsx` for session commands, `App.tsx` for global ones) — it appears in `/`, the palette and help at once. Strings: add the key to **both** dictionaries in `ui/src/i18n.ts` (a test fails if Arabic lacks a key). A new management action: add it to `src/server/manage.ts` (owner-only, through `update()`), route it in `Manager.route`, and add a case to `tests/manage.test.ts`.

### A new model in the registry

In `src/llm/registry.ts` add a `ModelSpec` with pricing **only** if you know the price explicitly. An estimated price breaks the cost-truthfulness rule.

---

## 4. Tests

### Isolation — non-negotiable

`tests/setup.ts` points `VARA_HOME` at a temporary folder **before** any module from `src/` is imported (because `paths.ts` reads it at import time). Without it, sessions and the vault would be written to your real `~/.vara`. Do not remove or bypass this layer.

Isolated tests alone are enough for the gate — **never run a real test against a paid provider inside `npm test`.**

### Proven test patterns

- **FakeProvider:** a script of behaviours that runs out and then "hangs forever" — the only safe simulation of a stuck model; it also stops events leaking from a closed session.
- **Real key typing** (`\t`, `\r`, `\x0b`, `\x1b`, `\x0e`, `\x17`): do not call a handler directly and claim the shortcut works — type the key and read the screen.
- **`vi.waitFor` for timing:** the defaults are short (1 s) while some real completions take ~1.5 s — raise the timeout explicitly where needed.
- **A recurring trap:** do not type two keys in a row without a `waitFor` between them; state may not have settled.
- **vitest module isolation:** a static import and a dynamic `await import(...)` can land on **two separate module instances** in one file. If you test `registerSecret` from the file while the engine imports `scrubAll`, the engine may not see your registration. Import dynamically everything that depends on shared state, or test what `scrubAll` catches by pattern (`sk-…`). See `tests/engine.test.ts` and `tests/runtime-refs.test.ts`.
- **Server tests** start a real `startServer` on port 0 with an echo provider and a temporary access store (`tests/server.test.ts`, `tests/manage.test.ts`); the `Manager` takes injected dependencies, so no test touches the network or the vault.

### The cost benchmark

`npx tsx scripts/cost-bench.ts` runs scripted scenarios through the real engine with a measuring fake provider (`tests/bench/scenarios.ts`) and prints the tables in `docs/COST.md` §7. `tests/cost-bench.test.ts` keeps their direction as regression tests (`VARA_BENCH_LONG=1` adds the 90-call session). When you change anything that affects what the model is sent (prompt text, tool output shaping, compaction, routing), re-run it and update the numbers in `docs/COST.md` and `docs/ar/COST.md` — a claim in the docs must be a number the script printed. The provider cache in the benchmark is simulated; do not present its numbers as live measurements.

### Defence-line files — never weaken

| File | What it guards |
| --- | --- |
| `tests/keymap.test.ts` | The whole shortcut matrix — removing a shortcut fails here |
| `tests/commands.test.ts` | The command list and `/help` |
| `tests/tui-app.test.tsx` | Lifecycle integration: create, tabs, palette, commands on the start screen |
| `tests/engine.test.ts` | Rejecting false completion — the project's most important promise |
| `tests/permissions.test.ts` | plan/build and the command policy |
| `tests/redact.test.ts` `tests/vault.test.ts` | No secret leaks |
| `tests/runtime-refs.test.ts` | `apiKeySecret`/`apiKeyEnv` are names, not keys; "No API key" message without a key |
| `tests/access.test.ts` `tests/server.test.ts` `tests/manage.test.ts` | Guest permissions, hardening, owner-only management |

### Live checks (optional, when a real provider's behaviour is in doubt)

```powershell
$env:VARA_HOME="C:\temp\vara-live-home"          # a disposable folder — never use ~/.vara
$env:VARA_LIVE_KEY_ENV="OPENAI_API_KEY"           # name of the env var holding the key (default OPENAI_API_KEY)
$env:OPENAI_API_KEY="..."                         # from a safe source — do not paste it into a file
$env:VARA_LIVE_BASE_URL="https://api.openai.com/v1"   # optional, this is the default
$env:VARA_LIVE_MODEL="gpt-4o-mini"                    # optional, this is the default
npx tsx scripts\live-flow-check.ts                # a full real flow: tool → verify → accept
npx tsx scripts\live-usage-check.ts               # one call: usage normalisation + pricing
```

These scripts prove what fakes cannot: real SSE behaviour, usage formats, and the actual verification path.

---

### Manual checks for real OS and browser control (before a release)

CI never drives a real desktop or browser. Run these by hand on the machines you release for:

```bash
npx tsx scripts/browser-smoke.ts     # real Chrome/Edge: open, type, click, refused password/pay/metadata, screenshot
npx tsx scripts/desktop-smoke.ts --move   # real screen: screenshot, active window title, pointer move (never clicks or types)
```

Desktop on **macOS** (needs Accessibility and Screen Recording permission for your terminal) and **Linux** (X11 with `xdotool` and `scrot`/ImageMagick) is written but has not been verified: before claiming support, run `desktop-smoke.ts`, then a short session that opens a text editor, types a line and saves with Ctrl+S, and confirm that pausing the session stops the next action.

---

## 5. Documented Ink traps (read before touching `App.tsx`)

1. **Stale closure** — `useInput` is re-attached every render; a key may arrive before effects run. Rule: **ref mirrors** written every render (`overlayRef`, `escArmedRef`, `draftKindRef`, `draftModeRef`, `inputRef`); the handler and `submit` read only from them — never from closure variables.
2. **`Esc` at application level** — in `resolveKey`, not inside a component. It works even before an overlay subscribes, and `onClose` closes again safely.
3. **Closing a tab stops the runner synchronously** (`runner.pause()`) — a stuck provider cannot block closing a tab.
4. **One chunk = a paste** — multi-character text arrives at once; do not process it as separate characters.
5. **`exitOnCtrlC: false`** — Ink exits before a manual handler runs; without this every Ctrl+C exit would lose the session save.

---

## 6. Working with a partner

See [CONTRIBUTING.md](../CONTRIBUTING.md) — branch, commit and review rules before pushing. In short: a branch per change → `npm run check` → Conventional Commit → push → partner reviews the diff.

---

## 7. Known traps when changing the interface and engine

- **Ink redraws everything if the frame is as tall as the terminal** — keep the session frame at `rows-1` and make every fixed row `flexShrink={0}` (header, divider, input box, footer, chat blocks), otherwise Yoga squeezes them when content overflows (the input box vanishes, or lines are lost).
- **Do not edit old tool outputs incrementally** — every edit mid-conversation breaks the provider's cache. Compaction happens **in one batch** (`compactIfNeeded`), and the system message must not hold anything that changes every turn (use `buildStateNote`).
- **Keystrokes may arrive before a redraw** — read state from refs (`useSync`) inside `useInput` handlers, not from the closure.
- **Ink tests:** `await settle()` before the first key and after opening any layer (its subscription is mounted after the first frame).
- **Line endings:** the repository is `eol=lf`. Any script that writes files on Windows must write LF.
- **`vara` runs `dist/`** — run `npm run build` after every change before trying the global command.
- **The embedded web UI is generated** — `src/server/ui-assets.ts` is git-ignored and rebuilt by `npm run build:ui` (and automatically by the other scripts); never edit it.
- **Heredocs and Windows:** generating files with shell heredocs or Python text mode can corrupt backslashes and line endings — write files with an editor tool or a script file.

---

## 7.1 How to cut a release

```bash
# 1) Bump the version in package.json, record the change in CHANGELOG.md (and CHANGELOG.ar.md),
#    and push to main (CI green).
# 2) Tag and push the tag — that is all:
git tag v0.4.0 && git push origin v0.4.0
```

The workflow (`.github/workflows/release.yml`) runs the full gate, builds a self-contained package per OS (it carries its own Node.js), smoke-tests each unpacked package in a clean folder, publishes with `SHA256SUMS.txt`, and then installs for real with the actual install scripts on clean runners. **Never move a tag after it is published**; if something fails, fix it and release a new number. Local trial of a package: `node scripts/package-release.mjs`, unpack `release/out/*` into a clean folder and run `vara doctor`.

---

## 8. The "do not break" checklist

Before claiming a change is safe, make sure:

- [ ] `npm run check` is fully green (not half of it).
- [ ] Any new or fixed behaviour has a test that fails without it.
- [ ] No `null` was replaced by `0` in any cost or usage path.
- [ ] Any new tool/model output passed through `scrubAll`.
- [ ] No file outside the scope of the change was reformatted or "improved".
- [ ] Neither `keymap.test.ts` nor `commands.test.ts` was weakened.
- [ ] The docs were updated in both languages.
