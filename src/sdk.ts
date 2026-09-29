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
