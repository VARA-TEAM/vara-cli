# Talking to VARA from a messaging app

**English** · [العربية](ar/GATEWAY.md)

The agent runs on your computer or server; a messaging app is just a remote control for it. Three platforms are built in — **Telegram, Discord and Slack** — and **you set up only the ones you use**: each is off until you give it its token, pair one private chat and switch it on. They are independent; use one, two or all three.

## Setting one up

**In the browser** (`vara ui` or `vara serve`): Settings → **Gateways** (or `/gateway`). Every platform has its own card with the exact steps for that platform, the fields for its tokens, a button for the pairing code and an on/off switch. Nothing needs a restart. Tokens are checked with the platform, kept in the encrypted vault, and never shown again.

**In the terminal:** `vara gateway <telegram|discord|slack> setup` prints the steps, asks for each token with a hidden prompt, checks it, switches the platform on and prints a pairing code. `vara gateway list` shows all three; inside the terminal interface `/gateway` shows the same and `/gateway <name> pair` makes a new code. Then run `vara serve` or `vara ui` (the bridges live inside the host).

Pairing: send `pair <code>` to your bot **in a direct message** (Telegram also accepts `/pair <code>`). The code works once and expires in ten minutes.

| Platform | You need | Notes |
| --- | --- | --- |
| Telegram | A bot token from @BotFather | Polling; nothing opened. |
| Discord | A bot token (developer portal → Bot) and the bot invited to a server you are in, so you can message it | Direct messages only; no privileged intent. |
| Slack | A bot token (`xoxb-…`) and an app-level token (`xapp-…`) with Socket Mode on | Slack swallows a leading `/`: write `!new`, `!stop`, `!undo` instead. |

## Using it

Write what you want done; VARA answers when its turn ends. `/new` starts a fresh session, `/stop` pauses the agent, `/undo` puts back its last file change, `/unpair` disconnects the chat. When the agent needs permission you get **Approve / Reject** buttons; nothing risky happens without that tap.

## How it is kept safe

- Only the paired private chat is served. Everyone else — and every channel or group — gets **no reply at all**, so the bot does not even confirm that it listens.
- Five wrong pairing codes lock pairing for an hour; a code is single-use.
- Every connection is outbound (polling or a WebSocket): no open port, no public address.
- A token never appears in an error message or a log. The agent has the same powers and approvals as in the terminal, and its answers are scrubbed of secrets as everywhere else.
- Telegram, Discord and Slack can read what the bot sends (none is end-to-end encrypted for bots). Do not ask the agent to print secrets, and do not use a gateway for code that must stay confidential.

## What was verified

The shared bridge (pairing, strangers ignored, lock-out, approvals only from the paired chat, commands, long answers split), the Discord and Slack protocol handling (identify, heartbeat, direct messages only, bots ignored, button taps, acknowledgements) and the settings logic are tested against fakes. **None of the three has been run against the real service yet.** Expect small fixes when you first try yours, and tell us what you see. More platforms (Matrix, WhatsApp Business) are not built; adding one is a single provider description in `src/gateway/providers.ts`.
