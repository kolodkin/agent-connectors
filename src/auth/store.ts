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
