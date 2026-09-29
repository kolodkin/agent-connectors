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
