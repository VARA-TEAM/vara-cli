# `vara eval` — does the cost engine save money without lowering quality?

**English** · [العربية](ar/EVAL.md)

[docs/COST.md](COST.md) says what the cost engine does and measures what VARA *sends*, offline. That cannot answer the question that matters to a user: **does the agent still get the job done?** `vara eval` is the harness for that question. This page says how it works, what was measured, and — just as important — what was **not**.

## Status in one paragraph

The harness, 19 tasks and the report are built and tested. The offline mode (scripted model) runs in CI. **No run against a real provider has been done or published yet**, so there is currently **no evidence about quality with a real model**, only the machinery to get it. Run it on your own provider (below) — that is the only measurement that counts for you.

## What it does

For every task × arm × model × repetition it:

1. writes the task's tiny project into a fresh temp directory;
2. runs the real VARA engine on the task's objective (same budget, same verify command) with the **cost engine OFF** (the plain agent loop) or **ON** (output compression, summaries of old turns, smart reads of long files, identical-output pointers, verification reuse, loop stop, and *your* routing config if you have one);
3. when the agent stops, **the runner itself** executes the task's check command (`node check.mjs`) — the agent's claim of success is never trusted;
4. records pass/fail, session state, agent turns, model calls, tokens (input / cached / output), limit units, cost, wall time. **Unknown stays unknown:** a provider that reports no usage, or a model with no known price, gives `null`/"unknown" — never zero — and one unknown run makes the total unknown instead of a misleading partial sum.

Then it writes `results.json` and `report.md` (default `./vara-eval/<timestamp>/`) with, per model: pass rate with a 95% Wilson interval, the **quality delta** (ON minus OFF, in points), **savings %** (tokens, limit units, cost), turns and time, the list of **regressions** (tasks OFF solved and ON did not) and a savings figure restricted to tasks both arms solved (so an arm that fails early is not credited as "cheaper").

## The tasks

19 deterministic, dependency-free JavaScript fixtures in `src/eval/tasks.ts`: 13 one-line-to-few-line bug fixes, 3 features to implement (capitalize, chunk, CSV with quotes), 1 multi-file rename, and 2 "noisy" ones (a test run that prints 600 passing lines around one failure; a bug deep inside a 1,300-line module). List them with `vara eval --list`.

Every task is checked by `tests/eval.test.ts`: it **fails** on the untouched fixture and **passes** after the reference edits — so no task is unsolvable or already solved. The reference solution is never shown to a live model.

## Running it

Offline (no network, no cost, no model — this is what CI runs):

```bash
vara eval --offline
```

Against a real provider (spends your credit — start small, `--yes` is required):

```bash
vara eval --provider openai --model gpt-4o --tasks sum-off-by-one,noisy-test-output --yes
vara eval --provider anthropic --model claude-sonnet-4-5,claude-haiku-4-5 --repeat 3 --yes
```

Options: `--tasks a,b` · `--repeat N` (models are not deterministic — use 3 or more for a conclusion) · `--arms on,off` · `--model a,b` (several models are compared separately) · `--out DIR`. Exit code is 1 if any task OFF solved was lost with ON (and, offline, if any run failed), so it can gate a pipeline. Per-run caps: 30 turns, 80 model calls, 10 minutes.

The ON arm uses your configured routing (`routing.*` in the config). With routing off, ON measures output economics and summaries only; the report states which it was.

## Offline result (scripted model — read the caveats)

`npx tsx src/cli.tsx eval --offline`, 19 tasks, one repetition, price table of `claude-3-5-sonnet` as of the dates in `src/llm/registry.ts`:

| | OFF | ON | change |
| --- | ---: | ---: | ---: |
| runs passed | 19/19 | 19/19 | quality 0.0 points |
| limit units | ~110k | ~104k | ~5% fewer |
| tokens (input + cached + output) | ~359k | ~349k | ~3% fewer |
| cost (simulated tokens × price) | ~$0.363 | ~$0.346 | ~5% less |

Where the saving comes from: nearly all of it is one task — `noisy-test-output` (≈12.2k → ≈6.5k limit units, because a 600-line test run is compressed to its head, tail and the failing line). The 17 tiny tasks have nothing to cut and cost the same in both arms. That is the honest shape of the result: **the cost engine saves where output or history is large and does nothing where it is small.** The larger working-session numbers (summaries, router) are in [docs/COST.md](COST.md) §7; the eval and that benchmark share the same measuring provider (`src/eval/measuring-provider.ts`) rather than duplicating it.

### What the offline run does and does not prove

- A fixed script replays the *same* reference edits in both arms. The 19/19 vs 19/19 therefore proves only that the fixtures are solvable and that compression, pointers and smart reads **do not corrupt tool results or edits** in these cases. It says **nothing** about how a real model behaves when it sees compressed output.
- Token counts are the size of what VARA sent (about 4 characters per token); the provider cache is simulated; the dollar figure is simulated tokens × list price. It is not a bill.
- Wall time offline is the time of local file and process work, not of a model.

## What is NOT measured (yet)

- **Any real provider.** No live run has been published. The claim "the cost engine does not lower quality" is therefore **unproven for real models**; offline only shows the engine does not break the plumbing.
- **Sample size.** 19 tasks can reveal a big quality drop; they cannot rule out a small one (with 19/19 the 95% interval for the true pass rate is still about 83–100%). Use `--repeat`.
- **Scope.** Small JavaScript tasks. No large repositories, other languages, long multi-hour sessions, or tasks that need the browser, MCP or sub-agents.
- **Routing quality.** Whether cheaper-tier turns hurt depends on your tier models; run with your own routing config to find out.
- **Cache behaviour.** Real provider caches (TTL, granularity) differ from the offline simulation.

## Extending

Add a task to `src/eval/tasks.ts` with `make({...})`: fixture files, a check, and a unique-match reference edit. `tests/eval.test.ts` fails if the task is already solved, unsolvable, or its edit matches ambiguously.
