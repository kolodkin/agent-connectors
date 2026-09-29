# Google Health MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user Deno remote MCP server that lets ChatGPT/Claude read the owner's Google Health data through three read-only tools.

**Architecture:** One `Deno.serve` handler routes OAuth 2.1 endpoints (we are the authorization server for the chat client, delegating login to Google) and a stateless Streamable-HTTP `/mcp` endpoint. `google/` owns Google OAuth and token refresh; `sources/google-health/` owns the Health API client and tool definitions. All state lives in Deno KV. Every external dependency (`fetch`, clock, sleep, KV) is injected through a `Ctx` object so tests run offline.

**Tech Stack:** Deno 2.x, `npm:@modelcontextprotocol/sdk@1.31.0`, `npm:zod@^4`, `jsr:@std/assert@^1`, Deno KV, Google Health API v4.

**Spec:** `docs/superpowers/specs/2026-09-29-google-health-mcp-connector-design.md`

## Global Constraints

- Runtime: Deno 2.x. If `deno` is missing: `npm i -g deno` (or `curl -fsSL https://deno.land/install.sh | sh`).
- MCP SDK pinned to `1.31.0`. Import it **only** through `src/sdk.ts` (see Task 1 — the SDK's `./*` export maps types to `*.js.d.ts`, which breaks type-checking unless each import carries a `@ts-types` directive).
- Transport: Streamable HTTP at `POST /mcp`, stateless (`sessionIdGenerator: undefined`, `enableJsonResponse: true`).
- Health API base: `https://health.googleapis.com`, paths `/v4/users/me/dataTypes/{kebab-id}/dataPoints[...]`. In filters the type id is **snake_case** (`body_fat`), in URLs **kebab-case** (`body-fat`).
- Google OAuth: authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, `access_type=offline`, never `include_granted_scopes`, `prompt=consent` only when no Google refresh token is stored.
- Our tokens: opaque, stored as SHA-256 hashes; access TTL 1 h, refresh TTL 30 days, refresh tokens rotate; auth codes single-use, 5 min.
- PKCE: `S256` only. Public clients only (`token_endpoint_auth_method: "none"`).
- Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`, `BASE_URL`, `TZ` (default `UTC`).
- All tools read-only with `annotations: { readOnlyHint: true }`; tool failures are `isError: true` results, never protocol errors.
- `get_health_data` returns at most 500 points per call (25 for `exercise`/`sleep`, the API max), plus `nextPageToken`.
- Tests: `deno test -A`, no network. Every task ends with `deno task check` and `deno task test` green.

### Spec deltas (discovered from the API reference while planning)

1. `hydration-log` requires `googlehealth.nutrition.readonly`, so that scope is added (the spec's daily summary includes hydration). Nutrition *logs/food* stay out of the catalogue.
2. `list`/`reconcile` filters accept **civil (local) times**, so no timezone conversion is needed for them. Only `total` mode (`rollUp`, physical timestamps) converts local → UTC with `TZ`.
3. Sleep filters on `sleep.interval.civil_end_time`; other sessions/intervals on `interval.civil_start_time`; samples on `sample_time.civil_time`; daily types on `date`.

The spec file is updated in Task 7 to record these.

## Review Focus

1. **DST day in `total` mode** — a range covering 2026-03-08 in `America/New_York` must span 23 h (`82800s`), not 24 h. Test in Task 5.
2. **Reversed or malformed dates** (`from` after `to`, `2026-02-30`, `09/01/2026`) — a clear tool error, and no Google call. Tests in Tasks 5 and 6.
3. **Authorization-code replay / wrong PKCE verifier** — second use of a code, or a bad verifier, gets `invalid_grant`. Tests in Tasks 3 and 4.
4. **`/authorize` with an unregistered `redirect_uri`** — 400 on our own page, never a redirect (open-redirect). Test in Task 4.
5. **Google re-consent without a `refresh_token`** — keep the stored refresh token instead of losing access. Test in Task 2.

---

## File Structure

```
deno.json                              tasks, imports, unstable kv
.gitignore
README.md                              owner setup + deploy (Task 7)
src/
  sdk.ts                               typed re-exports of the MCP SDK
  config.ts          config_test.ts    env → Config
  ctx.ts                               Ctx interface (config, kv, fetch, now, sleep)
  testing.ts                           test helpers: withCtx, fakeFetch, json, fakeIdToken
  google/oauth.ts    oauth_test.ts     Google OAuth: auth URL, code exchange, token store/refresh
  auth/store.ts      store_test.ts     KV records: clients, pending logins, codes, tokens, PKCE
  auth/routes.ts     routes_test.ts    OAuth HTTP endpoints + requireBearer
  sources/google-health/
    catalog.ts       catalog_test.ts   data types, kinds, modes, scopes
    query.ts         query_test.ts     date ranges, mode choice, filters, request bodies, trimming
    client.ts                          Health API fetch with retry + HealthApiError
    tools.ts         tools_test.ts     getHealthData, getDailySummary, registerTools
  mcp.ts                               MCP server factory + stateless handler
  app.ts             app_test.ts       HTTP router
  main.ts                              Deno.serve entrypoint
```

---

### Task 1: Project scaffold, config, context, test helpers

**Files:**
- Create: `deno.json`, `.gitignore`, `src/sdk.ts`, `src/config.ts`, `src/ctx.ts`, `src/testing.ts`
- Test: `src/config_test.ts`

**Interfaces:**
- Produces:
  - `interface Config { googleClientId: string; googleClientSecret: string; allowedEmail: string; baseUrl: string; tz: string }`
  - `loadConfig(env: (name: string) => string | undefined): Config`
  - `interface Ctx { config: Config; kv: Deno.Kv; fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> }`
  - `src/sdk.ts` exports `McpServer`, `WebStandardStreamableHTTPServerTransport`, `Client`, `StreamableHTTPClientTransport`
  - `src/testing.ts`: `TEST_CONFIG`, `type Route`, `fakeFetch(routes)`, `json(body, status?)`, `fakeIdToken(claims)`, `withCtx(opts, fn)`

- [ ] **Step 1: Create `deno.json` and `.gitignore`**

`deno.json`:
```json
{
  "unstable": ["kv"],
  "nodeModulesDir": "auto",
  "tasks": {
    "dev": "deno run -A --watch src/main.ts",
    "start": "deno run -A src/main.ts",
    "test": "deno test -A",
    "check": "deno check src/"
  },
  "imports": {
    "@modelcontextprotocol/sdk/": "npm:/@modelcontextprotocol/sdk@1.31.0/",
    "zod": "npm:zod@^4",
    "@std/assert": "jsr:@std/assert@^1"
  }
}
```

`.gitignore`:
```
node_modules/
.env
```

- [ ] **Step 2: Create `src/sdk.ts`**

```ts
// The SDK's "./*" export maps types to "*.js.d.ts" (which does not exist), so each
// import needs an explicit @ts-types pointing at the extension-less subpath.
// Import the SDK only through this file.

// @ts-types="@modelcontextprotocol/sdk/server/mcp"
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="@modelcontextprotocol/sdk/server/webStandardStreamableHttp"
export { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// @ts-types="@modelcontextprotocol/sdk/client/index"
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-types="@modelcontextprotocol/sdk/client/streamableHttp"
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

- [ ] **Step 3: Write the failing config test** — `src/config_test.ts`

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const FULL = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "s",
  ALLOWED_EMAIL: "Me@Example.com",
  BASE_URL: "https://x.deno.dev/",
};

Deno.test("loadConfig reads vars, normalizes email and base url, defaults TZ", () => {
  assertEquals(loadConfig(env(FULL)), {
    googleClientId: "id",
    googleClientSecret: "s",
    allowedEmail: "me@example.com",
    baseUrl: "https://x.deno.dev",
    tz: "UTC",
  });
});

Deno.test("loadConfig lists every missing var", () => {
  assertThrows(
    () => loadConfig(env({ BASE_URL: "https://x" })),
    Error,
    "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL",
  );
});

Deno.test("loadConfig rejects an unknown timezone", () => {
  assertThrows(() => loadConfig(env({ ...FULL, TZ: "Mars/Base" })), Error, "Invalid TZ");
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `deno test -A src/config_test.ts`
Expected: FAIL — `Module not found "file:///.../src/config.ts"`

- [ ] **Step 5: Implement `src/config.ts`**

```ts
export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  allowedEmail: string;
  baseUrl: string;
  tz: string;
}

const REQUIRED = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAIL", "BASE_URL"];

export function loadConfig(env: (name: string) => string | undefined): Config {
  const missing = REQUIRED.filter((name) => !env(name));
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  const tz = env("TZ") || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid TZ: ${tz}`);
  }
  return {
    googleClientId: env("GOOGLE_CLIENT_ID")!,
    googleClientSecret: env("GOOGLE_CLIENT_SECRET")!,
    allowedEmail: env("ALLOWED_EMAIL")!.toLowerCase(),
    baseUrl: env("BASE_URL")!.replace(/\/+$/, ""),
    tz,
  };
}
```

- [ ] **Step 6: Create `src/ctx.ts`**

```ts
import type { Config } from "./config.ts";

/** Everything with side effects, injected so tests run offline. */
export interface Ctx {
  config: Config;
  kv: Deno.Kv;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
```

- [ ] **Step 7: Create `src/testing.ts`**

```ts
import type { Config } from "./config.ts";
import type { Ctx } from "./ctx.ts";

export const TEST_CONFIG: Config = {
  googleClientId: "gcid",
  googleClientSecret: "gsecret",
  allowedEmail: "owner@example.com",
  baseUrl: "https://conn.example.com",
  tz: "America/New_York",
};

export type Route = (req: Request) => Response | Promise<Response>;

/** Fake fetch. Routes are keyed "METHOD https://host/path" (query string ignored). */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: Request[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push(req.clone());
    const url = new URL(req.url);
    const key = `${req.method} ${url.origin}${url.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`fakeFetch: no route for ${key}`);
    return await route(req);
  };
  return { fetch: fn as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Unsigned JWT whose payload is `claims` (base64url, no padding). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

/** Runs `fn` with an in-memory KV and fake fetch; `calls` records outgoing requests. */
export async function withCtx(
  opts: { routes?: Record<string, Route>; now?: number; config?: Partial<Config> },
  fn: (ctx: Ctx, calls: Request[]) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const fake = fakeFetch(opts.routes ?? {});
  const now = opts.now ?? Date.parse("2026-09-29T12:00:00Z");
  const ctx: Ctx = {
    config: { ...TEST_CONFIG, ...opts.config },
    kv,
    fetch: fake.fetch,
    now: () => now,
    sleep: () => Promise.resolve(),
  };
  try {
    await fn(ctx, fake.calls);
  } finally {
    kv.close();
  }
}
```

- [ ] **Step 8: Run tests and type-check**

Run: `deno task test && deno task check`
Expected: `ok | 3 passed | 0 failed`; `deno check` exits 0.

- [ ] **Step 9: Commit**

```bash
git add deno.json deno.lock .gitignore src/
git commit -m "feat: scaffold Deno project with config, context and test helpers"
```

---

### Task 2: Google OAuth client (`google/oauth.ts`)

**Files:**
- Create: `src/google/oauth.ts`
- Test: `src/google/oauth_test.ts`

**Interfaces:**
- Consumes: `Ctx` (Task 1); `withCtx`, `json`, `fakeIdToken` (Task 1)
- Produces:
  - `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL` (string constants)
  - `interface GoogleLogin { email: string; emailVerified: boolean; refreshToken?: string; accessToken: string; expiresAt: number }`
  - `class GoogleAuthExpiredError extends Error` (message `"Google access expired — reconnect the connector"`)
  - `googleRedirectUri(ctx): string`
  - `buildGoogleAuthUrl(ctx, state: string, scopes: string[]): Promise<string>`
  - `exchangeGoogleCode(ctx, code: string): Promise<GoogleLogin>`
  - `saveGoogleLogin(ctx, login: GoogleLogin): Promise<void>`
  - `hasGoogleTokens(ctx): Promise<boolean>`
  - `clearGoogleTokens(ctx): Promise<void>`
  - `getAccessToken(ctx): Promise<string>` — throws `GoogleAuthExpiredError` (after wiping tokens) on `invalid_grant` or when none stored
  - KV key `["google", "tokens"]` → `{ refreshToken, accessToken, expiresAt }`

- [ ] **Step 1: Write the failing tests** — `src/google/oauth_test.ts`

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fakeIdToken, json, type Route, withCtx } from "../testing.ts";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getAccessToken,
  GOOGLE_TOKEN_URL,
  GoogleAuthExpiredError,
  type GoogleLogin,
  hasGoogleTokens,
  saveGoogleLogin,
} from "./oauth.ts";

