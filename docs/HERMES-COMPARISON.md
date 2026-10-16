# VARA and Hermes Agent — what we learned and where we stand

**English** · [العربية](ar/HERMES-COMPARISON.md)

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT) is the most complete open agent we looked at. This page is the result of reading its README, its tool list and its prompts (October 2026). We take **ideas** and re-write them in VARA's own code; nothing was copied. It is a map, not a promise: "missing" means missing today.

Legend: ✅ have · 🟡 partly · ❌ missing · ➖ deliberately not a goal.

## Reliability of the agent itself

| Hermes | VARA | Note |
| --- | --- | --- |
| Refuses an edit when the file changed since it was read | ✅ **new** | `src/tools/file-guard.ts`; the agent is told to read the file again. |
| File checkpoints and rewind | ✅ **new** | Every write, edit and delete is saved first; `/undo [n]` and `/checkpoints` (terminal), `/undo` (browser). Survives a restart. Files over 2 MB are not saved and say so. |
| Search of past sessions | 🟡 **new** | `session_search` scans the 80 most recent sessions of the folder for the words you give. Hermes has a full-text index with summaries; ours is a plain scan. |
| Tolerant edits (fuzzy match, escape-drift repair) | 🟡 | Only CRLF/LF differences are tolerated. |
| Prompts that make the model act instead of announce | ✅ **new** | A short "use what you have" block and a stronger chat → task rule. Not yet measured with `vara eval` on a real model. |
| Output spill and retrieval of long tool results | ✅ | `tool_output`. |
| Smart / "yolo" approval modes | 🟡 | Approvals are per action; no learned allow-list. |

## Cost and context

| Hermes | VARA | Note |
| --- | --- | --- |
| Context compression | ✅ | `/compact`, auto-compact, cost engine v2. |
| Lazy tool schemas (`tool_search`) | ❌ | Would cut the per-turn prompt further. Good next step. |
| Batch independent tool calls | ✅ | Prompt rule + parallel execution. |

## Where it runs and who it talks to

| Hermes | VARA | Note |
| --- | --- | --- |
| Messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal) | ❌ | Not started. Telegram and Discord first if wanted (see the platform notes in the project discussion). |
| Terminal backends (Docker, SSH, Modal, Daytona…) | ❌ | Tools run on the host. Needed before any hosted offering. |
| Scheduled runs that deliver to a chat | 🟡 | `vara schedule` runs and logs; no delivery. |
| Background process registry with logs | 🟡 | Dev servers via `preview`; no general background shell. |
| Web UI + TUI | ✅ | Both, with a parity table ([ARCHITECTURE.md](ARCHITECTURE.md)). |
| Android (Termux) packaging | ❌ | Their route to phones; the browser UI already works on a phone. |

## Skills, tools, safety

| Hermes | VARA | Note |
| --- | --- | --- |
| Skills created and improved by the agent | ✅ | Proposed by the agent, approved by you. |
| Skills hub, linter, security scan of skills | ❌ | We do not install third-party skills automatically. |
| agentskills.io compatibility | ❓ | Not checked. |
| MCP with OAuth | 🟡 | Done and tested against a local fake server only. |
| Package vulnerability check (OSV) before installs | ❌ | |
| URL and path safety, secret redaction | ✅ | |
| Browser and computer use | ✅ | Windows desktop verified; macOS and Linux not. |
| Voice, TTS, image and video generation | ➖ | Not what a coding agent needs first. |
| Kanban board of agents | 🟡 | `delegate` with roles and dependencies, no shared board. |

## What to do next, in this order

1. Measure the prompt changes and compaction with `vara eval` on one real model, and publish the table.
2. Lazy tool schemas (`tool_search`).
3. A Docker backend for tool execution.
4. Telegram bridge, with the owner pairing and in-chat approvals.
5. Background shell processes and delivery of scheduled results.
