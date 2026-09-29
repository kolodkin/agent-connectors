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