const TOKEN = `POST ${GOOGLE_TOKEN_URL}`;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const login = (over: Partial<GoogleLogin> = {}): GoogleLogin => ({
  email: "owner@example.com",
  emailVerified: true,
  refreshToken: "r1",
  accessToken: "a1",
  expiresAt: NOW + 3600_000,
  ...over,
});

Deno.test("auth url asks for offline access, our scopes, and consent when no token is stored", async () => {
  await withCtx({}, async (ctx) => {
    const url = new URL(await buildGoogleAuthUrl(ctx, "st", ["scope.a"]));
    assertEquals(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assertEquals(url.searchParams.get("scope"), "openid email scope.a");
    assertEquals(url.searchParams.get("access_type"), "offline");
    assertEquals(url.searchParams.get("redirect_uri"), "https://conn.example.com/oauth/google/callback");
    assertEquals(url.searchParams.get("state"), "st");
    assertEquals(url.searchParams.get("prompt"), "consent");
    assertEquals(url.searchParams.has("include_granted_scopes"), false);
  });
});

Deno.test("auth url omits prompt=consent once a refresh token is stored", async () => {
  await withCtx({}, async (ctx) => {
    await saveGoogleLogin(ctx, login());
    const url = new URL(await buildGoogleAuthUrl(ctx, "st", []));
    assertEquals(url.searchParams.has("prompt"), false);
  });
});

Deno.test("exchangeGoogleCode posts the code and reads email from the id token", async () => {
  const routes: Record<string, Route> = {
    [TOKEN]: async (req) => {
      const form = new URLSearchParams(await req.text());
      assertEquals(form.get("grant_type"), "authorization_code");
      assertEquals(form.get("code"), "c1");
      assertEquals(form.get("client_secret"), "gsecret");
      return json({
        access_token: "a1",
        expires_in: 3600,
        refresh_token: "r1",
        id_token: fakeIdToken({ email: "Owner@Example.com", email_verified: true }),
      });
    },
  };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    assertEquals(await exchangeGoogleCode(ctx, "c1"), login());
  });
});

Deno.test("saveGoogleLogin keeps the stored refresh token when Google omits one", async () => {
  await withCtx({}, async (ctx) => {
    await saveGoogleLogin(ctx, login({ refreshToken: "r-old" }));
    await saveGoogleLogin(ctx, login({ refreshToken: undefined, accessToken: "a2" }));
    assertEquals((await ctx.kv.get(["google", "tokens"])).value, {
      refreshToken: "r-old",
      accessToken: "a2",
      expiresAt: NOW + 3600_000,
    });
  });
});

Deno.test("saveGoogleLogin fails when there is no refresh token at all", async () => {
  await withCtx({}, async (ctx) => {
    await assertRejects(
      () => saveGoogleLogin(ctx, login({ refreshToken: undefined })),
      Error,
      "refresh token",
    );
  });
});

Deno.test("getAccessToken uses the cached token while fresh and refreshes when stale", async () => {
  let refreshes = 0;
  const routes: Record<string, Route> = {
    [TOKEN]: async (req) => {
      const form = new URLSearchParams(await req.text());
      assertEquals(form.get("grant_type"), "refresh_token");
      assertEquals(form.get("refresh_token"), "r1");
      refreshes++;
      return json({ access_token: "a2", expires_in: 3600 });
    },
  };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    await saveGoogleLogin(ctx, login({ expiresAt: NOW + 10 * 60_000 }));
    assertEquals(await getAccessToken(ctx), "a1");
    ctx.now = () => NOW + 9.5 * 60_000; // inside the 60 s safety margin
    assertEquals(await getAccessToken(ctx), "a2");
    assertEquals(await getAccessToken(ctx), "a2");
    assertEquals(refreshes, 1);
  });
});

Deno.test("invalid_grant wipes the tokens and throws GoogleAuthExpiredError", async () => {
  const routes: Record<string, Route> = { [TOKEN]: () => json({ error: "invalid_grant" }, 400) };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    await saveGoogleLogin(ctx, login({ expiresAt: NOW - 1 }));
    await assertRejects(() => getAccessToken(ctx), GoogleAuthExpiredError);
    assert(!(await hasGoogleTokens(ctx)));
  });
});

Deno.test("getAccessToken without stored tokens throws GoogleAuthExpiredError", async () => {
  await withCtx({}, async (ctx) => {
    await assertRejects(() => getAccessToken(ctx), GoogleAuthExpiredError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/google/oauth_test.ts`
Expected: FAIL — module `./oauth.ts` not found.

- [ ] **Step 3: Implement `src/google/oauth.ts`**

```ts
import type { Ctx } from "../ctx.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const KEY = ["google", "tokens"];

interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

export interface GoogleLogin {
  email: string;
  emailVerified: boolean;
  refreshToken?: string;
  accessToken: string;
  expiresAt: number;
}

/** Google refused or lost our refresh token (revoked, or the 7-day Testing-mode expiry). */
export class GoogleAuthExpiredError extends Error {
  constructor() {
    super("Google access expired — reconnect the connector");
  }
}

class GoogleTokenError extends Error {
  constructor(readonly code: string, status: number) {
    super(`Google token endpoint returned ${status}: ${code}`);
  }
}

export function googleRedirectUri(ctx: Ctx): string {
  return `${ctx.config.baseUrl}/oauth/google/callback`;
}

export async function buildGoogleAuthUrl(ctx: Ctx, state: string, scopes: string[]): Promise<string> {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: ctx.config.googleClientId,
    redirect_uri: googleRedirectUri(ctx),
    response_type: "code",
    scope: ["openid", "email", ...scopes].join(" "),
    access_type: "offline",
    login_hint: ctx.config.allowedEmail,
    state,
  }).toString();
  // Google only returns a refresh token on consent; ask for it when we have none.
  if (!(await hasGoogleTokens(ctx))) url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeGoogleCode(ctx: Ctx, code: string): Promise<GoogleLogin> {
  const t = await tokenRequest(ctx, {
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(ctx),
  });
  // The ID token comes straight from Google's token endpoint over TLS, so the
  // signature does not need verifying (per Google's OpenID Connect docs).
  const claims = decodeJwtPayload(String(t.id_token ?? ""));
  return {
    email: String(claims.email ?? "").toLowerCase(),
    emailVerified: claims.email_verified === true,
    refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : undefined,
    accessToken: String(t.access_token),
    expiresAt: ctx.now() + Number(t.expires_in) * 1000,
  };
}

export async function saveGoogleLogin(ctx: Ctx, login: GoogleLogin): Promise<void> {
  const refreshToken = login.refreshToken ?? (await loadTokens(ctx))?.refreshToken;
  if (!refreshToken) {
    throw new Error(
      "Google did not return a refresh token; remove the app at myaccount.google.com/permissions and reconnect",
    );
  }
  const tokens: GoogleTokens = { refreshToken, accessToken: login.accessToken, expiresAt: login.expiresAt };
  await ctx.kv.set(KEY, tokens);
}

export async function hasGoogleTokens(ctx: Ctx): Promise<boolean> {
  return (await loadTokens(ctx)) !== null;
}

export async function clearGoogleTokens(ctx: Ctx): Promise<void> {
  await ctx.kv.delete(KEY);
}

export async function getAccessToken(ctx: Ctx): Promise<string> {
  const tokens = await loadTokens(ctx);
  if (!tokens) throw new GoogleAuthExpiredError();
  if (tokens.expiresAt - 60_000 > ctx.now()) return tokens.accessToken;
  let t: Record<string, unknown>;
  try {
    t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  } catch (e) {
    if (e instanceof GoogleTokenError && e.code === "invalid_grant") {
      await clearGoogleTokens(ctx);
      throw new GoogleAuthExpiredError();
    }
    throw e;
  }
  const accessToken = String(t.access_token);
  const updated: GoogleTokens = { ...tokens, accessToken, expiresAt: ctx.now() + Number(t.expires_in) * 1000 };
  await ctx.kv.set(KEY, updated);
  return accessToken;
}

async function tokenRequest(ctx: Ctx, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ctx.config.googleClientId,
      client_secret: ctx.config.googleClientSecret,
      ...params,
    }),
  });
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleTokenError(String(body.error ?? "unknown_error"), res.status);
  return body;
}

async function loadTokens(ctx: Ctx): Promise<GoogleTokens | null> {
  return (await ctx.kv.get<GoogleTokens>(KEY)).value;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) return {};
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
```

- [ ] **Step 4: Run tests**

Run: `deno test -A src/google/oauth_test.ts && deno task check`
Expected: `ok | 8 passed | 0 failed`; check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/google/
git commit -m "feat(google): add Google OAuth client with token refresh and expiry handling"
```

---

### Task 3: OAuth record store (`auth/store.ts`)

