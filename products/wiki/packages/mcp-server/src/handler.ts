
import { callTool } from "./tool-router.ts";
import { PROMPT_DEFINITIONS } from "./prompt-definitions.ts";
import { listResources, readResource } from "./resources.ts";
import { readPrompt } from "./prompts.ts";
import { objectParams } from "./params.ts";
import { toolsForPolicy } from "./policy-adapter.ts";
import { MCP_PROTOCOL_VERSION, type JsonRpcRequest, type McpServerOptions } from "./types.ts";

export async function handleMcpRequest(
  root: string,
  request: JsonRpcRequest,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds"> = {},
): Promise<unknown> {
  return handleRequest(root, request, options);
}

export async function handleRequest(
  root: string,
  request: JsonRpcRequest,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<unknown> {
  const toolMode = options.toolMode ?? "read";
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: "openwiki",
          version: "0.0.0",
        },
        instructions: "Use OpenWiki tools to search, read, and cite the workspace knowledge base.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: await toolsForPolicy(root, { ...options, toolMode }) };
    case "tools/call":
      return callTool(root, objectParams(request.params), options);
    case "resources/list":
      return listResources(root, options);
    case "resources/read":
      return readResource(root, objectParams(request.params), options);
    case "prompts/list":
      return { prompts: PROMPT_DEFINITIONS };
    case "prompts/get":
      return readPrompt(objectParams(request.params));
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}
