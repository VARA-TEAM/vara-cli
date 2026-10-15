# Cost engine v2 — a limit that lasts

**English** · [العربية](ar/COST.md)

The goal: the same work, with far fewer limit-units spent, **without** asking the user to change how they work and **without** lowering the quality they asked for. This file says what VARA does, why, what was **measured** (and how), and what is **not** measured. Numbers come from `npx tsx scripts/cost-bench.ts` (offline, reproducible); nothing here is a guess dressed as a result.

Contents: 1. Research · 2. What VARA does · 3. The router · 4. Context · 5. Waste control · 6. Limit meter and savings report · 7. Measured results · 8. What is NOT proven · 9. Configuration · 10. Running the benchmark

---

## 1. Research — how other tools waste or save tokens

Sources are cited; where a source is a blog or a forum I say so, and I rely on official pages for every number I use in code.

| Tool | What it does (and what wastes tokens) | Source | Taken into VARA |
| --- | --- | --- | --- |
| **Claude Code** | Official advice: keep context small (`/clear` between tasks, compact with instructions), Sonnet for most work and Opus only for hard architecture, `model: haiku` for simple sub-agents, lower the thinking effort/budget on simple tasks, delegate verbose operations (tests, logs) to sub-agents, use **hooks to filter long output** ("a hook can grep for ERROR and return only matching lines, from tens of thousands of tokens to hundreds"), **code-intelligence plugins** so one "go to definition" replaces grep + reading several files, keep `CLAUDE.md` under ~200 lines. Why usage climbs: the full conversation is re-sent every request; a cache miss after a break longer than the cache lifetime re-reads everything; compaction is itself a large request. | [Manage costs effectively](https://code.claude.com/docs/en/costs) (official) | tiers + escalation (§3), output compression (§4), repo map / `read_symbol` (§4), summaries made *once* by a cheap model (§4), eco mode lowers thinking |
| **Anthropic prompt caching** | Up to **4** `cache_control` breakpoints; entries are written only at breakpoints; a read looks back at most **20 positions** per breakpoint (consecutive `tool_use`, or consecutive `tool_result`, blocks count as one position); the cache order is tools → system → messages, so a change early invalidates what follows; changing thinking parameters invalidates messages; read = 0.1× (0.05× on the newest models), 5-minute write 1.25×, 1-hour write 2×; default TTL 5 min, refreshed on use; minimum cacheable length 512–4096 tokens depending on the model. | [Prompt caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) (official) | stable prefix, 4 breakpoints (§4), **never switch model mid-conversation without need** (each model has its own cache — measured in §7), thinking is dropped after a model switch |
| **OpenAI prompt caching** | Automatic for supported models; needs an identical prefix (stable content first, dynamic last; append, do not rewrite history; "avoid compaction or truncation that alters the prefix"); cached input is billed at a reduced rate (up to 95% off depending on the model); `prompt_cache_key` helps route a session to one cache on older models. | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (official) | state note rides at the END, compaction in one batch (prefix stable), `prompt_cache_key` = session id on api.openai.com only |
| **Aider** | A **repo map**: a concise map of the repository's files with their key classes/functions, ranked by a graph algorithm so only the most relevant part fits a token budget (`--map-tokens`, default 1k). The model finds code without reading whole files. | [Aider — repository map](https://aider.chat/docs/repomap.html) (official; the page does not describe tree-sitter, secondary write-ups do: [fast.io](https://fast.io/resources/aider-token-limit.md), [agentpatterns.ai](https://www.agentpatterns.ai/context-engineering/repository-map-pattern/)) | `repo_map` + `read_symbol` (§4) — the idea only; VARA uses a small regex extractor, not tree-sitter |
| **OpenCode** | Treats full summarisation as a last resort and first *prunes* old tool output (a secondary write-up reports it protects the most recent ~40k tokens of tool output and prunes beyond ~20k); compaction near full capacity. | [Context Compaction Deep Dive](https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/), [OpenCode compaction](https://learnopencode.com/en/5-advanced/20-compaction) (secondary — numbers not verified against OpenCode's code) | old tool output is shortened first, then summarised (§4) |
| **Codex CLI / Claude Code (compaction)** | A "microcompact" that clears redundant old tool output without a model call; a model summary only when needed; one write-up notes auto-compaction can itself cost 100–200k tokens. | [Context Compaction Showdown](https://codex.danielvaughan.com/2026/04/10/context-compaction-showdown-coding-agents/) (secondary) | VARA summarises **once**, in one batch, with the cheap tier, and only when a cheaper model exists |
| **Cline / Cursor** | The searches did not return their own documentation, so I make **no claim** about their internals. | — | — |

Two lessons that shaped the design: (1) cache reads are ~10× cheaper than fresh input, so **keeping the prefix byte-stable is worth more than any trimming**; (2) every model has its own cache, so a "clever" router that flips models turn by turn can cost *more* than it saves — §7 shows a measured case.

---

## 2. What VARA does

| # | Technique | Where | Effect | Evidence |
| --- | --- | --- | --- | --- |
| 1 | **Model router**: strong / standard / cheap tiers per turn, quality floor, escalation, hysteresis, eco mode, visible reason | `core/router.ts` | dollars (model price) and, with summaries, tokens | unit tests + §7 |
| 2 | **Output compression** with a way to ask for more (`tool_output`) | `core/outputs.ts` | fewer tokens per command result; errors kept | §7 |
| 3 | **Identical-output pointers** | engine | repeated `ls`/`git status` results not resent | §7 counter |
| 4 | **Repo map + `read_symbol` + outline for long files** | `core/repomap.ts`, `tools/repo-tools.ts` | finding code without reading files | §7 |
| 5 | **Summary of old turns** (ROADMAP R5) by the cheap tier, once | `core/summarize.ts` | every later request is smaller | §7 (long session) |
| 6 | **4 cache breakpoints** (insurance), `prompt_cache_key`, stable prefix | `llm/cache.ts`, `llm/openai.ts` | cache hits survive unusual turns | simulation + unit tests |
| 7 | **Runaway-loop stop** after 5 identical calls | engine | stops burning the limit | §7 |
| 8 | **Skip re-verification** when nothing changed | engine | no re-run of the test command | §7 |
| 9 | **Parallel read-only tools** (ROADMAP R4) | engine | speed (no token effect) | unit tests |
| 10 | **Limit meter**, pace, plan-percentage calibration, soft warnings, opt-in eco | `core/usage-meter.ts` | you see how long the limit lasts | unit tests |
| 11 | **Savings report** with a stated baseline | `core/usage-meter.ts` | honest comparison | §6, §7 |

Everything above is wired in one place (`core/cost-wiring.ts`) so the terminal and the web host get it together.

---

## 3. The router

One pure function per turn (`decideRoute`). Inputs: the intent (chat / question / task / goal), whether this is the first turn of an objective, what the previous turn did, failures, the quality floor, eco state, the size of the conversation. Output: a tier, a model, a **phase** and a **reason** (shown in the terminal when it matters, in the audit log for every turn, in `/route` and the web board).

Tiers are configurable models, optionally on another configured provider (`{ "model": "gpt-4o-mini", "provider": "openai" }`). Unset: *strong* and *standard* = the model you picked for the session, *cheap* = `agent.cheapModel` — with nothing configured VARA behaves exactly like v0.4.0.

| Phase | When | Wanted tier |
| --- | --- | --- |
| chat / answer | small talk, questions | cheap |
| plan | first turn of an objective, or PLAN mode | standard; **strong** when the objective looks clearly complex (long, or a keyword like refactor/architecture/migration/security *and* ≥15 words) |
| edit | an ordinary working turn | standard |
| search | the previous turn only read/searched, all succeeded | cheap (if the floor allows) |
| recover | a tool failed twice in a row | one tier up |
| verify | the engine refused a completion claim | one tier up |
| summarise | folding old turns | cheap |
| subagent | research sub-agent / editing sub-agent | cheap / standard |

**The quality floor** (`routing.floor`, default `standard`) is applied last: *no work turn is ever routed below it* — not by eco mode, not by "this turn is mechanical", not by a missing config (tested). Summaries and conversation are not work turns. Escalation can only raise a tier.

**Hysteresis.** A downgrade needs two consecutive turns that want the lower tier **and** a small conversation (≤ 8k tokens): moving a long conversation to another model re-bills all of it uncached. §7 measures what happens without this.

**Eco mode** (opt-in, `limits.autoEco`): from `ecoAt`% of your limit, routine turns (edit/search/plan) go one tier lower — still clamped by the floor — thinking is kept only for plan/recover/verify turns, compaction starts earlier and command output is kept shorter. A message says so when it turns on. It never turns on by itself.

---

## 4. Context

- **Stable prefix.** System prompt and tool list are identical between turns; the volatile state rides in a final message. Compaction and summaries happen in one batch, so the prefix is stable again right after.
- **Four Anthropic breakpoints**: last tool, system, last message, and the previous user message (where the last request ended). Honest note: by Anthropic's documented rule an ordinary tool turn adds ~3 positions, so the 4th breakpoint changes *nothing* there (benchmark §6); it protects turns that add 20+ positions (many images/attachments).
- **Output compression** (`context.toolOutputChars`, default 6000): a long command output keeps its head, its tail and every line that looks like an error/verdict, collapses repeated lines, strips colour codes, and ends with a note naming the id to ask for more. The full text is stored (memory + the session folder) and the model gets `tool_output {id, grep | head | tail | from/to}` — cheaper than re-running the command. In the benchmark the script of that arm **includes the extra retrieval turn**.
- **Identical results** (≥ 400 chars, same tool, same text, earlier result still in context) become a one-line pointer.
- **Repo map**: `repo_map {query, path, budgetTokens}` returns a ranked outline (files → functions/classes/types with line ranges) within a token budget; `read_symbol {name}` returns only that symbol's lines; a file over 1000 lines read without a range returns an outline + its first 60 lines (`context.smartRead`; `limit=2000` forces the whole file). Regex extractors for TS/JS, Python, Go, Rust, Java/Kotlin/C#-style; ranking = how many other files mention each symbol (a cheap stand-in for Aider's graph ranking); it can miss exotic syntax and says it is an index.
- **Summaries**: when the not-yet-folded old part of the conversation exceeds ~12–30k tokens (15% of the request budget) **and** a cheaper model exists, one call to the cheap tier writes a ≤350-word brief (goal, done, decisions, open problems, facts). Old messages are *marked* `summarized`, never deleted: the interfaces keep the full history, the audit log is untouched, and the tool-call/tool-result pairing is never split. Without a cheaper model nothing changes (compaction remains).
- **Compaction** now keeps the error lines of an old result instead of blind head+tail.

## 5. Waste control

Loop stop (5 identical calls in a row; the 3rd already warns), no re-verification when no mutating tool succeeded since the last run of the same command (the `shell` tool counts as mutating), parallel read-only tools within a turn (results appended in call order; every call passes `authorize()` first), a prompt line asking the model to batch independent reads and to find before it reads, and chat/questions on the cheap tier.

---

## 6. Limit meter and savings report

`/limit 5000000 tokens per 5h`, `/limit $20 per month`, `/limit percent 37`, `/limit eco on at 85`, `/limit off` (also *Settings → Cost* in the web board). Whatever you type is what VARA counts against; **it never claims to know your provider's private quota.**

- **Tokens** are weighted: input + cache-write + output + `cachedWeight` × cache-read (default 0.1; providers bill cache reads far lower).
- **Plan percentage**: type the percentage your provider shows now, and again later. Two readings that moved forward teach VARA how many tokens are 1% of your plan; until then it shows your reading as typed and says it cannot project.
- **Pace**: "at this rate your limit lasts N hours" from the last 30 minutes of activity; with too little recent activity it says so instead of inventing a number; for a calendar window it says when the limit outlasts the reset.
- **Unknown is never zero.** A call whose usage the provider did not report is counted separately ("N calls did not report usage; the real figure may be higher") and adds nothing to a total or a saving.
- **Soft warnings** at 70 / 85 / 95 % (configurable), once each per session, in the terminal and the audit log.
- **The ledger** is `~/.vara/usage.jsonl` (append-only, one line per model call, plain numbers — no prompts, no secrets). Sub-agent calls are in it once.
- **Savings report** (`/savings`, web board): actual vs an estimated plain-loop baseline, per session, 7 days, all time. **Method:** the baseline is the same conversation sent as a plain agent loop would send it — every message at its original length (no compaction, summary, dedupe or compression; tool output capped at 12 000 characters as in v0.4.0), **no prompt cache**, one model (the one you chose) and the same output tokens. The baseline's input size is estimated at 4 characters per token; the actual side always uses the provider's counts. Because it includes "no prompt cache", the percentage is dominated by caching VARA **already had** — so the benchmark below reports the honest increment (A → D) as well. A summary call is counted as pure cost.

---

## 7. Measured results

Run: `npx tsx scripts/cost-bench.ts` (about 25 s). Scripted scenarios, the real engine, a measuring fake provider (prefix cache simulated as the longest common prefix with the previous request to the same model, 1024-token minimum). Models and prices are the registry's: opus `claude-3-opus` $15/$75, sonnet `claude-3-5-sonnet` $3/$15 (cache read $0.30), haiku `claude-3-5-haiku` $0.80/$4 per 1M (as of the dates stored in `src/llm/registry.ts` — older models, because the registry only holds prices that were confirmed).

The benchmark keeps command output at 3,000 characters (the shipped default is 6,000), so it shows a slightly stronger effect than the default would.

**Limit units** = uncached input + 0.1 × cached input + output. **Arms:** A = v0.4.0 (stable prefix, `cache_control`, compaction, read dedupe) · B = A + output economics (compression with `tool_output`, identical-output pointers, outline for long files, verification reuse, loop stop) · C = B + summaries by a cheap tier · D = C + work on the *standard* tier (floor standard) · E = D with the floor lowered to *cheap*. The scenario is a coding task: explore, read files, one noisy test run (2,500 lines, the failure at line 2,300), an edit, a re-run, 22 or 80 more reads/searches, verify, complete.

**Medium session (33 model calls)**

| arm | input tokens | cache share | limit units | USD | vs A (units) | vs A (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A v0.4.0 | 814.5k | 89% | 168.4k | $2.842 | — | — |
| B + output economics | 749.1k | 92% | 135.9k | $2.351 | **19.3%** | 17.3% |
| C + summaries | 749.1k | 92% | 135.9k | $2.351 | 19.3% | 17.3% |
| D + router (standard tier) | 749.1k | 92% | 135.9k | $0.470 | 19.3% | **83.5%** |
| E + floor cheap | 749.1k | 90% | 149.2k | $0.373 | 11.4% | 86.9% |

**Long session (91 model calls)**

| arm | input tokens | cache share | limit units | USD | vs A (units) | vs A (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A v0.4.0 | 2702.9k | 92% | 469.3k | $7.409 | — | — |
| B + output economics | 2754.4k | 96% | 376.2k | $6.008 | 19.8% | 18.9% |
| C + summaries | 1776.2k | 95% | 269.8k | $4.335 | **42.5%** | 41.5% |
| D + router | 1776.0k | 95% | 269.7k | $0.870 | 42.5% | **88.3%** |
| E + floor cheap | 1776.0k | 94% | 286.1k | $0.486 | 39.0% | 93.4% |

How to read it honestly:
- **Tokens (what a subscription limit counts): −19% on a medium session, −42% on a long one**, from output economics and summaries. These are measured on the *same* scripted conversation.
- **Dollars: −83% / −88%** — almost all of it is the router moving work from the *strong* model to the *standard* one (opus → sonnet is a 5× price difference). That saving is real **only if** the standard tier does your work as well as the strong one; the floor is how you decide. On a subscription whose limit counts tokens per model family, the effect is plan-specific and not measured here.
- **Arm E is a trade, not a free win:** the dollar cost falls further, but limit units *rise* (+13.3k medium, +16.4k long) because switching models re-bills the conversation uncached. That is why the default floor is `standard` and why downgrades are gated by conversation size. Quality of a cheap tier on work turns is **not** something an offline benchmark can show.
- The engine's own savings report (baseline = plain loop, no cache) shows 89–96% — a number dominated by the prompt cache v0.4.0 already had. Quote the A → D increment, not that one.

**Other measurements**

| Scenario | v0.4.0 | now |
| --- | --- | --- |
| Runaway loop (same call forever) | 60 requests (stopped only by the 60-turn budget) | **5 requests** |
| Re-verification: 3 completion claims in a row, nothing changed | 3 runs of the test command | **1 run** |
| 10 chat/question messages, same replies | $0.142 all on opus | **$0.008** on the cheap tier (−94.7%) |
| "Where is `saveSession` and how is it used" in this repo (232 files indexed) | ~9.2k tokens (list + grep + read the 4 files that mention it, capped at 12k chars each) | **~1.3k tokens** (`repo_map` + `read_symbol`) |
| Longest source file read without a range | ~3.0k tokens | ~1.2k tokens (outline + first 60 lines) |
| Cache lookback (simulation of the documented 20-position rule) | one turn adding 3 positions: 92% cached with or without the 4th breakpoint; one turn adding 22+: **0% → 92%** | |

---

## 8. What is NOT proven

- **Quality is not measured.** The scripts are fixed, so an arm that sends less is leaner for the same conversation, not "as good". Whether a model still solves the task when it sees a compressed output, an outline instead of a whole file, or a summary instead of old turns can only be shown by live runs on real tasks. The design protects quality structurally (errors kept in compressed output; the full text one tool call away; summaries never delete history; a floor you control; escalation on failure) but that is a design argument, not a result.
- **Models are not simulated** — real models may ask for more (`tool_output`) more or less often than the script does.
- **The provider cache is simulated**; real TTLs, granularity and per-model multipliers differ. Current Anthropic rates on the newest models (0.05× read) are not in the registry.
- **Plan accounting is the user's:** a subscription may weigh models differently; VARA counts weighted tokens or dollars you choose, or learns from your typed percentages.
- **Cross-provider tiers** are implemented and unit-tested (a tier on another provider, lazy key resolution, fallback to the session model when unavailable) but **not run against two live providers**.
- **Live checks not done here:** no real API call was made by this work. `scripts/live-usage-check.ts` remains the way to verify a real endpoint.
- Cursor and Cline internals were not researched (the search returned nothing usable).

## 9. Configuration

`~/.vara/config.json`:

```json
{
  "routing": {
    "enabled": true,
    "floor": "standard",
    "escalateOnFailure": true,
    "tiers": {
      "strong": "claude-3-opus",
      "standard": "claude-3-5-sonnet",
      "cheap": { "model": "claude-3-5-haiku" }
    }
  },
  "limits": { "unit": "tokens", "amount": 5000000, "window": { "kind": "rolling", "hours": 5 }, "autoEco": false, "ecoAt": 85, "cachedWeight": 0.1 },
  "context": { "summarize": true, "toolOutputChars": 6000, "smartRead": true }
}
```

Terminal: `/limit`, `/savings`, `/route`, `/cost`. Web (owner): `GET/PATCH /api/manage/cost`; components `CostMeter` and `CostBoard` (`ui/src/components/Cost*.tsx`).

## 10. Running the benchmark

```bash
npx tsx scripts/cost-bench.ts          # tables as in §7
npx tsx scripts/cost-bench.ts --json   # raw numbers
npx vitest run tests/cost-bench.test.ts            # the claims as regression tests (about 15 s)
VARA_BENCH_LONG=1 npx vitest run tests/cost-bench.test.ts   # + the long session
```