**Files:**
- Create: `src/auth/store.ts`
- Test: `src/auth/store_test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except `Deno.Kv`; tests use `Deno.openKv(":memory:")`.
- Produces:
  - `ACCESS_TTL_MS = 3_600_000`, `REFRESH_TTL_MS = 2_592_000_000`
  - `interface OAuthClient { clientId: string; redirectUris: string[]; clientName?: string }`
  - `interface PendingAuth { clientId: string; redirectUri: string; codeChallenge: string; clientState?: string }`
  - `interface TokenResponse { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number }`
  - `randomToken(): string`, `sha256(s: string): Promise<string>` (base64url), `pkceMatches(verifier, challenge): Promise<boolean>`
  - `registerClient(kv, redirectUris: string[], clientName?: string): Promise<OAuthClient>`, `getClient(kv, clientId): Promise<OAuthClient | null>`
  - `savePending(kv, state, pending: PendingAuth, now): Promise<void>`, `takePending(kv, state, now): Promise<PendingAuth | null>`
  - `issueCode(kv, grant: { clientId; redirectUri; codeChallenge }, now): Promise<string>`, `takeCode(kv, code, now): Promise<{ clientId; redirectUri; codeChallenge; expiresAt } | null>`
  - `issueTokens(kv, clientId, now): Promise<TokenResponse>`, `verifyAccessToken(kv, token, now): Promise<boolean>`
  - `rotateRefreshToken(kv, refreshToken, clientId, now): Promise<TokenResponse | null>`, `revokeAllTokens(kv): Promise<void>`

- [ ] **Step 1: Write the failing tests** — `src/auth/store_test.ts`

```ts
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import * as store from "./store.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("pkceMatches implements S256 (RFC 7636 appendix B vector)", async () => {
  assert(await store.pkceMatches(
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  ));
  assert(!(await store.pkceMatches("wrong", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")));
});

Deno.test("registered clients can be read back", async () => {
  await withKv(async (kv) => {
    const c = await store.registerClient(kv, ["https://a/cb"], "ChatGPT");
    assertEquals(await store.getClient(kv, c.clientId), c);
    assertEquals(await store.getClient(kv, "nope"), null);
  });
});

Deno.test("authorization codes are single use", async () => {
  await withKv(async (kv) => {
    const grant = { clientId: "c", redirectUri: "https://a/cb", codeChallenge: "x" };
    const code = await store.issueCode(kv, grant, NOW);
    assertEquals((await store.takeCode(kv, code, NOW))?.clientId, "c");
    assertEquals(await store.takeCode(kv, code, NOW), null);
  });
});

Deno.test("expired codes and pending logins are rejected", async () => {
  await withKv(async (kv) => {
    const code = await store.issueCode(kv, { clientId: "c", redirectUri: "r", codeChallenge: "x" }, NOW);
    assertEquals(await store.takeCode(kv, code, NOW + 5 * 60_000 + 1), null);
    await store.savePending(kv, "s", { clientId: "c", redirectUri: "r", codeChallenge: "x" }, NOW);
    assertEquals(await store.takePending(kv, "s", NOW + 10 * 60_000 + 1), null);
  });
});

Deno.test("access tokens verify until they expire", async () => {
  await withKv(async (kv) => {
    const t = await store.issueTokens(kv, "c", NOW);
    assertEquals(t.token_type, "Bearer");
    assertEquals(t.expires_in, 3600);
    assert(await store.verifyAccessToken(kv, t.access_token, NOW));
    assert(!(await store.verifyAccessToken(kv, t.access_token, NOW + store.ACCESS_TTL_MS)));
    assert(!(await store.verifyAccessToken(kv, "garbage", NOW)));
  });
});

Deno.test("refresh tokens rotate, are single use, and are bound to their client", async () => {
  await withKv(async (kv) => {
    const t1 = await store.issueTokens(kv, "c", NOW);
    assertEquals(await store.rotateRefreshToken(kv, t1.refresh_token, "other-client", NOW), null);
    const t2 = await store.issueTokens(kv, "c", NOW);
    const t3 = await store.rotateRefreshToken(kv, t2.refresh_token, "c", NOW);
    assert(t3);
    assertNotEquals(t3.refresh_token, t2.refresh_token);
    assertEquals(await store.rotateRefreshToken(kv, t2.refresh_token, "c", NOW), null);
  });
});

Deno.test("revokeAllTokens invalidates access and refresh tokens", async () => {
  await withKv(async (kv) => {
    const t = await store.issueTokens(kv, "c", NOW);
    await store.revokeAllTokens(kv);
    assert(!(await store.verifyAccessToken(kv, t.access_token, NOW)));
    assertEquals(await store.rotateRefreshToken(kv, t.refresh_token, "c", NOW), null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/auth/store_test.ts`
Expected: FAIL — module `./store.ts` not found.

- [ ] **Step 3: Implement `src/auth/store.ts`**

```ts
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

interface Expiring {
  expiresAt: number;
}
interface Grant extends Expiring {
  clientId: string;
}
interface CodeGrant extends Grant {
  redirectUri: string;
  codeChallenge: string;
}

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** base64url(SHA-256(s)) — used for token hashing and PKCE S256. */
export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return (await sha256(verifier)) === challenge;
}

export async function registerClient(kv: Deno.Kv, redirectUris: string[], clientName?: string): Promise<OAuthClient> {
  const client: OAuthClient = { clientId: crypto.randomUUID(), redirectUris, clientName };
  await kv.set(["oauth", "client", client.clientId], client);
  return client;
}

export async function getClient(kv: Deno.Kv, clientId: string): Promise<OAuthClient | null> {
  return (await kv.get<OAuthClient>(["oauth", "client", clientId])).value;
}

export async function savePending(kv: Deno.Kv, state: string, pending: PendingAuth, now: number): Promise<void> {
  await kv.set(["oauth", "pending", state], { ...pending, expiresAt: now + PENDING_TTL_MS }, {
    expireIn: PENDING_TTL_MS,
  });
}

export async function takePending(kv: Deno.Kv, state: string, now: number): Promise<PendingAuth | null> {
  return await take<PendingAuth & Expiring>(kv, ["oauth", "pending", state], now);
}

export async function issueCode(
  kv: Deno.Kv,
  grant: { clientId: string; redirectUri: string; codeChallenge: string },
  now: number,
): Promise<string> {
  const code = randomToken();
  await kv.set(["oauth", "code", await sha256(code)], { ...grant, expiresAt: now + CODE_TTL_MS }, {
    expireIn: CODE_TTL_MS,
  });
  return code;
}

/** Single use: the code is deleted on first read. */
export async function takeCode(kv: Deno.Kv, code: string, now: number): Promise<CodeGrant | null> {
  return await take<CodeGrant>(kv, ["oauth", "code", await sha256(code)], now);
}

export async function issueTokens(kv: Deno.Kv, clientId: string, now: number): Promise<TokenResponse> {
  const access = randomToken();
  const refresh = randomToken();
  await kv.set(["oauth", "access", await sha256(access)], { clientId, expiresAt: now + ACCESS_TTL_MS }, {
    expireIn: ACCESS_TTL_MS,
  });
  await kv.set(["oauth", "refresh", await sha256(refresh)], { clientId, expiresAt: now + REFRESH_TTL_MS }, {
    expireIn: REFRESH_TTL_MS,
  });
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000 };
}

export async function verifyAccessToken(kv: Deno.Kv, token: string, now: number): Promise<boolean> {
  const grant = (await kv.get<Grant>(["oauth", "access", await sha256(token)])).value;
  return grant !== null && grant.expiresAt > now;
}

/** Consumes the old refresh token; null if unknown, expired, or issued to another client. */
export async function rotateRefreshToken(
  kv: Deno.Kv,
  refreshToken: string,
  clientId: string,
  now: number,
): Promise<TokenResponse | null> {
  const grant = await take<Grant>(kv, ["oauth", "refresh", await sha256(refreshToken)], now);
  if (!grant || grant.clientId !== clientId) return null;
  return await issueTokens(kv, clientId, now);
}

export async function revokeAllTokens(kv: Deno.Kv): Promise<void> {
  for (const prefix of [["oauth", "access"], ["oauth", "refresh"]]) {
    for await (const entry of kv.list({ prefix })) await kv.delete(entry.key);
  }
}

/** Atomically read-and-delete; null if missing, raced, or expired. KV expiry is lazy, so check expiresAt too. */
async function take<T extends Expiring>(kv: Deno.Kv, key: Deno.KvKey, now: number): Promise<T | null> {
  const entry = await kv.get<T>(key);
  if (entry.value === null) return null;
  const res = await kv.atomic().check(entry).delete(key).commit();
  if (!res.ok || entry.value.expiresAt <= now) return null;
  return entry.value;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

- [ ] **Step 4: Run tests**

Run: `deno test -A src/auth/store_test.ts && deno task check`
Expected: `ok | 7 passed | 0 failed`; check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/auth/store.ts src/auth/store_test.ts
git commit -m "feat(auth): add KV-backed OAuth client, code and token store"
```

---

### Task 4: OAuth endpoints and bearer guard (`auth/routes.ts`)

**Files:**
- Create: `src/auth/routes.ts`
- Test: `src/auth/routes_test.ts`

**Interfaces:**
- Consumes: `Ctx`; `store.*` (Task 3); `buildGoogleAuthUrl`, `exchangeGoogleCode`, `saveGoogleLogin`, `hasGoogleTokens`, `clearGoogleTokens`, `GOOGLE_TOKEN_URL` (Task 2); test helpers (Task 1)
- Produces:
  - `handleAuthRoute(ctx, req: Request, scopes: string[]): Promise<Response | null>` — `null` when the path is not an auth route
  - `requireBearer(ctx, req: Request): Promise<Response | null>` — `null` when authorized, else a 401 `Response` with `WWW-Authenticate: Bearer resource_metadata="<BASE_URL>/.well-known/oauth-protected-resource"`
  - Routes: `GET /.well-known/oauth-protected-resource[/mcp]`, `GET /.well-known/oauth-authorization-server`, `POST /register`, `GET /authorize`, `GET /oauth/google/callback`, `POST /token`

- [ ] **Step 1: Write the failing tests** — `src/auth/routes_test.ts`

```ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../ctx.ts";
import { clearGoogleTokens, GOOGLE_TOKEN_URL, hasGoogleTokens } from "../google/oauth.ts";
import { fakeIdToken, json, type Route, withCtx } from "../testing.ts";
import { handleAuthRoute, requireBearer } from "./routes.ts";

const REDIRECT = "https://chat.example.com/cb";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function googleReturns(email: string, verified = true): Record<string, Route> {
  return {
    [`POST ${GOOGLE_TOKEN_URL}`]: () =>
      json({
        access_token: "ga",
        expires_in: 3600,
        refresh_token: "gr",
        id_token: fakeIdToken({ email, email_verified: verified }),
      }),
  };
}

async function call(ctx: Ctx, method: string, path: string, body?: BodyInit): Promise<Response> {
  const res = await handleAuthRoute(ctx, new Request(`https://conn.example.com${path}`, { method, body }), ["scope.a"]);
  assert(res, `no auth route for ${method} ${path}`);
  return res;
}

async function register(ctx: Ctx): Promise<string> {
  const res = await call(ctx, "POST", "/register", JSON.stringify({ redirect_uris: [REDIRECT], client_name: "ChatGPT" }));
  assertEquals(res.status, 201);
  return (await res.json()).client_id;
}

function authorizeQuery(clientId: string, redirectUri = REDIRECT): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "cs",
  }).toString();
}

/** register → authorize → Google callback; returns our authorization code. */
async function login(ctx: Ctx): Promise<{ clientId: string; code: string }> {
  const clientId = await register(ctx);
  const toGoogle = await call(ctx, "GET", `/authorize?${authorizeQuery(clientId)}`);
  assertEquals(toGoogle.status, 302);
  const googleUrl = new URL(toGoogle.headers.get("location")!);
  assertEquals(googleUrl.searchParams.get("scope"), "openid email scope.a");
  const state = googleUrl.searchParams.get("state")!;
  const back = await call(ctx, "GET", `/oauth/google/callback?state=${state}&code=gcode`);
  assertEquals(back.status, 302);
  const loc = new URL(back.headers.get("location")!);
  assertEquals(loc.origin + loc.pathname, REDIRECT);
  assertEquals(loc.searchParams.get("state"), "cs");
  return { clientId, code: loc.searchParams.get("code")! };
}

function exchange(ctx: Ctx, clientId: string, code: string, verifier = VERIFIER) {
  return call(ctx, "POST", "/token", new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }));
}

