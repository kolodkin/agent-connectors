# agent-connectors

Personal chat connectors (remote MCP servers) built with Deno. The first one lets
ChatGPT or Claude read your data from the Google Health app.

## Tools

| Tool | What it does |
|---|---|
| `list_data_types` | Readable data types, grouped by category, with supported modes |
| `get_health_data` | One type over a date range (`raw`, `merged`, `daily`, `total`, or `auto`) |
| `get_daily_summary` | Steps, distance, exercise, sleep, resting HR, HRV, weight, hydration for a day |

## One-time setup

Follow [setup/google.md](setup/google.md): Deno Deploy app + KV, Google Cloud project
(Health API, consent screen, test user, scopes, OAuth client), then these env vars in Deno Deploy:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from the Google OAuth client |
| `GOOGLE_CLIENT_SECRET` | from the Google OAuth client |
| `ALLOWED_EMAIL` | your Google account email |
| `BASE_URL` | your app URL, e.g. `https://my-health.kolodkin.deno.net` |
| `TZ` | your IANA timezone, e.g. `Asia/Jerusalem` (default `UTC`) |

Connector URL for Claude or ChatGPT: `<BASE_URL>/mcp`. You'll see this server's own *Allow access?* page
first — approve only connectors you just added — then sign in with your Google account.

**Weekly re-login:** while the Google app is in *Testing*, Google expires its refresh token after 7 days.
The server then asks your chat app to reconnect; sign in again.

## How it connects

```mermaid
flowchart LR
    Chat["Chat app<br/>(Claude / ChatGPT)"]
    Server["agent-connectors<br/>Deno Deploy + KV"]
    Google["Google<br/>OAuth + Health API"]

    Chat -- "MCP over HTTPS<br/>Bearer: server token" --> Server
    Server -- "Bearer: Google token" --> Google
```

Two independent OAuth flows. The chat app only ever holds tokens issued by this
server; Google tokens never leave the server's KV store.

```mermaid
sequenceDiagram
    autonumber
    actor Owner as You (browser)
    participant Chat as Chat app
    participant Server as agent-connectors
    participant Google

    Note over Chat,Server: Flow 1 — chat app ↔ server (server is the OAuth provider)
    Chat->>Server: POST /register (dynamic client registration)
    Chat->>Owner: open /authorize?client_id&code_challenge (PKCE)
    Owner->>Server: GET /authorize
    Server-->>Owner: "Allow access?" page (CSRF cookie)
    Owner->>Server: POST /authorize decision=approve
    Server-->>Owner: 302 → Google sign-in

    Note over Owner,Google: Flow 2 — server ↔ Google (server is the OAuth client)
    Owner->>Google: sign in, grant Health scopes
    Google-->>Server: GET /oauth/google/callback?code
    Server->>Google: exchange code → access + refresh token + id_token
    Server->>Server: email == ALLOWED_EMAIL? else 403
    Server->>Server: save Google tokens in KV

    Server-->>Chat: 302 → redirect_uri?code (server's own code)
    Chat->>Server: POST /token (code + PKCE verifier)
    Server-->>Chat: access token (1h) + refresh token (30d)

    Note over Chat,Google: Every request afterwards
    Chat->>Server: POST /mcp, Authorization: Bearer <server token>
    Server->>Google: Health API, Authorization: Bearer <Google token>
    Google-->>Server: data
    Server-->>Chat: tool result
```

What stops a stranger: `/mcp` needs a server token; a server token is issued only
after you click *Approve* **and** sign in to Google as `ALLOWED_EMAIL`; Google's
*Testing* mode additionally rejects any account not on the test-user list.

## Development

```bash
deno task test    # offline test suite
deno task check   # type-check
deno task dev     # run locally on :8000 (needs the env vars above)
```

Try it with MCP Inspector: `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL `http://localhost:8000/mcp`.
