# Talking to VARA from Telegram

**English** · [العربية](ar/GATEWAY.md)

The agent runs on your computer or server; Telegram is just a remote control for it. It is **off by default**.

## What you do, once

**In the browser** (`vara ui` or `vara serve`): Settings → **Gateways**. Three steps on one page, and nothing needs a restart:

1. Paste the bot token (get it from **@BotFather** with `/newbot`). VARA checks it with Telegram, keeps it in the encrypted vault, shows only the bot's name, and switches Telegram on.
2. Press **Make a pairing code**, then send `/pair <code>` to your bot in a **private** chat (works once, expires in ten minutes).
3. The switch at the bottom turns the bridge on or off.

**In the terminal:** `vara gateway telegram setup` asks for the token without showing it, checks it, switches Telegram on and prints the pairing code. Then run `vara serve` (or `vara ui`). `/gateway` inside the terminal interface shows the status and makes a new code; `vara gateway telegram status | pair | unpair` do the same from outside.

## Using it

Write what you want done. VARA answers when its turn ends. `/new` starts a fresh session, `/stop` pauses the agent, `/undo` puts back its last file change, `/unpair` disconnects the chat. When the agent needs permission (changing its own setup, a risky step) you get **Approve / Reject** buttons; nothing risky happens without that tap.

## How it is kept safe

- Only the paired private chat is served. Everyone else gets **no reply at all**, so the bot does not even confirm that it listens. Groups are ignored.
- Five wrong pairing codes lock pairing for an hour; the code is single-use.
- It polls Telegram (an outbound connection): no open port, no public address needed. The bot token is never put in an error message or a log.
- The agent has the same powers and the same approvals as in the terminal; the answers are scrubbed of secrets as everywhere else.
- Telegram can read what the bot sends (it is not end-to-end encrypted). Do not ask the agent to print secrets, and do not use it for confidential code if that matters to you.

## What was verified

The bridge is tested against a fake Telegram and a fake agent: pairing, strangers ignored, expiry and lock-out, approvals only from the paired chat, long answers split, the token kept out of errors. **It has not been run against the real Telegram service yet.** Discord and others are not built; see [HERMES-COMPARISON.md](HERMES-COMPARISON.md).