function bearer(ctx: Ctx, token?: string) {
  const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
  return requireBearer(ctx, new Request("https://conn.example.com/mcp", { method: "POST", headers }));
}

Deno.test("metadata documents point at our endpoints", async () => {
  await withCtx({}, async (ctx) => {
    const pr = await (await call(ctx, "GET", "/.well-known/oauth-protected-resource")).json();
    assertEquals(pr.resource, "https://conn.example.com/mcp");
    assertEquals(pr.authorization_servers, ["https://conn.example.com"]);
    assertEquals((await call(ctx, "GET", "/.well-known/oauth-protected-resource/mcp")).status, 200);
    const as = await (await call(ctx, "GET", "/.well-known/oauth-authorization-server")).json();
    assertEquals(as.token_endpoint, "https://conn.example.com/token");
    assertEquals(as.registration_endpoint, "https://conn.example.com/register");
    assertEquals(as.code_challenge_methods_supported, ["S256"]);
    assertEquals(await handleAuthRoute(ctx, new Request("https://conn.example.com/other"), []), null);
  });
});

Deno.test("full login issues tokens that pass requireBearer, and refresh rotates", async () => {
  await withCtx({ routes: googleReturns("owner@example.com") }, async (ctx) => {
    const { clientId, code } = await login(ctx);
    const res = await exchange(ctx, clientId, code);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const tokens = await res.json();
    assertEquals(await bearer(ctx, tokens.access_token), null);

    const refreshed = await call(ctx, "POST", "/token", new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }));
    assertEquals(refreshed.status, 200);
    const reused = await call(ctx, "POST", "/token", new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }));
    assertEquals((await reused.json()).error, "invalid_grant");
  });
});

Deno.test("a code cannot be replayed or used with the wrong PKCE verifier", async () => {
  await withCtx({ routes: googleReturns("owner@example.com") }, async (ctx) => {
    const first = await login(ctx);
    assertEquals((await exchange(ctx, first.clientId, first.code, "wrong-verifier")).status, 400);
    // a failed attempt still consumes the code
    assertEquals((await exchange(ctx, first.clientId, first.code)).status, 400);

    const second = await login(ctx);
    assertEquals((await exchange(ctx, second.clientId, second.code)).status, 200);
    const replay = await exchange(ctx, second.clientId, second.code);
    assertEquals(replay.status, 400);
    assertEquals((await replay.json()).error, "invalid_grant");
  });
});

Deno.test("a different Google account is refused and nothing is stored", async () => {
  await withCtx({ routes: googleReturns("stranger@example.com") }, async (ctx) => {
    const clientId = await register(ctx);
    const toGoogle = await call(ctx, "GET", `/authorize?${authorizeQuery(clientId)}`);
    const state = new URL(toGoogle.headers.get("location")!).searchParams.get("state")!;
    const res = await call(ctx, "GET", `/oauth/google/callback?state=${state}&code=gcode`);
    assertEquals(res.status, 403);
    assert(!(await hasGoogleTokens(ctx)));
  });
});

Deno.test("an unverified Google email is refused", async () => {
  await withCtx({ routes: googleReturns("owner@example.com", false) }, async (ctx) => {
    const clientId = await register(ctx);
    const toGoogle = await call(ctx, "GET", `/authorize?${authorizeQuery(clientId)}`);
    const state = new URL(toGoogle.headers.get("location")!).searchParams.get("state")!;
    assertEquals((await call(ctx, "GET", `/oauth/google/callback?state=${state}&code=gcode`)).status, 403);
  });
});

Deno.test("authorize never redirects to an unregistered redirect_uri", async () => {
  await withCtx({}, async (ctx) => {
    const clientId = await register(ctx);
    const res = await call(ctx, "GET", `/authorize?${authorizeQuery(clientId, "https://evil.example/cb")}`);
    assertEquals(res.status, 400);
    assertEquals(res.headers.get("location"), null);
    assertEquals((await call(ctx, "GET", `/authorize?${authorizeQuery("unknown")}`)).status, 400);
  });
});

Deno.test("authorize without S256 PKCE redirects back with invalid_request", async () => {
  await withCtx({}, async (ctx) => {
    const clientId = await register(ctx);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "cs" });
    const res = await call(ctx, "GET", `/authorize?${q}`);
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.searchParams.get("error"), "invalid_request");
    assertEquals(loc.searchParams.get("state"), "cs");
  });
});

Deno.test("register accepts https and localhost redirect URIs only", async () => {
  await withCtx({}, async (ctx) => {
    for (const uri of ["http://evil.example/cb", "not a url"]) {
      const res = await call(ctx, "POST", "/register", JSON.stringify({ redirect_uris: [uri] }));
      assertEquals(res.status, 400);
    }
    const ok = await call(ctx, "POST", "/register", JSON.stringify({ redirect_uris: ["http://localhost:6274/cb"] }));
    assertEquals(ok.status, 201);
  });
});

Deno.test("requireBearer returns 401 with resource metadata when the token is missing or bad", async () => {
  await withCtx({}, async (ctx) => {
    for (const token of [undefined, "garbage"]) {
      const res = await bearer(ctx, token);
      assertEquals(res?.status, 401);
      assertStringIncludes(
        res!.headers.get("www-authenticate")!,
        'resource_metadata="https://conn.example.com/.well-known/oauth-protected-resource"',
      );
    }
  });
});

Deno.test("losing Google access revokes our tokens so the chat client must log in again", async () => {
  await withCtx({ routes: googleReturns("owner@example.com") }, async (ctx) => {
    const { clientId, code } = await login(ctx);
    const tokens = await (await exchange(ctx, clientId, code)).json();
    await clearGoogleTokens(ctx);
    assertEquals((await bearer(ctx, tokens.access_token))?.status, 401);
    const refreshed = await call(ctx, "POST", "/token", new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }));
    assertEquals(refreshed.status, 400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/auth/routes_test.ts`
Expected: FAIL — module `./routes.ts` not found.

- [ ] **Step 3: Implement `src/auth/routes.ts`**

```ts
import type { Ctx } from "../ctx.ts";
import { buildGoogleAuthUrl, exchangeGoogleCode, hasGoogleTokens, saveGoogleLogin } from "../google/oauth.ts";
import * as store from "./store.ts";

/** Handles OAuth endpoints; returns null for any other path. `scopes` are the Google scopes to request. */
export async function handleAuthRoute(ctx: Ctx, req: Request, scopes: string[]): Promise<Response | null> {
  const url = new URL(req.url);
  switch (`${req.method} ${url.pathname}`) {
    case "GET /.well-known/oauth-protected-resource":
    case "GET /.well-known/oauth-protected-resource/mcp":
      return Response.json(protectedResourceMetadata(ctx));
    case "GET /.well-known/oauth-authorization-server":
      return Response.json(authServerMetadata(ctx));
    case "POST /register":
      return await register(ctx, req);
    case "GET /authorize":
      return await authorize(ctx, url, scopes);
    case "GET /oauth/google/callback":
      return await googleCallback(ctx, url);
    case "POST /token":
      return await token(ctx, req);
  }
  return null;
}

export async function requireBearer(ctx: Ctx, req: Request): Promise<Response | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (token && (await store.verifyAccessToken(ctx.kv, token, ctx.now()))) {
    if (await hasGoogleTokens(ctx)) return null;
    // Google access is gone: drop our tokens so the chat client re-runs the login.
    await store.revokeAllTokens(ctx.kv);
  }
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": `Bearer resource_metadata="${ctx.config.baseUrl}/.well-known/oauth-protected-resource"`,
    },
  });
}

function protectedResourceMetadata(ctx: Ctx) {
  return {
    resource: `${ctx.config.baseUrl}/mcp`,
    authorization_servers: [ctx.config.baseUrl],
    bearer_methods_supported: ["header"],
  };
}

function authServerMetadata(ctx: Ctx) {
  const base = ctx.config.baseUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

async function register(ctx: Ctx, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const uris: unknown = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAllowedRedirect)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http://localhost)");
  }
  const name = typeof body.client_name === "string" ? body.client_name : undefined;
  const client = await store.registerClient(ctx.kv, uris, name);
  return Response.json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, { status: 201 });
}

function isAllowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

async function authorize(ctx: Ctx, url: URL, scopes: string[]): Promise<Response> {
  const p = url.searchParams;
  const client = await store.getClient(ctx.kv, p.get("client_id") ?? "");
  const redirectUri = p.get("redirect_uri") ?? "";
  // Until redirect_uri is verified, report errors on our own page — never redirect.
  if (!client) return new Response("Unknown client_id", { status: 400 });
  if (!client.redirectUris.includes(redirectUri)) {
    return new Response("redirect_uri is not registered for this client", { status: 400 });
  }
  const clientState = p.get("state") ?? undefined;
  const fail = (error: string) => redirectWith(redirectUri, { error, state: clientState });
  if (p.get("response_type") !== "code") return fail("unsupported_response_type");
  const codeChallenge = p.get("code_challenge");
  if (!codeChallenge || p.get("code_challenge_method") !== "S256") return fail("invalid_request");

  const state = store.randomToken();
  await store.savePending(ctx.kv, state, { clientId: client.clientId, redirectUri, codeChallenge, clientState }, ctx.now());
  return Response.redirect(await buildGoogleAuthUrl(ctx, state, scopes), 302);
}

async function googleCallback(ctx: Ctx, url: URL): Promise<Response> {
  const p = url.searchParams;
  const pending = await store.takePending(ctx.kv, p.get("state") ?? "", ctx.now());
  if (!pending) {
    return new Response("Login session expired or invalid. Start again from your chat app.", { status: 400 });
  }
  const back = (params: Record<string, string>) =>
    redirectWith(pending.redirectUri, { ...params, state: pending.clientState });
  const code = p.get("code");
  if (!code) return back({ error: "access_denied" });

  const login = await exchangeGoogleCode(ctx, code);
  if (!login.emailVerified || login.email !== ctx.config.allowedEmail) {
    return new Response("This connector is private to its owner.", { status: 403 });
  }
  await saveGoogleLogin(ctx, login);
  const ourCode = await store.issueCode(ctx.kv, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
  }, ctx.now());
  return back({ code: ourCode });
}

async function token(ctx: Ctx, req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const clientId = form.get("client_id") ?? "";
  switch (form.get("grant_type")) {
    case "authorization_code": {
      const grant = await store.takeCode(ctx.kv, form.get("code") ?? "", ctx.now());
      const valid = grant !== null &&
        grant.clientId === clientId &&
        grant.redirectUri === form.get("redirect_uri") &&
        (await store.pkceMatches(form.get("code_verifier") ?? "", grant.codeChallenge));
      if (!valid) return oauthError("invalid_grant", "Invalid, expired, or already used code");
      return tokenJson(await store.issueTokens(ctx.kv, clientId, ctx.now()));
    }
    case "refresh_token": {
      const tokens = (await hasGoogleTokens(ctx))
        ? await store.rotateRefreshToken(ctx.kv, form.get("refresh_token") ?? "", clientId, ctx.now())
        : null;
      if (!tokens) return oauthError("invalid_grant", "Invalid or expired refresh token");
      return tokenJson(tokens);
    }
    default:
      return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }
}

