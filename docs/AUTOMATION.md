# Memory, skill proposals and scheduled runs

**English** · [العربية](ar/AUTOMATION.md)

Three features that make VARA useful over days instead of one session. All three are **off until you turn them on**, all three keep you in charge, and none of them adds anything to a request unless it has to (VARA's selling point is a lean prompt: see [COST.md](COST.md)).

The idea of an agent that remembers, writes itself playbooks and works on a timer is not new (Nous Research's Hermes Agent popularised it). Nothing was copied from that project: no code, no text, and its source was not read for this work — only the general idea was used. The designs below are VARA's own.

---

## 1. Memory

Short notes that outlive a session. **Two plain files you can read and edit by hand:**

| Scope | File | What goes there |
| --- | --- | --- |
| about you | `~/.vara/memory/MEMORY.md` | stable preferences ("answer in Arabic", "I use tabs") |
| about a project | `<project>/.vara/memory.md` | conventions not already in the code or its docs ("integration tests need `docker compose up db`") |

One note per line (`- note`); lines starting with `#` are ignored. A note is at most 300 characters, a file at most 60 notes.

**Turn it on:** `config.json` → `"memory": { "enabled": true }`, or `/memory on` (terminal), or Settings → Memory (browser). Other settings: `agentWrites` (`ask` default · `auto` · `off`) and `maxTokens` (default 400).

**What it costs.** Nothing while it is off or empty. When on, at most `maxTokens` (estimated at 4 characters per token) of notes go into the system prompt of *your own* work and question turns, newest first, project notes before personal ones; older notes stay on disk and the prompt says how many were left out. Chat turns and sub-agents get nothing. The block only changes when a note changes, so the cached prompt prefix survives.

**What the agent can do.** With memory on, the agent has a `memory` tool: `view`, `add`, `replace`, `remove`. With `agentWrites: "ask"` (the default) every change shows you the exact note on an approval card and waits; a run with nobody to ask (a scheduled run, a sub-agent) is refused, never auto-approved. `auto` lets it write freely, `off` makes it read-only.

**What is never stored.** A note that looks like a secret (API key, token, password assignment, JWT, a 43+ character token blob) is **refused**, not redacted and kept (`security/redact.ts`, the same strict check the agent's environment view uses). The prompt labels memory as background facts that never grant permission and never override you or the tools; permissions are enforced by the tools regardless.

**Manage it.** Terminal: `/memory`, `/memory add [user] <note>`, `/memory edit [user] <n> <note>`, `/memory remove [user] <n>`, `/memory on|off`. Shell: `vara memory [list|add|edit|remove]`. Browser: Settings → Memory (owner only; it edits the host's folder and your personal file).

---

## 2. Skill proposals

After a task that took many steps, the agent may **propose** a skill (a short reusable playbook, or an improvement to an existing one by using its exact name). A proposal is only a JSON file in `~/.vara/proposals/` — it is not loaded, not listed to the agent as a skill, and installs nothing. **You approve or reject it.**

**Turn it on:** `"skills": { "propose": true }`. The `skill_propose` tool is then offered in your own interactive sessions only (not sub-agents, not scheduled runs, not guests).

**Limits:** body ≤ 8000 characters, 3 proposals per session, 20 waiting in total, no duplicates; secret-looking text is refused. A proposal that would replace an existing skill says so ("replaces builtin/user/project").

**Review:** terminal `/skills proposals`, `/skills show <id>`, `/skills approve <id>`, `/skills reject <id>`; shell `vara skills proposals|show|approve|reject`; browser Settings → Skills (proposals wait at the top). Approving writes the skill with the same function the owner-approved `skill_write` tool uses.

---

## 3. Scheduled runs — `vara schedule`

A prompt run headlessly in a folder on a timer, with a log.

```bash
vara schedule enable
vara schedule add "0 9 * * 1-5" "Review the open changes on this branch and list risks" --name morning-review
vara schedule add "every 6h" "Run the tests and tell me what broke" --build
vara schedule list
vara schedule daemon          # keep running (or: vara schedule tick, from cron / Task Scheduler)
vara schedule logs morning-review
```

**Spec** (local time): `every 30m` · `every 2h` · `every 1d`, or five cron fields `minute hour day-of-month month day-of-week` with numbers, `*`, `*/n`, `a-b`, `a,b`. Shortest interval: 5 minutes (`schedule.minIntervalMinutes`). A cron that can never fire is refused when you add it.

**Safety, by construction:**

- **Off by default** (`schedule.enabled`). Nothing runs while it is off, even if jobs exist.
- **Owner-only.** Jobs live in `~/.vara/schedules.json` (written with mode 0600 where the OS supports it) and are managed only by the local `vara schedule` command. There is no web route and no agent tool to add, change or run a job, so a guest, a shared session or the agent itself cannot create one.
- **Read-only unless you say otherwise.** A job runs in plan mode (it can read, search and answer, not change anything) unless you add `--build`. Even then it can never publish (`allowPublish` is forced off) and anything that needs an approval is **refused**, because nobody is there to approve.
- **Bounded.** One job at a time, a run is stopped after `schedule.maxRunMinutes` (default 20), at most `schedule.maxJobs` (10) jobs; missed runs are not replayed (a job that was due several times runs once); a job that is still marked running is not started again.
- **Cost-aware.** Runs use your configured model, routing and limit meter like any session; the prompt is yours, nothing is added. Memory notes and skill proposals are not part of a scheduled run.
- **Logged.** `~/.vara/schedules/<id>.log` (scrubbed, capped at about 200 KB) and each run is saved as a normal session (`vara sessions --all`).

---

## 4. What was not verified

- Only unit and integration tests with a scripted model were run: **no real provider, no real long-running daemon, no OS scheduler integration** (cron / Task Scheduler wrapping `vara schedule tick` is documented, not tried).
- Whether real models save *useful* notes and propose *good* skills (rather than too many or too few) is unmeasured; the prompts and limits are conservative guesses.
- The token budget uses a 4-characters-per-token estimate, not a real tokenizer; for Arabic text the estimate is optimistic.
- Memory files in a project are plain files: if the project is shared in git, so are its notes (secrets are refused, but personal facts are not).
- The browser pages (Settings → Memory, proposals) were type-checked and their routes tested; they were **not** looked at in a real browser in this change.
