# Signing in to remote MCP connectors (OAuth)

**English** · [العربية](ar/OAUTH.md)

Some connectors no longer ask you to copy a token. You press **Sign in**, approve access in your browser, and VARA keeps the result in its encrypted vault. This page says what VARA does, **what you must do yourself**, and — honestly — what has *not* been tried against the real services.

> **Status: implemented and tested against a fake server only.** The whole flow (discovery, dynamic registration, PKCE, refresh, revoke, the paste fallback, the address checks) runs in `tests/oauth.test.ts` against a local fake authorization server. **It has not been run against GitHub, Notion, Sentry or Supabase.** Expect to meet a surprise or two on first contact; the section [If it does not work](#if-it-does-not-work) lists the likely ones.

## The connectors

| Connector id | Service | Server | Registration |
| --- | --- | --- | --- |
| `notion-remote` | Notion | `https://mcp.notion.com/mcp` | automatic (expected) |
| `sentry-remote` | Sentry | `https://mcp.sentry.dev/mcp` | automatic (expected) |
| `supabase-remote` | Supabase | `https://mcp.supabase.com/mcp` | automatic (expected) |
| `github-remote` | GitHub | `https://api.githubcopilot.com/mcp/` | **you create an OAuth app once** (below) |

The endpoints come from each service's own MCP documentation; "expected" means the service documents dynamic client registration, not that VARA has seen it work. The older token connectors (`github`, `notion`, `sentry`, `supabase`) are unchanged and still work with a pasted token — they are the fallback if a sign-in will not work.

## Signing in

**In the browser interface** (Settings → Connectors): press **Sign in** next to the connector, then **Open the sign-in page**, approve access, and the dialog closes by itself. The connector is added and connects.

**In the terminal:**

```bash
vara connectors login notion-remote
```

VARA prints the address and tries to open it. Approve access; when the page says you are signed in, VARA finishes.

**Sign out** (Settings → Connectors → Sign out, or `vara connectors logout <id>`): VARA asks the service to revoke the token when the service offers that, then deletes everything it stored. Removing the connector does the same. If the service has no revocation endpoint VARA says so — then also remove VARA in that service's own settings ("authorized apps").

### When the browser is on another computer (a VPS)

Approving ends with the service sending your browser to `http://127.0.0.1:<port>/callback?code=…`. If VARA runs on a server and your browser is on your laptop, that address points at your laptop, so the page will not load. **That is expected.** Do this:

1. On the server: `vara connectors login notion-remote --no-open` (or press Sign in in the web UI).
2. Open the printed address on your laptop and approve.
3. The browser shows an error page. **Copy the whole address from the address bar** (it starts with `http://127.0.0.1:…/callback?code=…&state=…`).
4. Paste it into the terminal prompt, or into **Browser on another computer?** in the web dialog, and press **Finish sign-in**.

The address contains a one-time code, valid once, for this sign-in only; VARA checks the `state` inside it and refuses anything else. Alternative: forward the port so the redirect lands on the server by itself — `vara connectors login <id> --port 8765` on the server and `ssh -L 8765:127.0.0.1:8765 you@server` on your laptop, then approve normally.

## What YOU must do yourself

### Notion, Sentry, Supabase (automatic registration expected)

1. Run `vara connectors login <id>` (or press Sign in).
2. In the page that opens, **sign in to the service** and pick the workspace / organisation / project it asks about. Read the permissions it lists — that is the access the agent will have.
3. Done. Nothing to register, nothing to paste.

If VARA answers *"this server does not offer automatic app registration"* (or the registration is refused), the service wants you to create an app. Then:

1. In the service's dashboard create an **OAuth app / integration** (Notion: *Settings → Connections → Develop or manage integrations*, a **public** integration; Sentry: *Settings → Developer Settings → Custom Integrations / OAuth*; Supabase: *Organisation → OAuth Apps*). Names of those screens change; look for "OAuth".
2. **Redirect / callback URL:** `http://127.0.0.1:8765/callback` (and always sign in with `--port 8765`, because the address must match exactly).
3. Copy the **client id** (and **client secret** if the service shows one) and store them — the values are asked for without echo:

```bash
vara secret set OAUTH_CLIENT_ID_NOTION_REMOTE
vara secret set OAUTH_CLIENT_SECRET_NOTION_REMOTE      # only if the service gave you a secret
vara connectors login notion-remote --port 8765
```

The names are always `OAUTH_CLIENT_ID_<ID>` and `OAUTH_CLIENT_SECRET_<ID>`, with the connector id in capitals and `-` turned into `_` (`sentry-remote` → `OAUTH_CLIENT_ID_SENTRY_REMOTE`). Without the secret VARA signs in as a public client with PKCE.

### GitHub (you create the OAuth app first)

GitHub's remote server is not expected to register apps automatically, so once, on github.com:

1. **Settings → Developer settings → OAuth Apps → New OAuth App.**
2. *Application name:* `VARA`. *Homepage URL:* any address you own, e.g. `https://github.com/VARA-TEAM/vara-cli`.
3. **Authorization callback URL:** `http://127.0.0.1:8765/callback`
4. Register the application, then **Generate a new client secret**. Copy it now — GitHub shows it once.
5. Store both:

```bash
vara secret set OAUTH_CLIENT_ID_GITHUB_REMOTE
vara secret set OAUTH_CLIENT_SECRET_GITHUB_REMOTE
```

6. Sign in with the fixed port: `vara connectors login github-remote --port 8765`. (GitHub's documentation says a loopback address may use any port, so a random port may work too; the fixed one is the safe choice. In the web UI the port is random — use the terminal command for GitHub the first time.)
7. **Scopes:** you do not enter scopes when creating the app. VARA asks for `repo read:user` when you sign in; the GitHub approval page lists them. `repo` includes write access to private repositories — if that is more than you want, use the `github` connector with a **fine-grained personal access token** (choose exactly which repositories and permissions), which is the narrower option.

Whether GitHub's remote MCP server accepts a classic OAuth App token is **not verified here**. If the sign-in completes but the connector shows an authorisation error, that is the likely cause: use the token connector instead.

## What VARA does and keeps

- **Discovery:** it asks the MCP server for its protected-resource metadata (the `WWW-Authenticate` hint, then the well-known addresses), then the authorization server's metadata, and checks that the server names itself as the issuer it was reached through.
- **Registration:** with the vault's `OAUTH_CLIENT_ID_<ID>` if you set it; otherwise dynamic client registration (RFC 7591) when the server offers it; otherwise it stops with the instructions above.
- **The exchange:** authorization code + PKCE (S256), the `resource` parameter, a random `state` that must come back unchanged, the issuer (`iss`) checked when sent. A local listener on `127.0.0.1` (random port, or `--port`) catches the redirect and shuts itself down; the code is used once; the attempt expires after 5 minutes.
- **Tokens:** access and refresh tokens and any client secret are stored **only in the encrypted vault** (one secret named `OAUTH_TOKENS_<ID>`) and registered with the redactor, so they cannot appear in transcripts, logs or tool output. They are never returned by any API, never shown in the browser interface, never given to the agent. Listing connectors shows only *signed in / not*, whether a refresh is possible, and when the access token expires.
- **Refresh:** a token about to expire (inside one minute) is refreshed before the request, one refresh shared by concurrent requests; a `401` triggers one refresh and one retry. A revoked refresh token ends in a plain "sign in again" message.
- **Owner only:** starting, finishing and ending a sign-in are owner endpoints (`/api/manage/connectors/:id/login|logout`); guests and the agent cannot. The agent's `connector_manage` tool refuses to add a sign-in connector that is not signed in.
- **Addresses:** every address VARA contacts for this — the server, its metadata, the endpoints the metadata names, every redirect — must be `https` (plain `http` only on loopback, and only when the MCP server itself is on loopback, i.e. a local test server). Private-network, link-local, carrier-grade NAT and cloud-metadata addresses and addresses with a user name are refused, with the same rules as the browser tool's origin policy. **Limit:** the check is on the address as written; a public *name* that secretly resolves to a private address is not caught (no DNS pinning).

## If it does not work

| You see | Likely cause | What to do |
| --- | --- | --- |
| *does not offer automatic app registration* | The service wants a registered app | The "create an app" steps above |
| *the server refused to register VARA* | Dynamic registration refused or restricted | Same |
| *redirect_uri mismatch* / *invalid redirect* on the service's page | The app's callback URL differs | Use `--port 8765` and the exact URL `http://127.0.0.1:8765/callback` |
| The page after approving does not load | Browser on another computer | Paste the address, [above](#when-the-browser-is-on-another-computer-a-vps) |
| *the sign-in was not completed within 5 minutes* | Too slow | Start again |
| Signed in, but the connector says 401 / forbidden | The service wants other scopes or a different kind of app | Check the service's MCP documentation; fall back to the token connector |
| *sign in again* after some time | The refresh token was revoked or expired | `vara connectors login <id>` |

## Not done

- No device-code flow (the loopback redirect plus the paste fallback covers a headless server).
- No automatic re-authorisation for extra scopes after a `403`.
- No sign-in for stdio (npx) servers — those take tokens through the vault as before.
- Linear, Slack, Google and other OAuth services are not in the catalogue; a connector is added only after its endpoint has been read in its own documentation. Signing in works for catalogue connectors only; a custom MCP server entry cannot start an OAuth sign-in yet.
- The four sign-in connectors above have **not been signed in to against the real services** in this build.