function tokenJson(tokens: store.TokenResponse): Response {
  return Response.json(tokens, { headers: { "cache-control": "no-store" } });
}

function oauthError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });
}

function redirectWith(uri: string, params: Record<string, string | undefined>): Response {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}
```

- [ ] **Step 4: Run tests**

Run: `deno test -A src/auth/ && deno task check`
Expected: all auth tests pass (`17 passed`); check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/auth/routes.ts src/auth/routes_test.ts
git commit -m "feat(auth): add OAuth 2.1 endpoints delegating login to Google, and bearer guard"
```

---

### Task 5: Health data catalogue and query building

**Files:**
- Create: `src/sources/google-health/catalog.ts`, `src/sources/google-health/query.ts`
- Test: `src/sources/google-health/catalog_test.ts`, `src/sources/google-health/query_test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (`catalog.ts`):
  - `type Kind = "interval" | "sample" | "daily" | "session"`, `type Mode = "raw" | "merged" | "daily" | "total"`, `type Category = "activity" | "body" | "heart" | "sleep" | "logs"`, `type FilterField = "civil_start" | "civil_end" | "civil_sample" | "date"`
  - `interface DataTypeInfo { id: string; kind: Kind; category: Category; modes: Mode[]; filter: FilterField; scope: string; maxPageSize?: number }`
  - `SCOPE` (object of 4 scope URLs), `SCOPES: string[]`, `CATALOG: DataTypeInfo[]`, `findType(id): DataTypeInfo | undefined`
- Produces (`query.ts`):
  - `MAX_POINTS = 500`
  - `interface CivilRange { start: string; end: string }` — `YYYY-MM-DDTHH:mm:ss`, end exclusive
  - `interface ApiRequest { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown }`
  - `parseRange(from, to): CivilRange` (throws `RangeError`), `addDays(date, n): string`, `todayIn(tz, nowMs): string`, `civilToUtc(civil, tz): string`
  - `chooseMode(info, requested: Mode | "auto", range): Mode` (throws `RangeError`)
  - `buildFilter(info, range): string`, `buildRequest(info, mode, range, tz, pageToken?): ApiRequest`
  - `trimResponse(info, mode, body): { points: Record<string, unknown>[]; nextPageToken?: string }`

- [ ] **Step 1: Write the failing catalogue test** — `src/sources/google-health/catalog_test.ts`

```ts
import { assert, assertEquals } from "@std/assert";
import { CATALOG, findType, SCOPE, SCOPES } from "./catalog.ts";

Deno.test("catalogue ids are unique and every type has at least one mode", () => {
  assertEquals(new Set(CATALOG.map((t) => t.id)).size, CATALOG.length);
  assert(CATALOG.every((t) => t.modes.length > 0));
});

Deno.test("rollup-only types cannot be listed raw", () => {
  for (const id of ["floors", "total-calories", "calories-in-heart-rate-zone"]) {
    assertEquals(findType(id)?.modes.includes("raw"), false, id);
  }
});

Deno.test("scopes follow the data type, not just the category", () => {
  assertEquals(findType("sleep")?.scope, SCOPE.sleep);
  assertEquals(findType("respiratory-rate-sleep-summary")?.scope, SCOPE.metrics);
  assertEquals(findType("hydration-log")?.scope, SCOPE.nutrition);
  assertEquals(findType("steps")?.scope, SCOPE.activity);
  assert(CATALOG.every((t) => SCOPES.includes(t.scope)));
});

