# Running VARA anywhere — a PC, a VPS, Docker, a CI box

**English** · [العربية](ar/DEPLOYMENT.md)

`vara serve` runs VARA as a **headless service**: no terminal, no browser on that machine. You open the web interface from wherever you are (phone, laptop) and the agent works on the server's folder. It is the same host as `vara ui`, with the things a service needs: settings from environment variables, an owner token that survives restarts, log lines for journald/Docker, a health endpoint and a clean stop.

> **What you are deploying.** An agent that runs shell commands and edits files **on that machine**. Treat the machine (or the container) as the agent's; give it a folder for the project, not your whole disk, and keep it off the open internet except behind TLS and the owner token.

| Where | How | Files |
| --- | --- | --- |
| Your own PC | `vara serve` | — |
| A Linux VPS | systemd service + a TLS reverse proxy | `deploy/vara.service`, `deploy/vara.env.example`, `deploy/Caddyfile` or `deploy/nginx.conf` |
| Docker | image + compose | `Dockerfile`, `deploy/docker-compose.yml` |
| A CI box | `vara run` (headless, one task) or a short-lived `vara serve` | environment variables below |

## 1. Five minutes on your own machine

```bash
export OPENAI_API_KEY=sk-...          # or run `vara setup` once
vara serve
```

The first start prints a **one-time owner login link**:

```
Owner login — shown ONCE. Open it (or keep the token in a password manager): only its hash is stored, so it cannot be shown again.
  http://127.0.0.1:7777/#token=…
```

Open it. The token travels in the part of the address after `#`, which browsers never send to a server. Stop with `Ctrl+C` (a clean stop: sessions are saved).

## 2. Settings

Flags win over environment variables; both win over the defaults. An **empty** variable counts as not set.

| Flag | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `--port N` | `VARA_PORT` | `7777` | Port (`0` = any free port) |
| `--bind ADDR` | `VARA_BIND` | `127.0.0.1` | Address to listen on. `--lan` = `0.0.0.0` |
| `--public-host NAME` | `VARA_PUBLIC_HOST` | — | The DNS name your proxy serves (no scheme or port). Without it a browser must use an IP address on a private network |
| `--cwd DIR` | `VARA_CWD` | current folder | The folder the agent works in |
| *(none)* | `VARA_HOME` | `~/.vara` | Everything VARA keeps: config, sessions, vault, owner-token hash |
| `--token-file F` | `VARA_OWNER_TOKEN_FILE` | — | Your own owner token, from a file (≥ 24 characters) |
| `--token T` | `VARA_OWNER_TOKEN` | — | Your own owner token as a value (visible in `ps` when a flag: prefer the file) |
| `--rotate-token` | — | — | Replace the generated token (the old one stops working) |
| `--trust-proxy` | `VARA_TRUST_PROXY=1` | off | Count failed logins per real client behind a reverse proxy (§5) |
| `--log MODE` | `VARA_LOG` | `text` (`journal` under systemd) | `text`, `json` (one object per line) or `journal` (syslog priority prefixes) |
| — | `VARA_NO_UPDATE_CHECK=1` | — | No daily "update available" request |
| — | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … | — | The model key (the variable your provider uses). Or store it in the vault: `vara secret set NAME` |

A start that cannot work stops with the reason (no model key, port in use, a token that is too short) instead of running half-configured.

## 3. The owner token

| You do | What happens |
| --- | --- |
| Nothing | First start: VARA makes a random 256-bit token, prints the login link **once**, and stores **only its SHA-256** in `$VARA_HOME/host/owner-token.sha256` (mode `0600`). Later starts keep accepting it and print nothing. |
| `--rotate-token` | A new token, shown once. The old one stops working immediately. This is also how you recover a lost token. |
| `--token-file` / `VARA_OWNER_TOKEN_FILE` | Your token, read at start. Never written anywhere by VARA, never printed. A file readable by other users gets a warning (`chmod 600`). |

Guests are unaffected: invites and powers work as in the rest of the docs (`vara invite`, `vara guests`).

## 4. Safe defaults

- Listens on **127.0.0.1** unless you say otherwise.
- A host always has an owner token; there is no "no token" mode.
- Any non-loopback bind prints a **warning** at start: it is plain HTTP, put TLS in front (§5).
- A domain name in the `Host` header is refused unless it is `--public-host` (defence against DNS rebinding); on a private network only private IP addresses are accepted.
- Login attempts are rate-limited (10 failures per 5 minutes per address).
- The log never contains request URLs or message text — only start/stop lines and internal-error messages. The single exception is the one-time owner link printed on the first start (§3); a token you provide yourself is never printed.
- Secrets live in the encrypted vault (`vara secret set`); the agent itself can never read a key, a token or the vault.

## 5. Behind a reverse proxy (TLS)

Bind VARA to `127.0.0.1`, let the proxy terminate TLS, and tell VARA its public name:

```bash
VARA_BIND=127.0.0.1 VARA_PUBLIC_HOST=vara.example.com VARA_TRUST_PROXY=1 vara serve
```

What the proxy **must** do (both example files do it):

1. **Pass the `Host` header unchanged** (`proxy_set_header Host $host`). VARA compares it with `VARA_PUBLIC_HOST`.
2. **Not buffer** the live stream. The conversation arrives over Server-Sent Events; a buffering proxy makes it stall. VARA already sends `X-Accel-Buffering: no`; also set `proxy_buffering off` (nginx) / `flush_interval -1` (Caddy), and no read timeout on quiet streams.
3. **Allow WebSocket upgrades** (the live preview relays websockets).
4. **Overwrite `X-Forwarded-For`** with the address it saw. With `VARA_TRUST_PROXY=1` VARA uses the *last* entry for the login limit. Without that flag every visitor looks like the proxy, so a stranger's failed logins could lock you out. Only turn the flag on when the proxy is the only way in (bind `127.0.0.1`, or a firewall): otherwise anyone can forge the header.

