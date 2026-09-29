# Google Health MCP Connector — Design

Date: 2026-09-29
Status: Draft for review

## Goal

Let a chat assistant (ChatGPT first; Claude works with the same server) read the
owner's personal health data from the **Google Health app** (formerly Fitbit app)
through a **custom connector**. A connector is a **remote MCP server** reachable over
HTTPS, so this project is a Deno MCP server.

This is the first connector in the repo. LinkedIn follows later as a second data
source on the same server (see "Future work").

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Connector shape | Remote MCP server, Streamable HTTP, `POST /mcp` | What ChatGPT and Claude custom connectors consume |
| Runtime / hosting | Deno + Deno Deploy, state in Deno KV | Public HTTPS URL, built-in KV, no infra |
| MCP library | Official `@modelcontextprotocol/sdk` (npm, via Deno) | Maintained, spec-compliant transport |
| Health API | Google Health API `https://health.googleapis.com/v4` | Google Fit REST is shut down end of 2026; Fitbit Web API sunsets Sept 2026; Health Connect has no cloud API |
| Users | Single user (the owner) | Personal tool; avoids Google restricted-scope verification |
| Tool style | Few generic tools, not one tool per data type | Small context footprint, covers all ~30 types |
| Access | Read-only | Write is not available to third parties and not needed |

## Architecture

```
ChatGPT / Claude
   │  MCP over Streamable HTTP (POST /mcp, Bearer token)
   │  OAuth 2.1: metadata discovery, dynamic client registration, PKCE
   ▼
Deno server (Deno Deploy)
   ├─ src/auth/                  OAuth 2.1 authorization server for the chat client
   ├─ src/google/                Google OAuth client (login + token refresh)
   ├─ src/sources/google-health/ Health API client + MCP tool definitions
   ├─ src/mcp.ts                 MCP server wiring (registers tools from sources)
   ├─ src/main.ts                HTTP router, Deno.serve
   └─ Deno KV                    Google tokens, registered clients, codes, access tokens
```

### Unit responsibilities

- **`google/`** — Google OAuth only. Builds the authorize URL
  (`accounts.google.com/o/oauth2/v2/auth`, `access_type=offline`), exchanges codes at
  `oauth2.googleapis.com/token`, reads the email from the ID token, stores the refresh
  token in KV, and exposes `getAccessToken(): Promise<string>` that refreshes when
  needed. It knows nothing about health data. Scopes are passed in by the caller.
- **`auth/`** — Our authorization server for the chat client. Delegates the
  user-login step to `google/`. Knows nothing about health data.
- **`sources/google-health/`** — HTTP client for the Health API, plus tool
  definitions. Gets tokens only through `google.getAccessToken()`. Exports
  `registerTools(server)` and `SCOPES` (the Google scopes it needs).
- **`mcp.ts`** — Creates the MCP server, calls each source's `registerTools`.
- **`main.ts`** — Routes HTTP requests, checks Bearer tokens on `/mcp`.

## Authentication

Two OAuth relationships, one user-visible login.

### Chat client → our server (we are the authorization server)

Endpoints:

- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata pointing to us.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
- `POST /register` — RFC 7591 dynamic client registration (stores client in KV).
- `GET /authorize` — validates client, `redirect_uri`, PKCE `code_challenge` (S256
  only); stores the pending request in KV under a random `state`; redirects to Google.
- `GET /oauth/google/callback` — completes the Google step (below), then issues our
  authorization code and redirects to the chat client's `redirect_uri`.
- `POST /token` — `authorization_code` (with PKCE verifier) and `refresh_token` grants.
  Issues opaque random tokens stored hashed in KV. Access token TTL 1 hour; refresh
  token TTL 30 days.

`/mcp` without a valid token returns `401` with
`WWW-Authenticate: Bearer resource_metadata="<BASE_URL>/.well-known/oauth-protected-resource"`.

### Our server → Google

At `/authorize` we redirect to Google requesting
`openid email` + `SCOPES` from `sources/google-health`:

- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.nutrition.readonly` (needed for `hydration-log`)

Do not send `include_granted_scopes=true` (known to cause 403s). Send
`prompt=consent` only when no Google refresh token is stored yet.

On callback: exchange the code, verify the ID token's `email` equals `ALLOWED_EMAIL`
and `email_verified` is true. Otherwise return 403 and store nothing. On success,
store the Google refresh token in KV (overwriting any previous one).

### Google testing-mode limitation

The Google Cloud OAuth app stays in "Testing" with the owner as the only test user.
Google expires refresh tokens after 7 days in that mode. When refresh fails with
`invalid_grant`, the server deletes the stored Google token and **revokes all of our
issued tokens**, so the chat client's next call gets `401` and it prompts a reconnect.

## MCP tools

All tools are read-only and set the `readOnlyHint: true` annotation.

### `list_data_types`

No input. Returns the hard-coded catalogue (the API has no discovery endpoint):
for each type — `id` (e.g. `steps`), `kind` (`interval` | `sample` | `daily` |
`session`), `category` (`activity` | `body` | `heart` | `sleep` | `logs`), and
supported modes. Types that only support rollups (e.g. `floors`, `total-calories`,
`active-minutes`) are marked so.

### `get_health_data`

Input:

- `type` (string, must be in the catalogue)
- `from`, `to` — ISO date (`2026-09-01`) or datetime. Dates are interpreted in the
  `TZ` env var's timezone; `to` as a date is inclusive (end of that day).
- `mode` — `auto` (default) | `raw` | `merged` | `daily` | `total`
  - `raw` → `dataPoints:list` (per-source provenance)
  - `merged` → `dataPoints:reconcile` (deduplicated across devices)
  - `daily` → `dataPoints:dailyRollUp`
  - `total` → `dataPoints:rollUp` over the whole range
  - `auto` → `daily` for interval types when the range exceeds 2 days (or the type is
    rollup-only); otherwise `merged`
- `pageToken` (optional)

Behaviour:

- Builds the filter on civil (local) time, with the type id in snake_case: intervals and
  sessions `{type}.interval.civil_start_time`, sleep `sleep.interval.civil_end_time`,
  samples `{type}.sample_time.civil_time`, daily types `{type}.date`. Only `total`
  (`rollUp`, which takes UTC timestamps) converts local time with `TZ`.
- Returns `{ type, mode, from, to, points: [...], nextPageToken? }`, where points
  are trimmed to the useful fields (time/interval/date + value(s) + unit; source only
  in `raw` mode).
- Caps output at 500 points per call; if more exist, returns `nextPageToken`.
- Rejects unsupported `type`/`mode` combinations with a message listing valid modes.

### `get_daily_summary`

Input: `date` (ISO date, default today in `TZ`).

Queries in parallel: steps, distance, exercise, sleep (the night ending on `date`),
daily resting heart rate, daily HRV, weight (latest sample that day), hydration log.
Returns `{ date, summary: { ...one compact value per metric }, missing: [types with
no data] }`. A failure of one metric goes into `errors` rather than failing the call.

## Errors

| Situation | Behaviour |
|---|---|
| Google refresh `invalid_grant` | Wipe tokens (see above); tool returns "Google access expired — reconnect the connector" |
| Google 403 | Tool error naming the type and the scope it needs |
| Google 429 / 5xx | One retry after 1 s, then tool error with status |
| Empty result | Normal result with empty `points` and a `note` |
| Invalid input | Tool error from schema validation (zod) |

Tool errors use MCP `isError: true` results, not protocol errors.

## Configuration

Environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`,
`BASE_URL` (public origin, used for metadata and the Google redirect URI),
`TZ` (IANA timezone, default `UTC`). Missing required vars fail at startup.

Owner's one-time setup (documented in README): create Google Cloud project, enable
the Google Health API, configure OAuth consent screen (Testing, self as test user),
create a Web OAuth client with redirect `<BASE_URL>/oauth/google/callback`, deploy
to Deno Deploy with the env vars, add `<BASE_URL>/mcp` as a connector in ChatGPT
(developer mode) or Claude.

## Testing

Deno's built-in test runner (`deno test`), no network in tests.

- **Unit:** filter building per kind, `auto` mode selection, date/timezone
  conversion, response trimming, catalogue validation — with recorded JSON fixtures.
- **Auth:** full flow against a fake Google token endpoint — register, authorize,
  callback, token exchange with PKCE, refresh; allowlist rejects a different email;
  `invalid_grant` wipes tokens and `/mcp` returns 401.
- **MCP integration:** start the app handler in-process with in-memory KV
  (`Deno.openKv(":memory:")`) and a stubbed Health API `fetch`; run
  `initialize` → `tools/list` → `tools/call` for each tool.
- **Manual smoke test after deploy:** MCP Inspector, then ChatGPT developer mode.

## Out of scope (v1)

Writing data, webhooks, caching, multi-user support, Google app verification,
nutrition and ECG data, LinkedIn.

## Future work

- **LinkedIn source** (`src/sources/linkedin/`): the owner appears to be outside the
  EU, so the live Member Data Portability API is likely unavailable; plan is to import
  the "Download your data" export. To be confirmed via the LinkedIn Developer Portal
  Products tab. It registers its own tools; `auth/` and `mcp.ts` are unchanged.
