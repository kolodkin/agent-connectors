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

Deno.test("GET and DELETE on /mcp are 405 in stateless mode (no dangling SSE stream)", async () => {
  await withCtx({}, async (ctx) => {
    const handler = createHandler(ctx);
    for (const method of ["GET", "DELETE"]) {
      const res = await handler(new Request(`${BASE}/mcp`, { method }));
      assertEquals(res.status, 405, method);
      assertEquals(res.headers.get("allow"), "POST");
    }
  });
});