Files: [`deploy/Caddyfile`](../deploy/Caddyfile) (automatic HTTPS, shortest) and [`deploy/nginx.conf`](../deploy/nginx.conf) (with the `map` it needs for the upgrade header).

## 6. A Linux VPS with systemd

```bash
sudo useradd --system --create-home --home-dir /var/lib/vara --shell /usr/sbin/nologin vara
sudo install -d -o vara -g vara -m 0750 /var/lib/vara/workspace
sudo cp deploy/vara.service /etc/systemd/system/vara.service
sudo install -d -m 0750 -o root -g vara /etc/vara
sudo cp deploy/vara.env.example /etc/vara/vara.env && sudo chmod 640 /etc/vara/vara.env
sudo editor /etc/vara/vara.env        # the model key, VARA_PUBLIC_HOST, VARA_TRUST_PROXY=1
sudo systemctl daemon-reload && sudo systemctl enable --now vara
journalctl -u vara -n 30              # the one-time owner login link is here
```

Edit `ExecStart` if `vara` is not at `/usr/local/bin/vara`. The unit runs as an unprivileged user with `ProtectSystem=strict`, `NoNewPrivileges`, a private `/tmp`, no home access and **only `/var/lib/vara` writable**: add the project folders the agent must change to `ReadWritePaths=`. `systemctl stop vara` sends SIGTERM: sessions are saved and connections closed (up to 30 s before SIGKILL). Log lines carry `<6>`/`<4>`/`<3>` priorities, so `journalctl -p warning -u vara` shows only what matters.

The one-time link is in the journal; to keep it out, use `VARA_OWNER_TOKEN_FILE` with a token you generated (`openssl rand -base64 32 | sudo tee /etc/vara/owner-token`, `chmod 640`, group `vara`).

## 7. Docker

```bash
cp deploy/vara.env.example deploy/.env        # set OPENAI_API_KEY (or another provider's variable), VARA_PUBLIC_HOST…
mkdir -p deploy/workspace && sudo chown 1000:1000 deploy/workspace
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs vara        # the one-time owner link (JSON log lines)
```

The image runs as the non-root `node` user, keeps all state in the `/data` volume (`VARA_HOME`) and works on `/workspace`; the compose file publishes the port on **127.0.0.1 only**, drops all capabilities, makes the root filesystem read-only and adds `no-new-privileges`. The image has a **healthcheck** (`GET /api/health`), so `docker ps` shows `healthy`. Inside a container the host must listen on `0.0.0.0` (the image sets it); that is safe only because the published port is loopback-only or behind your proxy.

Useful: `docker exec -it vara node dist/cli.js secret set OPENAI_API_KEY` (store a key in the vault), `docker exec -it vara node dist/cli.js doctor --server`.

## 8. A CI box

Two shapes:

- **One task, then exit** — no server at all: `OPENAI_API_KEY=… VARA_HOME=$RUNNER_TEMP/vara vara run "fix the failing test" --verify "npm test"` (see `vara --help`). Set `VARA_NO_UPDATE_CHECK=1`.
- **A short-lived host** for a review session: `vara serve --port 0 --cwd "$PWD" --token-file …` and open it through your tunnel; stop it with SIGTERM.

Use a throw-away `VARA_HOME`, a scoped API key, and never share a CI machine's host publicly.

## 9. A Windows PC that stays on

`vara serve` runs the same way. To start it at login, create a Task Scheduler task ("run whether the user is logged on or not" is **not** needed; run it as yourself, action `vara serve`, trigger "At log on"). The vault's key is protected by your Windows account (DPAPI), so it must run as that account. A service wrapper such as NSSM works too; it was not tested here.

## 10. Check before you leave it running

```bash
vara doctor --server
```

It checks: settings parse, the data folder is writable, the work folder exists, the port is free (or who holds it), how exposed the host is, the owner token setup, the model key, the web interface, and — when `--public-host` is set — that `https://<your-name>/api/health` really answers through your proxy. In a container it also catches the classic mistake (listening on `127.0.0.1` inside the container). Exit code 1 means something required is wrong.

## 11. Upgrades, backups, stopping

- **Backup:** copy `VARA_HOME` while the host is stopped. On Linux the vault's key is a `0600` file *inside* it, so one copy restores everything; on Windows/macOS the key is bound to the user account and does not move to another machine (re-enter the secrets there).
- **Upgrade:** packaged install: `vara update` then restart the service. Docker: `git pull && docker compose … up -d --build`. The data volume is kept.
- **Stop:** `SIGTERM`/`SIGINT` (systemd, `docker stop`, `Ctrl+C`): running agents are paused and saved, the public link is closed, connections are dropped. A second signal exits at once. A step that hangs is abandoned after 8 s and the exit code is 1.

## 12. What was verified, and what was not

Tested in this repository (`tests/daemon.test.ts`, `tests/system-privacy.test.ts`): flag/environment parsing and every refusal above, the owner-token life cycle (generate, persist as a digest, restart, rotate, provided file), log formats, the ordered/idempotent shutdown, the doctor's logic, the proxy-aware login limit, and a real `serveCommand` start → `/api/health` → owner login → restart → stop in one process.

**Not run here — no Docker, systemd, nginx or Caddy on the build machine:** the `Dockerfile` build and its healthcheck, `docker-compose.yml`, `vara.service` (`systemd-analyze verify` is the first thing to run), and both proxy configurations were written carefully and reviewed, but never executed. The Windows scheduled task and NSSM are untested. Try each on a throw-away machine first and report what breaks.