Deno.test("sleep filters on civil end time; exercise and sleep cap pages at 25", () => {
  assertEquals(findType("sleep")?.filter, "civil_end");
  assertEquals(findType("exercise")?.filter, "civil_start");
  assertEquals(findType("sleep")?.maxPageSize, 25);
  assertEquals(findType("exercise")?.maxPageSize, 25);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/sources/google-health/catalog_test.ts`
Expected: FAIL — module `./catalog.ts` not found.

- [ ] **Step 3: Implement `src/sources/google-health/catalog.ts`**

```ts
// Readable Google Health API data types (https://developers.google.com/health/data-types).
// The API has no discovery endpoint, so this list is maintained by hand.

export type Kind = "interval" | "sample" | "daily" | "session";
export type Mode = "raw" | "merged" | "daily" | "total";
export type Category = "activity" | "body" | "heart" | "sleep" | "logs";
/** Field used by list/reconcile filters. All are civil (local) times. */
export type FilterField = "civil_start" | "civil_end" | "civil_sample" | "date";

export interface DataTypeInfo {
  id: string;
  kind: Kind;
  category: Category;
  modes: Mode[];
  filter: FilterField;
  scope: string;
  maxPageSize?: number;
}

const G = "https://www.googleapis.com/auth/googlehealth.";
export const SCOPE = {
  activity: `${G}activity_and_fitness.readonly`,
  metrics: `${G}health_metrics_and_measurements.readonly`,
  sleep: `${G}sleep.readonly`,
  nutrition: `${G}nutrition.readonly`,
} as const;
export const SCOPES: string[] = Object.values(SCOPE);

const CATEGORY_SCOPE: Record<Category, string> = {
  activity: SCOPE.activity,
  body: SCOPE.metrics,
  heart: SCOPE.metrics,
  sleep: SCOPE.sleep,
  logs: SCOPE.nutrition,
};

const ALL: Mode[] = ["raw", "merged", "daily", "total"];
const POINTS: Mode[] = ["raw", "merged"];
const ROLLUP: Mode[] = ["daily", "total"];

function t(id: string, kind: Kind, category: Category, modes: Mode[], extra: Partial<DataTypeInfo> = {}): DataTypeInfo {
  const filter: FilterField = kind === "sample" ? "civil_sample" : kind === "daily" ? "date" : "civil_start";
  return { id, kind, category, modes, filter, scope: CATEGORY_SCOPE[category], ...extra };
}

export const CATALOG: DataTypeInfo[] = [
  // activity
  t("steps", "interval", "activity", ALL),
  t("distance", "interval", "activity", ALL),
  t("active-energy-burned", "interval", "activity", ALL),
  t("active-minutes", "interval", "activity", ALL),
  t("active-zone-minutes", "interval", "activity", ALL),
  t("altitude", "interval", "activity", ALL),
  t("sedentary-period", "interval", "activity", ALL),
  t("swim-lengths-data", "interval", "activity", ALL),
  t("time-in-heart-rate-zone", "interval", "activity", ALL),
  t("activity-level", "interval", "activity", POINTS),
  t("floors", "interval", "activity", ["merged", "daily", "total"]),
  t("total-calories", "interval", "activity", ROLLUP),
  t("calories-in-heart-rate-zone", "interval", "activity", ROLLUP),
  t("exercise", "session", "activity", POINTS, { maxPageSize: 25 }),
  t("vo2-max", "sample", "activity", POINTS),
  t("run-vo2-max", "sample", "activity", ALL),
  t("daily-vo2-max", "daily", "activity", POINTS),
  // body
  t("weight", "sample", "body", ALL),
  t("body-fat", "sample", "body", ALL),
  t("height", "sample", "body", POINTS),
  t("blood-glucose", "sample", "body", ALL),
  t("core-body-temperature", "sample", "body", ALL),
  // heart
  t("heart-rate", "sample", "heart", ALL),
  t("heart-rate-variability", "sample", "heart", POINTS),
  t("oxygen-saturation", "sample", "heart", POINTS),
  t("daily-resting-heart-rate", "daily", "heart", POINTS),
  t("daily-heart-rate-variability", "daily", "heart", POINTS),
  t("daily-heart-rate-zones", "daily", "heart", POINTS),
  t("daily-oxygen-saturation", "daily", "heart", POINTS),
  t("daily-respiratory-rate", "daily", "heart", POINTS),
  // sleep
  t("sleep", "session", "sleep", POINTS, { filter: "civil_end", maxPageSize: 25 }),
  t("respiratory-rate-sleep-summary", "sample", "sleep", POINTS, { scope: SCOPE.metrics }),
  t("daily-sleep-temperature-derivations", "daily", "sleep", POINTS, { scope: SCOPE.metrics }),
  // logs
  t("hydration-log", "session", "logs", ALL),
];

export function findType(id: string): DataTypeInfo | undefined {
  return CATALOG.find((info) => info.id === id);
}
```

- [ ] **Step 4: Run catalogue tests**

Run: `deno test -A src/sources/google-health/catalog_test.ts`
Expected: `ok | 4 passed | 0 failed`

- [ ] **Step 5: Write the failing query tests** — `src/sources/google-health/query_test.ts`

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { findType } from "./catalog.ts";
import {
  buildFilter,
  buildRequest,
  chooseMode,
  civilToUtc,
  parseRange,
  todayIn,
  trimResponse,
} from "./query.ts";

const type = (id: string) => findType(id)!;

Deno.test("parseRange: dates are whole local days with an inclusive 'to'", () => {
  assertEquals(parseRange("2026-09-01", "2026-09-07"), { start: "2026-09-01T00:00:00", end: "2026-09-08T00:00:00" });
  assertEquals(parseRange("2026-12-31", "2026-12-31"), { start: "2026-12-31T00:00:00", end: "2027-01-01T00:00:00" });
});

Deno.test("parseRange: datetimes are used as-is, seconds padded", () => {
  assertEquals(parseRange("2026-09-01T08:30", "2026-09-01T12:00:15"), {
    start: "2026-09-01T08:30:00",
    end: "2026-09-01T12:00:15",
  });
});

Deno.test("parseRange rejects reversed, impossible and malformed dates", () => {
  assertThrows(() => parseRange("2026-09-08", "2026-09-01"), RangeError, "must be before");
  assertThrows(() => parseRange("2026-02-30", "2026-03-01"), RangeError);
  assertThrows(() => parseRange("09/01/2026", "2026-09-02"), RangeError, "YYYY-MM-DD");
  assertThrows(() => parseRange("2026-09-01T08:00:00Z", "2026-09-02"), RangeError);
});

Deno.test("chooseMode: auto uses daily rollups for long interval ranges, merged otherwise", () => {
  const week = parseRange("2026-09-01", "2026-09-07");
  const day = parseRange("2026-09-01", "2026-09-01");
  assertEquals(chooseMode(type("steps"), "auto", week), "daily");
  assertEquals(chooseMode(type("steps"), "auto", day), "merged");
  assertEquals(chooseMode(type("weight"), "auto", week), "merged");
  assertEquals(chooseMode(type("total-calories"), "auto", day), "daily");
  assertEquals(chooseMode(type("heart-rate"), "raw", day), "raw");
  assertThrows(() => chooseMode(type("sleep"), "daily", day), RangeError, "sleep supports modes: raw, merged");
});

Deno.test("buildFilter uses snake_case ids and the right civil field per kind", () => {
  const r = parseRange("2026-09-01", "2026-09-02");
  assertEquals(
    buildFilter(type("steps"), r),
    'steps.interval.civil_start_time >= "2026-09-01T00:00:00" AND steps.interval.civil_start_time < "2026-09-03T00:00:00"',
  );
  assertEquals(
    buildFilter(type("heart-rate"), r),
    'heart_rate.sample_time.civil_time >= "2026-09-01T00:00:00" AND heart_rate.sample_time.civil_time < "2026-09-03T00:00:00"',
  );
  assertEquals(
    buildFilter(type("daily-resting-heart-rate"), r),
    'daily_resting_heart_rate.date >= "2026-09-01" AND daily_resting_heart_rate.date < "2026-09-03"',
  );
  assertEquals(
    buildFilter(type("sleep"), r),
    'sleep.interval.civil_end_time >= "2026-09-01T00:00:00" AND sleep.interval.civil_end_time < "2026-09-03T00:00:00"',
  );
  // a partial end day still includes that date for daily types
  assertEquals(
    buildFilter(type("daily-resting-heart-rate"), parseRange("2026-09-01T06:00", "2026-09-02T06:00")),
    'daily_resting_heart_rate.date >= "2026-09-01" AND daily_resting_heart_rate.date < "2026-09-03"',
  );
});

Deno.test("buildRequest: raw and merged are GETs with filter, page size and token", () => {
  const r = parseRange("2026-09-01", "2026-09-01");
  const raw = buildRequest(type("steps"), "raw", r, "UTC", "tok");
  assertEquals(raw.method, "GET");
  assertEquals(raw.path, "/v4/users/me/dataTypes/steps/dataPoints");
  assertEquals(raw.query?.pageSize, "500");
  assertEquals(raw.query?.pageToken, "tok");
  const merged = buildRequest(type("sleep"), "merged", r, "UTC");
  assertEquals(merged.path, "/v4/users/me/dataTypes/sleep/dataPoints:reconcile");
  assertEquals(merged.query?.pageSize, "25");
});

Deno.test("buildRequest: daily posts a civil range to dailyRollUp", () => {
  const req = buildRequest(type("steps"), "daily", parseRange("2026-09-01", "2026-09-02"), "UTC");
  assertEquals(req.method, "POST");
  assertEquals(req.path, "/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp");
  assertEquals(req.body, {
    range: {
      start: { date: { year: 2026, month: 9, day: 1 }, time: { hours: 0, minutes: 0, seconds: 0 } },
      end: { date: { year: 2026, month: 9, day: 3 }, time: { hours: 0, minutes: 0, seconds: 0 } },
    },
    windowSizeDays: 1,
    pageSize: 500,
  });
});

Deno.test("buildRequest: total converts local time to UTC and spans a 23 h DST day", () => {
  const req = buildRequest(type("steps"), "total", parseRange("2026-03-08", "2026-03-08"), "America/New_York");
  assertEquals(req.path, "/v4/users/me/dataTypes/steps/dataPoints:rollUp");
  assertEquals(req.body, {
    range: { startTime: "2026-03-08T05:00:00Z", endTime: "2026-03-09T04:00:00Z" },
    windowSize: "82800s",
  });
});

Deno.test("civilToUtc handles winter and summer offsets; todayIn uses the zone", () => {
  assertEquals(civilToUtc("2026-01-15T00:00:00", "America/New_York"), "2026-01-15T05:00:00Z");
  assertEquals(civilToUtc("2026-07-15T00:00:00", "America/New_York"), "2026-07-15T04:00:00Z");
  assertEquals(todayIn("America/New_York", Date.parse("2026-09-29T02:00:00Z")), "2026-09-28");
  assertEquals(todayIn("UTC", Date.parse("2026-09-29T02:00:00Z")), "2026-09-29");
});

Deno.test("trimResponse flattens the value, drops names, keeps source only in raw mode", () => {
  const body = {
    dataPoints: [{
      name: "users/1/dataTypes/body-fat/dataPoints/9",
      dataSource: { platform: "FITBIT", device: { displayName: "Charge 6" }, recordingMethod: "PASSIVELY_MEASURED" },
      bodyFat: { sampleTime: { physicalTime: "2026-03-10T10:00:00Z" }, percentage: 20 },
    }],
    nextPageToken: "next",
  };
  assertEquals(trimResponse(type("body-fat"), "raw", body), {
    points: [{
      sampleTime: { physicalTime: "2026-03-10T10:00:00Z" },
      percentage: 20,
      source: "FITBIT / Charge 6 / PASSIVELY_MEASURED",
    }],
    nextPageToken: "next",
  });
  assertEquals(trimResponse(type("body-fat"), "merged", { ...body, nextPageToken: "" }), {
    points: [{ sampleTime: { physicalTime: "2026-03-10T10:00:00Z" }, percentage: 20 }],
  });
});

Deno.test("trimResponse reads rollupDataPoints and handles empty responses", () => {
  const rollup = { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, steps: { countSum: "8000" } }] };
  assertEquals(trimResponse(type("steps"), "daily", rollup).points, [
    { civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, countSum: "8000" },
  ]);
  assertEquals(trimResponse(type("steps"), "merged", {}), { points: [] });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `deno test -A src/sources/google-health/query_test.ts`
Expected: FAIL — module `./query.ts` not found.

- [ ] **Step 7: Implement `src/sources/google-health/query.ts`**

```ts
import type { DataTypeInfo, Mode } from "./catalog.ts";

export const MAX_POINTS = 500;

/** Local (civil) times as YYYY-MM-DDTHH:mm:ss; `end` is exclusive. */
export interface CivilRange {
  start: string;
  end: string;
}

export interface ApiRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function parseRange(from: string, to: string): CivilRange {
  const start = toCivil(from, false);
  const end = toCivil(to, true);
  if (start >= end) throw new RangeError(`"from" (${from}) must be before "to" (${to})`);
  return { start, end };
}

function toCivil(value: string, isEnd: boolean): string {
  if (DATE.test(value)) {
    checkDate(value);
    return `${isEnd ? addDays(value, 1) : value}T00:00:00`;
  }
  if (DATETIME.test(value)) {
    checkDate(value.slice(0, 10));
    return value.length === 16 ? `${value}:00` : value;
  }
  throw new RangeError(`Invalid date "${value}": use YYYY-MM-DD or YYYY-MM-DDTHH:mm in your local time`);
}

function checkDate(date: string): void {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid date "${date}"`);
  }
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIn(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowMs));
}

/** Converts a local time in `tz` to an RFC 3339 UTC timestamp. */
export function civilToUtc(civil: string, tz: string): string {
  const naive = Date.parse(`${civil}Z`);
  // Two passes so the offset is taken at the resulting instant (correct across DST changes).
  let ts = naive - tzOffsetMs(naive, tz);
  ts = naive - tzOffsetMs(ts, tz);
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function rangeDays(r: CivilRange): number {
  return (Date.parse(`${r.end}Z`) - Date.parse(`${r.start}Z`)) / 86_400_000;
}

export function chooseMode(info: DataTypeInfo, requested: Mode | "auto", range: CivilRange): Mode {
  if (requested !== "auto") {
    if (!info.modes.includes(requested)) {
      throw new RangeError(`${info.id} supports modes: ${info.modes.join(", ")}`);
    }
    return requested;
  }
  if (!info.modes.includes("merged")) return info.modes.includes("daily") ? "daily" : info.modes[0];
  if (info.kind === "interval" && info.modes.includes("daily") && rangeDays(range) > 2) return "daily";
  return "merged";
}

const FILTER_FIELD = {
  civil_start: "interval.civil_start_time",
  civil_end: "interval.civil_end_time",
  civil_sample: "sample_time.civil_time",
} as const;

export function buildFilter(info: DataTypeInfo, r: CivilRange): string {
  const name = info.id.replaceAll("-", "_"); // filters use snake_case ids
  if (info.filter === "date") {
    const endDate = r.end.endsWith("T00:00:00") ? r.end.slice(0, 10) : addDays(r.end.slice(0, 10), 1);
    return `${name}.date >= "${r.start.slice(0, 10)}" AND ${name}.date < "${endDate}"`;
  }
  const field = `${name}.${FILTER_FIELD[info.filter]}`;
  return `${field} >= "${r.start}" AND ${field} < "${r.end}"`;
}

export function buildRequest(
  info: DataTypeInfo,
  mode: Mode,
  r: CivilRange,
  tz: string,
  pageToken?: string,
): ApiRequest {
  const path = `/v4/users/me/dataTypes/${info.id}/dataPoints`;
  const page = pageToken ? { pageToken } : {};
  switch (mode) {
    case "raw":
    case "merged":
      return {
        method: "GET",
        path: mode === "raw" ? path : `${path}:reconcile`,
        query: { filter: buildFilter(info, r), pageSize: String(info.maxPageSize ?? MAX_POINTS), ...page },
      };
    case "daily":
      return {
        method: "POST",
        path: `${path}:dailyRollUp`,
        body: {
          range: { start: civilDateTime(r.start), end: civilDateTime(r.end) },
          windowSizeDays: 1,
          pageSize: MAX_POINTS,
          ...page,
        },
      };
    case "total": {
      const startTime = civilToUtc(r.start, tz);
      const endTime = civilToUtc(r.end, tz);
      const seconds = (Date.parse(endTime) - Date.parse(startTime)) / 1000;
      return {
        method: "POST",
        path: `${path}:rollUp`,
        body: { range: { startTime, endTime }, windowSize: `${seconds}s`, ...page },
      };
    }
  }
}

function civilDateTime(civil: string) {
  const [year, month, day] = civil.slice(0, 10).split("-").map(Number);
  const [hours, minutes, seconds] = civil.slice(11).split(":").map(Number);
  return { date: { year, month, day }, time: { hours, minutes, seconds } };
}

type Json = Record<string, unknown>;

/** Keeps what a chat model needs: the value fields and times; device source only in raw mode. */
export function trimResponse(info: DataTypeInfo, mode: Mode, body: Json): { points: Json[]; nextPageToken?: string } {
  const raw = (body.dataPoints ?? body.rollupDataPoints ?? []) as Json[];
  const valueKey = info.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()); // body-fat → bodyFat
  const points = raw.map((p) => {
    const { name: _name, dataPointName: _dpName, dataSource, [valueKey]: value, ...rest } = p;
    const out: Json = { ...rest, ...(isObject(value) ? value : value === undefined ? {} : { value }) };
    if (mode === "raw" && isObject(dataSource)) out.source = describeSource(dataSource);
    return out;
  });
  const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
  return next ? { points, nextPageToken: next } : { points };
}

function describeSource(s: Json): string {
  const device = isObject(s.device) ? s.device.displayName : undefined;
  return [s.platform, device, s.recordingMethod].filter(Boolean).join(" / ");
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 8: Run tests**

Run: `deno test -A src/sources/google-health/ && deno task check`
Expected: `ok | 15 passed | 0 failed`; check exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/sources/google-health/catalog.ts src/sources/google-health/catalog_test.ts src/sources/google-health/query.ts src/sources/google-health/query_test.ts
git commit -m "feat(google-health): add data type catalogue and query building"
```

---

### Task 6: Health API client and MCP tools

**Files:**
- Create: `src/sources/google-health/client.ts`, `src/sources/google-health/tools.ts`
- Test: `src/sources/google-health/tools_test.ts`

**Interfaces:**
- Consumes: `Ctx`; `getAccessToken`, `saveGoogleLogin`, `GoogleAuthExpiredError`, `GOOGLE_TOKEN_URL` (Task 2); `CATALOG`, `findType`, `Mode` (Task 5); `parseRange`, `chooseMode`, `buildRequest`, `trimResponse`, `todayIn`, `ApiRequest` (Task 5); `McpServer` from `src/sdk.ts`; test helpers (Task 1)
- Produces:
  - `client.ts`: `HEALTH_API = "https://health.googleapis.com"`, `class HealthApiError extends Error { status: number }`, `healthRequest(ctx, req: ApiRequest): Promise<Record<string, unknown>>` — one retry after 1 s on 429/5xx
  - `tools.ts`:
    - `interface HealthDataInput { type: string; from: string; to: string; mode?: Mode | "auto"; pageToken?: string }`
    - `getHealthData(ctx, input): Promise<{ type; mode; from; to; points; nextPageToken?; note? }>`
    - `getDailySummary(ctx, date?: string): Promise<{ date; summary; missing; errors? }>`
    - `listDataTypes(): { categories: Record<string, {id; kind; modes}[]>; modes: Record<Mode, string> }`
    - `registerTools(server: McpServer, ctx: Ctx): void` — registers `list_data_types`, `get_health_data`, `get_daily_summary`

- [ ] **Step 1: Write the failing tests** — `src/sources/google-health/tools_test.ts`

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../../ctx.ts";
import { GOOGLE_TOKEN_URL, GoogleAuthExpiredError, saveGoogleLogin } from "../../google/oauth.ts";
import { json, type Route, withCtx } from "../../testing.ts";
import { getDailySummary, getHealthData, listDataTypes } from "./tools.ts";

const API = "https://health.googleapis.com/v4/users/me/dataTypes";

async function withHealth(routes: Record<string, Route>, fn: (ctx: Ctx, calls: Request[]) => Promise<void>) {
  await withCtx({ routes }, async (ctx, calls) => {
    await saveGoogleLogin(ctx, {
      email: "owner@example.com",
      emailVerified: true,
      refreshToken: "r",
      accessToken: "ga",
      expiresAt: ctx.now() + 3600_000,
    });
    await fn(ctx, calls);
  });
}

Deno.test("listDataTypes groups the catalogue by category", () => {
  const { categories, modes } = listDataTypes();
  assert(categories.activity.some((t) => t.id === "steps"));
  assert(categories.sleep.some((t) => t.id === "sleep"));
  assertEquals(Object.keys(modes).sort(), ["daily", "merged", "raw", "total"]);
});

Deno.test("a week of steps uses dailyRollUp with the Google token and returns trimmed points", async () => {
  const routes = {
    [`POST ${API}/steps/dataPoints:dailyRollUp`]: async (req: Request) => {
      assertEquals(req.headers.get("authorization"), "Bearer ga");
      assertEquals((await req.json()).windowSizeDays, 1);
      return json({ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, steps: { countSum: "8000" } }] });
    },
  };
  await withHealth(routes, async (ctx) => {
    const res = await getHealthData(ctx, { type: "steps", from: "2026-09-01", to: "2026-09-07" });
    assertEquals(res.mode, "daily");
    assertEquals(res.points, [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, countSum: "8000" }]);
  });
});

