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

1. **Google Cloud project** — at console.cloud.google.com create a project and enable the **Google Health API**.
2. **OAuth consent screen** — User type *External*, publishing status *Testing*, add your Google account as a **test user**. Add scopes: `openid`, `email`, and `googlehealth.activity_and_fitness.readonly`, `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.sleep.readonly`, `googlehealth.nutrition.readonly`.
3. **Deploy to Deno Deploy** — create a project from this repo with entrypoint `src/main.ts`. Note its URL, e.g. `https://my-health.deno.dev`.
4. **OAuth client** — Credentials → Create OAuth client ID → *Web application*, authorized redirect URI `https://my-health.deno.dev/oauth/google/callback`.
5. **Environment variables** in Deno Deploy:

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | from step 4 |
   | `GOOGLE_CLIENT_SECRET` | from step 4 |
   | `ALLOWED_EMAIL` | your Google account email |
   | `BASE_URL` | `https://my-health.deno.dev` |
   | `TZ` | your IANA timezone, e.g. `Europe/London` (default `UTC`) |

6. **Add the connector** — ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode, then *Create* with URL `https://my-health.deno.dev/mcp` and OAuth authentication. Claude: Settings → Connectors → *Add custom connector* with the same URL. You'll see this server's own *Allow access?* page first — approve only connectors you just added — then sign in with your Google account.

**Weekly re-login:** while the Google app is in *Testing*, Google expires its refresh token after 7 days. The server then asks your chat app to reconnect; sign in again.

## Development

```bash
deno task test    # offline test suite
deno task check   # type-check
deno task dev     # run locally on :8000 (needs the env vars above)
```

Try it with MCP Inspector: `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL `http://localhost:8000/mcp`.
