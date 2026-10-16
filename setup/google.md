# Google Health connector — setup walkthrough

End-to-end, in the order that worked. Replace `agent-connectors.kolodkin.deno.net`
with your own app URL throughout.

## 1. Deno Deploy

1. Sign in at <https://console.deno.com> with GitHub; create an organization (free plan).
2. Install the Deno Deploy GitHub app on the repo:
   <https://github.com/apps/deno-deploy/installations/new> → *Only select repositories* → `agent-connectors`.
3. In your org: **+ New App** → pick the repo. Deno reads `deno.json` and auto-fills:
   *No Preset*, entrypoint `src/main.ts`, no install/build command. Leave root directory `/`.
4. Note the production URL shown under *Routing details*, e.g. `https://agent-connectors.kolodkin.deno.net`.
5. **Create App**. The first deploy fails with
   `Missing required env vars: GOOGLE_CLIENT_ID, ...` — expected, the app refuses to start unconfigured.
6. **Databases** tab → *Attach database* → Deno KV → *Create new*, assign to *Production*.
   Without it the app dies with `Deno.openKv() failed: no KV database is attached`.

## 2. Google Cloud project

1. <https://console.cloud.google.com/apis/credentials> → *Select a project* → **Create project**,
   name it `agent-connectors`. (A plain Gmail account cannot use *Internal* audience; *External*
   + *Testing* + test-user list is the "me only" equivalent.)
2. Enable the API: <https://console.cloud.google.com/apis/library/health.googleapis.com> → **Enable**.
   Skipping this gives `Enable the Google Health API for that project` on the first tool call.
3. Consent screen (*Configure consent screen*):
   - App name `agent-connectors`, user support email = your Gmail (the dropdown only offers your own
     account or a Google Group; a no-reply address is not possible).
   - Audience *External*. Contact email = your Gmail. Create.
4. **Audience** → *Test users* → add your Gmail. Skipping this gives
   `Access blocked: ... has not completed the Google verification process` (403 `access_denied`).
5. **Data access** → *Add or remove scopes*: tick `openid`, `.../auth/userinfo.email`, then paste under
   *Manually add scopes*:

   ```
   https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
   https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
   https://www.googleapis.com/auth/googlehealth.sleep.readonly
   https://www.googleapis.com/auth/googlehealth.nutrition.readonly
   ```

6. **Clients** → *Create OAuth client* → *Web application*, name `agent-connectors`.
   Leave *Authorized JavaScript origins* empty (it rejects paths). Under **Authorized redirect URIs** add:

   ```
   https://agent-connectors.kolodkin.deno.net/oauth/google/callback
   ```

   Create, then copy the Client ID and Client secret (secret is shown once; *Add secret* makes a new one).

## 3. Environment variables

Deno app → **Settings** → *Environment Variables*, context *All* or *Production*:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 2.6 |
| `GOOGLE_CLIENT_SECRET` | from step 2.6, mark as secret |
| `ALLOWED_EMAIL` | your Gmail |
| `BASE_URL` | `https://agent-connectors.kolodkin.deno.net` |
| `TZ` | IANA zone, e.g. `Asia/Jerusalem` |

Then **Deployments** → latest → **Redeploy**. Verify:

- `https://agent-connectors.kolodkin.deno.net/` → `agent-connectors MCP server. Connector URL: .../mcp`
- `https://agent-connectors.kolodkin.deno.net/mcp` in a browser → `Method not allowed` (GET is rejected; chat apps POST).

## 4. Add the connector

**Claude:** <https://claude.ai/settings/connectors> → *Add custom connector*, URL
`https://agent-connectors.kolodkin.deno.net/mcp`. Keep the detected defaults: authentication
*Sign in now*, OAuth client *Register automatically*. Add → Connect → **Approve** on the
server's *Allow access?* page → Google sign-in with your Gmail → allow the health scopes.

**ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode → *Create*, same URL, OAuth.

Test in a new chat: *"What was my daily health summary yesterday?"*

## Ongoing

While the Google app is in *Testing*, Google expires the refresh token after 7 days; the chat
app will prompt you to reconnect. See the README's *How it connects* section for the auth diagram.
