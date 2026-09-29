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
