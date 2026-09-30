import { handleAuthRoute, requireBearer } from "./auth/routes.ts";
import type { Ctx } from "./ctx.ts";
import { handleMcp } from "./mcp.ts";
import { SCOPES } from "./sources/google-health/catalog.ts";

export function createHandler(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") {
        // Stateless server: no SSE stream (GET) or session to delete (DELETE) — POST only.
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
        return (await requireBearer(ctx, req)) ?? (await handleMcp(ctx, req));
      }
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
