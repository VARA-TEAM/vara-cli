# Web search — `web_search` and `web_fetch`

**English** · [العربية](ar/WEB-SEARCH.md)

The agent can search the live internet and read pages, so it is not limited to what its model learned in training. **No paid API is needed**: everything runs from *your own computer and IP address*.

## The two tools

| Tool | What it does |
|---|---|
| `web_search` | `query`, optional `max_results` (1–20), `recency` (day / week / month / year), `region` (e.g. `us`, `tn`), `language` (e.g. `en`, `ar`). Returns title, URL and snippet per result. |
| `web_fetch` | Downloads one http(s) page and returns its main text (scripts, menus, footers removed). Long pages are cut at `maxPageChars` (default 12 000 characters ≈ 3 000 tokens) with a `start=` hint to continue. Refuses non-text (no file downloads). Follows at most 5 redirects, re-checking every hop. |

Both are read-only (they work in plan mode and for questions), on by default, and the system prompt tells the agent to search when a fact may be recent and to cite the URLs it used.

## Providers (tried in order, first one that answers wins)

| Provider | Needs | Notes |
|---|---|---|
| `duckduckgo` | nothing | The HTML endpoint, fetched from your machine. Honours recency and region. |
| `mojeek` | nothing | Mojeek's own index, plain HTML. Recency filter not supported. |
| `searxng` | your own SearXNG server in `searxngInstances` | Needs JSON output enabled. Public instances mostly refuse bots, so none is bundled; skipped when the list is empty. |
| `browser` | `agent.browser` on + Chrome/Edge/Chromium | Loads the DuckDuckGo results page in the agent's own isolated browser and reads the links. Use when plain fetch is blocked. |
| `brave`, `tavily`, `serper` | **a key you stored in the vault** | Optional. Never used unless listed in `providers` *and* the key exists (`vara secret set BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`; names editable in `keyNames`). Never in the default order. |

When every provider fails you get one message listing why each failed (offline, bot check, HTTP status), not a silent empty answer.

## Safety

- **Untrusted content.** Results and page text are wrapped in the same `UNTRUSTED_WEB_CONTENT` boundary as the browser tool: data, never instructions.
- **SSRF.** Every request (and every redirect) goes through the browser tool's `OriginPolicy`; loopback, private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, ULA), cloud metadata addresses, `.internal` / `.local` names and the banking/crypto deny-list are refused. DNS is **pinned**: the connection uses the address that passed the check, so a hostname that resolves to a private address is refused at connect time. For local development servers use the `browser` tool.
- **Limits.** 15 s timeout, 1.5 MB download cap, `perMinute` searches (default 20), a small in-memory cache (`cacheMinutes`, default 10).
- **Honest user agent:** `VARA/<version> (+https://github.com/VARA-TEAM/vara-cli; …)`. Sites may block it; VARA does not disguise itself. A page's `robots` meta tag is shown to the model as a hint only.
- **Privacy.** The search words leave your computer for the search site (and your IP is visible to it). Anything that looks like a stored secret is redacted from the query first. API keys are sent only as a header to their own provider and are never shown to the model.
- Proxy environment variables are not used; a machine that can only reach the internet through a proxy will see "offline" errors (use the `browser` provider there).

## Settings

`agent.webSearch` in `~/.vara/config.json` (schema in `src/config/config.ts`): `enabled`, `fetch`, `providers`, `searxngInstances`, `keyNames`, `maxResults`, `maxPageChars`, `cacheMinutes`, `perMinute`. The two switches are in Settings → Agent (browser) and `/settings` (terminal). The provider list and keys are owner-only: the agent cannot change them.

## What was verified

- Tests with a local fake server and recorded HTML (`tests/web-search.test.ts`, no real network).
- `npx tsx scripts/web-search-smoke.ts` hits the real internet. Run on the author's Windows PC on 2026-10-15: **DuckDuckGo worked** (5 results, then `web_fetch` read a real page); **Mojeek answered HTTP 403** (bot protection); public SearXNG instances refused JSON. So today the dependable keyless path is DuckDuckGo, with the browser engine and optional API keys as fallbacks. DuckDuckGo may show a bot check on some networks or under heavy use. Not run: the browser engine against a real Chrome, and the Brave / Tavily / Serper providers against the real services (tested against fakes only).
