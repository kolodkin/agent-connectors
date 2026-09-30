import type { Config } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import type { GoogleLogin } from "./google/oauth.ts";

export const TEST_CONFIG: Config = {
  googleClientId: "gcid",
  googleClientSecret: "gsecret",
  allowedEmail: "owner@example.com",
  baseUrl: "https://conn.example.com",
  tz: "America/New_York",
};

export const TEST_NOW = Date.parse("2026-09-29T12:00:00Z");

/** The allowed owner's Google login, valid for an hour from TEST_NOW. */
export function ownerLogin(over: Partial<GoogleLogin> = {}): GoogleLogin {
  return {
    email: TEST_CONFIG.allowedEmail,
    emailVerified: true,
    refreshToken: "r1",
    accessToken: "a1",
    expiresAt: TEST_NOW + 3600_000,
    ...over,
  };
}

export type Route = (req: Request) => Response | Promise<Response>;

/** Fake fetch. Routes are keyed "METHOD https://host/path" (query string ignored). */
function fakeFetch(routes: Record<string, Route>) {
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

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** Unsigned JWT whose payload is `claims` (base64url, no padding). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    new TextEncoder().encode(JSON.stringify(o)).toBase64({ alphabet: "base64url", omitPadding: true });
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

/** Runs `fn` with an in-memory KV and fake fetch; `calls` records outgoing requests. */
export async function withCtx(
  opts: { routes?: Record<string, Route>; now?: number; config?: Partial<Config> },
  fn: (ctx: Ctx, calls: Request[]) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const fake = fakeFetch(opts.routes ?? {});
  const now = opts.now ?? TEST_NOW;
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
