import { OPENWIKI_MCP_PROTOCOL_VERSION } from "@openwiki/core";
export const MCP_PROTOCOL_VERSION = OPENWIKI_MCP_PROTOCOL_VERSION;
export type { McpToolMode, McpServerOptions } from "./types.ts";
export { handleMcpRequest } from "./handler.ts";
export { runMcpStdioServer } from "./stdio.ts";
