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
