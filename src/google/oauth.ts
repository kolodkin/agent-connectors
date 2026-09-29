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

export function buildGoogleAuthUrl(ctx: Ctx, state: string, scopes: string[]): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: ctx.config.googleClientId,
    redirect_uri: googleRedirectUri(ctx),
    response_type: "code",
    scope: ["openid", "email", ...scopes].join(" "),
    access_type: "offline",
    login_hint: ctx.config.allowedEmail,
    // Refresh tokens come only with consent; always asking replaces a possibly dead one.
    prompt: "consent",
    state,
  }).toString();
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
