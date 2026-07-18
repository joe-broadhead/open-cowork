import type { Readable, Writable } from "node:stream";
import { OPENWIKI_MCP_PROTOCOL_VERSION, OPENWIKI_MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES, type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";
import type { PolicyBounds } from "@openwiki/policy";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface McpServerOptions {
  root: string;
  input?: Readable;
  output?: Writable;
  toolMode?: McpToolMode;
  actorId?: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  token?: string;
  principals?: string[];
  bounds?: PolicyBounds;
}

export const MCP_PROTOCOL_VERSION = OPENWIKI_MCP_PROTOCOL_VERSION;
export type McpToolMode = "read" | "proposal" | "write";

export type McpPolicyContext = { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[]; bounds?: PolicyBounds };

export const MCP_LIST_LIMIT_MAX = 500;
export const MCP_PROPOSAL_LIMIT_MAX = 200;
export const MCP_GRAPH_LIST_LIMIT_MAX = 500;
export const MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES = OPENWIKI_MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES;
export const MCP_TOOL_OUTPUT_MIN_MAX_BYTES = 1024;
export const MCP_TOOL_OUTPUT_HARD_MAX_BYTES = 2 * 1024 * 1024;
export const MCP_TOOL_OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