Deno.test("weight uses reconcile with a civil filter; empty results carry a note", async () => {
  const routes = {
    [`GET ${API}/weight/dataPoints:reconcile`]: (req: Request) => {
      assertStringIncludes(new URL(req.url).searchParams.get("filter")!, 'weight.sample_time.civil_time >= "2026-09-01T00:00:00"');
      return json({ dataPoints: [] });
    },
  };
  await withHealth(routes, async (ctx) => {
    const res = await getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" });
    assertEquals(res.points, []);
    assertEquals(res.note, "No weight data in this range");
  });
});

Deno.test("bad input fails before any Google call", async () => {
  await withHealth({}, async (ctx, calls) => {
    await assertRejects(() => getHealthData(ctx, { type: "mood", from: "2026-09-01", to: "2026-09-02" }), RangeError, "list_data_types");
    await assertRejects(() => getHealthData(ctx, { type: "steps", from: "2026-09-08", to: "2026-09-01" }), RangeError, "must be before");
    await assertRejects(() => getHealthData(ctx, { type: "sleep", from: "2026-09-01", to: "2026-09-02", mode: "total" }), RangeError, "supports modes");
    assertEquals(calls.length, 0);
  });
});

Deno.test("a 403 names the scope the type needs", async () => {
  const routes = { [`GET ${API}/sleep/dataPoints:reconcile`]: () => json({ error: { status: "PERMISSION_DENIED" } }, 403) };
  await withHealth(routes, async (ctx) => {
    await assertRejects(
      () => getHealthData(ctx, { type: "sleep", from: "2026-09-01", to: "2026-09-01" }),
      Error,
      "googlehealth.sleep.readonly",
    );
  });
});

Deno.test("429 and 5xx are retried once", async () => {
  let n = 0;
  const flaky = { [`GET ${API}/weight/dataPoints:reconcile`]: () => (++n === 1 ? json({}, 429) : json({ dataPoints: [] })) };
  await withHealth(flaky, async (ctx) => {
    await getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" });
    assertEquals(n, 2);
  });
  const down = { [`GET ${API}/weight/dataPoints:reconcile`]: () => json({}, 503) };
  await withHealth(down, async (ctx, calls) => {
    await assertRejects(() => getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" }), Error, "503");
    assertEquals(calls.length, 2);
  });
});

Deno.test("daily summary collects metrics, lists missing ones, and isolates failures", async () => {
  const empty = () => json({ dataPoints: [] });
  const routes: Record<string, Route> = {
    [`POST ${API}/steps/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [{ steps: { countSum: "8000" } }] }),
    [`POST ${API}/distance/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [] }),
    [`GET ${API}/exercise/dataPoints:reconcile`]: empty,
    [`GET ${API}/sleep/dataPoints:reconcile`]: (req) => {
      assertStringIncludes(new URL(req.url).searchParams.get("filter")!, "sleep.interval.civil_end_time");
      return json({ dataPoints: [{ sleep: { interval: { civilEndTime: "x" } } }] });
    },
    [`GET ${API}/daily-resting-heart-rate/dataPoints:reconcile`]: () => json({}, 500),
    [`GET ${API}/daily-heart-rate-variability/dataPoints:reconcile`]: empty,
    [`GET ${API}/weight/dataPoints:reconcile`]: () =>
      json({ dataPoints: [{ weight: { kilograms: 80 } }, { weight: { kilograms: 81 } }] }),
    [`POST ${API}/hydration-log/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [] }),
  };
  await withHealth(routes, async (ctx) => {
    const res = await getDailySummary(ctx, "2026-09-28");
    assertEquals(res.date, "2026-09-28");
    assertEquals(res.summary.steps, { countSum: "8000" });
    assertEquals(res.summary.weight, { kilograms: 80 }); // latest only
    assertEquals(res.summary.sleep, { interval: { civilEndTime: "x" } });
    assertEquals(res.missing.sort(), ["daily-heart-rate-variability", "distance", "exercise", "hydration-log"]);
    assertStringIncludes(res.errors!["daily-resting-heart-rate"], "500");
  });
});

Deno.test("daily summary defaults to today in TZ", async () => {
  const empty = () => json({ dataPoints: [], rollupDataPoints: [] });
  const routes: Record<string, Route> = {};
  for (const [method, id, suffix] of [
    ["POST", "steps", "dailyRollUp"], ["POST", "distance", "dailyRollUp"], ["GET", "exercise", "reconcile"],
    ["GET", "sleep", "reconcile"], ["GET", "daily-resting-heart-rate", "reconcile"],
    ["GET", "daily-heart-rate-variability", "reconcile"], ["GET", "weight", "reconcile"],
    ["POST", "hydration-log", "dailyRollUp"],
  ]) routes[`${method} ${API}/${id}/dataPoints:${suffix}`] = empty;
  await withHealth(routes, async (ctx) => {
    ctx.now = () => Date.parse("2026-09-29T02:00:00Z"); // still Sept 28 in New York
    assertEquals((await getDailySummary(ctx)).date, "2026-09-28");
  });
});

Deno.test("expired Google access fails the whole summary with the reconnect message", async () => {
  const routes = { [`POST ${GOOGLE_TOKEN_URL}`]: () => json({ error: "invalid_grant" }, 400) };
  await withCtx({ routes }, async (ctx) => {
    await saveGoogleLogin(ctx, { email: "o", emailVerified: true, refreshToken: "r", accessToken: "a", expiresAt: 0 });
    await assertRejects(() => getDailySummary(ctx, "2026-09-28"), GoogleAuthExpiredError, "reconnect");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/sources/google-health/tools_test.ts`
Expected: FAIL — module `./tools.ts` not found.

- [ ] **Step 3: Implement `src/sources/google-health/client.ts`**

```ts
import type { Ctx } from "../../ctx.ts";
import { getAccessToken } from "../../google/oauth.ts";
import type { ApiRequest } from "./query.ts";

export const HEALTH_API = "https://health.googleapis.com";

export class HealthApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function healthRequest(ctx: Ctx, req: ApiRequest): Promise<Record<string, unknown>> {
  const url = new URL(req.path, HEALTH_API);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0;; attempt++) {
    const headers: Record<string, string> = { authorization: `Bearer ${await getAccessToken(ctx)}` };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    const res = await ctx.fetch(url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    if (res.ok) return await res.json();
    const detail = await res.text();
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await ctx.sleep(1000);
      continue;
    }
    throw new HealthApiError(res.status, `Google Health API ${res.status}: ${detail.slice(0, 300)}`);
  }
}
```

- [ ] **Step 4: Implement `src/sources/google-health/tools.ts`**

```ts
import { z } from "zod";
import type { Ctx } from "../../ctx.ts";
import { GoogleAuthExpiredError } from "../../google/oauth.ts";
import type { McpServer } from "../../sdk.ts";
import { CATALOG, findType, type Mode } from "./catalog.ts";
import { HealthApiError, healthRequest } from "./client.ts";
import { buildRequest, chooseMode, parseRange, todayIn, trimResponse } from "./query.ts";

export interface HealthDataInput {
  type: string;
  from: string;
  to: string;
  mode?: Mode | "auto";
  pageToken?: string;
}

const MODE_HELP: Record<Mode, string> = {
  raw: "individual points with the device that recorded them",
  merged: "points deduplicated across devices",
  daily: "one total per day",
  total: "one total for the whole range",
};

export function listDataTypes() {
  const categories: Record<string, { id: string; kind: string; modes: Mode[] }[]> = {};
  for (const t of CATALOG) (categories[t.category] ??= []).push({ id: t.id, kind: t.kind, modes: t.modes });
  return { categories, modes: MODE_HELP };
}

export async function getHealthData(ctx: Ctx, input: HealthDataInput) {
  const info = findType(input.type);
  if (!info) throw new RangeError(`Unknown type "${input.type}". Call list_data_types to see valid types.`);
  const range = parseRange(input.from, input.to);
  const mode = chooseMode(info, input.mode ?? "auto", range);
  let body: Record<string, unknown>;
  try {
    body = await healthRequest(ctx, buildRequest(info, mode, range, ctx.config.tz, input.pageToken));
  } catch (e) {
    if (e instanceof HealthApiError && e.status === 403) {
      throw new HealthApiError(403, `Google denied access to ${info.id}; it needs scope ${info.scope}. Reconnect and grant it. (${e.message})`);
    }
    throw e;
  }
  const { points, nextPageToken } = trimResponse(info, mode, body);
  return {
    type: info.id,
    mode,
    from: input.from,
    to: input.to,
    points,
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(points.length ? {} : { note: `No ${info.id} data in this range` }),
  };
}

const SUMMARY: { type: string; mode: Mode; latestOnly?: boolean }[] = [
  { type: "steps", mode: "daily" },
  { type: "distance", mode: "daily" },
  { type: "exercise", mode: "merged" },
  { type: "sleep", mode: "merged" }, // filters on end time: the night ending on this date
  { type: "daily-resting-heart-rate", mode: "merged" },
  { type: "daily-heart-rate-variability", mode: "merged" },
  { type: "weight", mode: "merged", latestOnly: true }, // points are newest first
  { type: "hydration-log", mode: "daily" },
];

export async function getDailySummary(ctx: Ctx, date?: string) {
  const day = date ?? todayIn(ctx.config.tz, ctx.now());
  const results = await Promise.allSettled(
    SUMMARY.map((m) => getHealthData(ctx, { type: m.type, from: day, to: day, mode: m.mode })),
  );
  const summary: Record<string, unknown> = {};
  const missing: string[] = [];
  const errors: Record<string, string> = {};
  for (const [i, r] of results.entries()) {
    const { type, latestOnly } = SUMMARY[i];
    if (r.status === "rejected") {
      if (r.reason instanceof GoogleAuthExpiredError) throw r.reason;
      errors[type] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    } else if (r.value.points.length === 0) {
      missing.push(type);
    } else {
      summary[type] = latestOnly || r.value.points.length === 1 ? r.value.points[0] : r.value.points;
    }
  }
  return { date: day, summary, missing, ...(Object.keys(errors).length ? { errors } : {}) };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

const DATE_HELP = "YYYY-MM-DD or YYYY-MM-DDTHH:mm, in the owner's local time";

export function registerTools(server: McpServer, ctx: Ctx): void {
  server.registerTool("list_data_types", {
    title: "List health data types",
    description:
      "Lists the Google Health data types this connector can read, grouped by category, with the read modes each supports. Call this first if unsure which type to query.",
    annotations: { readOnlyHint: true },
  }, () => ok(listDataTypes()));

  server.registerTool("get_health_data", {
    title: "Get health data",
    description:
      "Reads one Google Health data type over a date range. 'to' dates are inclusive. mode: auto (default: daily totals for multi-day activity ranges, otherwise merged points), raw, merged, daily, total. Large results return nextPageToken.",
    inputSchema: {
      type: z.string().describe("Data type id from list_data_types, e.g. steps, weight, sleep, heart-rate"),
      from: z.string().describe(`Start: ${DATE_HELP}`),
      to: z.string().describe(`End (inclusive for dates): ${DATE_HELP}`),
      mode: z.enum(["auto", "raw", "merged", "daily", "total"]).optional(),
      pageToken: z.string().optional().describe("nextPageToken from a previous call"),
    },
    annotations: { readOnlyHint: true },
  }, (args) => run(() => getHealthData(ctx, args)));

  server.registerTool("get_daily_summary", {
    title: "Get daily health summary",
    description:
      "One-call overview of a day: steps, distance, exercise, last night's sleep, resting heart rate, HRV, weight and hydration. Lists metrics with no data under 'missing'.",
    inputSchema: {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today in the owner's timezone"),
    },
    annotations: { readOnlyHint: true },
  }, ({ date }) => run(() => getDailySummary(ctx, date)));
}
```

- [ ] **Step 5: Run tests**

Run: `deno test -A src/sources/google-health/ && deno task check`
Expected: all google-health tests pass (`24 passed`); check exits 0. If `deno check` rejects a tool callback's return type, annotate the callback return as `Promise<ToolResult>` / `ToolResult` — do not add `any`.

- [ ] **Step 6: Commit**

```bash
git add src/sources/google-health/client.ts src/sources/google-health/tools.ts src/sources/google-health/tools_test.ts
git commit -m "feat(google-health): add Health API client and MCP tools"
```

---

### Task 7: MCP server, HTTP app, entrypoint, README

**Files:**
- Create: `src/mcp.ts`, `src/app.ts`, `src/main.ts`, `README.md`
- Modify: `docs/superpowers/specs/2026-09-29-google-health-mcp-connector-design.md` (record the spec deltas)
- Test: `src/app_test.ts`

**Interfaces:**
- Consumes: `handleAuthRoute`, `requireBearer` (Task 4); `registerTools` (Task 6); `SCOPES` (Task 5); `issueTokens` (Task 3); `saveGoogleLogin` (Task 2); `loadConfig`, `Ctx`, sdk, test helpers (Task 1)
- Produces:
  - `createMcpServer(ctx): McpServer`, `handleMcp(ctx, req): Promise<Response>`
  - `createHandler(ctx): (req: Request) => Promise<Response>`
  - `src/main.ts` — runnable entrypoint

- [ ] **Step 1: Write the failing integration tests** — `src/app_test.ts`

```ts
import { assert, assertEquals } from "@std/assert";
import { createHandler } from "./app.ts";
import { issueTokens } from "./auth/store.ts";
import { saveGoogleLogin } from "./google/oauth.ts";
import { Client, StreamableHTTPClientTransport } from "./sdk.ts";
import { json, withCtx } from "./testing.ts";

const BASE = "https://conn.example.com";
const API = "https://health.googleapis.com/v4/users/me/dataTypes";

Deno.test("unauthenticated /mcp gets 401 pointing at resource metadata", async () => {
  await withCtx({}, async (ctx) => {
    const res = await createHandler(ctx)(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }));
    assertEquals(res.status, 401);
    assert(res.headers.get("www-authenticate")?.includes("oauth-protected-resource"));
  });
});

Deno.test("root, metadata and unknown paths", async () => {
  await withCtx({}, async (ctx) => {
    const handler = createHandler(ctx);
    assertEquals((await handler(new Request(`${BASE}/`))).status, 200);
    const meta = await handler(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    assertEquals((await meta.json()).issuer, BASE);
    assertEquals((await handler(new Request(`${BASE}/nope`))).status, 404);
  });
});

Deno.test("MCP client lists read-only tools and calls get_health_data over Streamable HTTP", async () => {
  const routes = {
    [`POST ${API}/steps/dataPoints:dailyRollUp`]: () =>
      json({ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, steps: { countSum: "8000" } }] }),
  };
  await withCtx({ routes }, async (ctx) => {
    await saveGoogleLogin(ctx, {
      email: "owner@example.com",
      emailVerified: true,
      refreshToken: "r",
      accessToken: "ga",
      expiresAt: ctx.now() + 3600_000,
    });
    const { access_token } = await issueTokens(ctx.kv, "client-1", ctx.now());
    const handler = createHandler(ctx);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)),
        requestInit: { headers: { authorization: `Bearer ${access_token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      assertEquals(tools.map((t) => t.name).sort(), ["get_daily_summary", "get_health_data", "list_data_types"]);
      assert(tools.every((t) => t.annotations?.readOnlyHint === true));

      const res = await client.callTool({ name: "get_health_data", arguments: { type: "steps", from: "2026-09-01", to: "2026-09-07" } });
      const data = JSON.parse((res.content as { text: string }[])[0].text);
      assertEquals(data.mode, "daily");
      assertEquals(data.points[0].countSum, "8000");

      const bad = await client.callTool({ name: "get_health_data", arguments: { type: "steps", from: "2026-09-08", to: "2026-09-01" } });
      assertEquals(bad.isError, true);
    } finally {
      await client.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A src/app_test.ts`
Expected: FAIL — module `./app.ts` not found.

- [ ] **Step 3: Implement `src/mcp.ts`**

```ts
import type { Ctx } from "./ctx.ts";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "./sdk.ts";
import { registerTools as registerGoogleHealthTools } from "./sources/google-health/tools.ts";

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "agent-connectors", version: "0.1.0" });
  registerGoogleHealthTools(server, ctx);
  return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON responses. */
export async function handleMcp(ctx: Ctx, req: Request): Promise<Response> {
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return await transport.handleRequest(req);
}
```

- [ ] **Step 4: Implement `src/app.ts`**

```ts
import { handleAuthRoute, requireBearer } from "./auth/routes.ts";
import type { Ctx } from "./ctx.ts";
import { handleMcp } from "./mcp.ts";
import { SCOPES } from "./sources/google-health/catalog.ts";

export function createHandler(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") return (await requireBearer(ctx, req)) ?? (await handleMcp(ctx, req));
      const auth = await handleAuthRoute(ctx, req, SCOPES);
      if (auth) return auth;
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(`agent-connectors MCP server. Connector URL: ${ctx.config.baseUrl}/mcp\n`);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("Internal error", { status: 500 });
    }
  };
}
```

- [ ] **Step 5: Implement `src/main.ts`**

```ts
import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig((name) => Deno.env.get(name));
const kv = await Deno.openKv();

Deno.serve(createHandler({
  config,
  kv,
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
```

- [ ] **Step 6: Run the full suite and type-check**

Run: `deno task test && deno task check`
Expected: all tests pass (`55 passed | 0 failed`); check exits 0.

- [ ] **Step 7: Smoke-test the entrypoint locally**

Run:
```bash
GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=y ALLOWED_EMAIL=me@example.com BASE_URL=http://localhost:8000 \
  timeout 5 deno task start & sleep 3
curl -s http://localhost:8000/.well-known/oauth-authorization-server
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/mcp
wait
```
Expected: the metadata JSON with `"issuer":"http://localhost:8000"`, then `401`.
Also run once with `ALLOWED_EMAIL` unset and confirm it exits with `Missing required env vars: ALLOWED_EMAIL`.

- [ ] **Step 8: Write `README.md`**

````markdown
# agent-connectors

Personal chat connectors (remote MCP servers) built with Deno. The first one lets
ChatGPT or Claude read your data from the Google Health app.

Design: `docs/superpowers/specs/2026-09-29-google-health-mcp-connector-design.md`

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

6. **Add the connector** — ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode, then *Create* with URL `https://my-health.deno.dev/mcp` and OAuth authentication. Claude: Settings → Connectors → *Add custom connector* with the same URL. Sign in with your Google account when prompted.

**Weekly re-login:** while the Google app is in *Testing*, Google expires its refresh token after 7 days. The server then asks your chat app to reconnect; sign in again.

## Development

```bash
deno task test    # offline test suite
deno task check   # type-check
deno task dev     # run locally on :8000 (needs the env vars above)
```

Try it with MCP Inspector: `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL `http://localhost:8000/mcp`.
````

- [ ] **Step 9: Record the spec deltas in the spec**

In `docs/superpowers/specs/2026-09-29-google-health-mcp-connector-design.md`:

Replace the three-item scope list under "Our server → Google" with:
```markdown
- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.nutrition.readonly` (needed for `hydration-log`)
```

Replace the "Builds the filter by kind" bullet under `get_health_data` with:
```markdown
- Builds the filter on civil (local) time, with the type id in snake_case: intervals and
  sessions `{type}.interval.civil_start_time`, sleep `sleep.interval.civil_end_time`,
  samples `{type}.sample_time.civil_time`, daily types `{type}.date`. Only `total`
  (`rollUp`, which takes UTC timestamps) converts local time with `TZ`.
```

- [ ] **Step 10: Commit**

```bash
git add src/mcp.ts src/app.ts src/main.ts src/app_test.ts README.md docs/superpowers/specs/
git commit -m "feat: wire MCP server and HTTP app, add entrypoint and setup README"
```
