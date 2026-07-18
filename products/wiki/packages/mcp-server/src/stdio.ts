import readline from "node:readline";

import { writeMessage, jsonRpcError, mcpErrorCode } from "./json-rpc.ts";
import { handleRequest } from "./handler.ts";
import type { JsonRpcRequest, McpServerOptions } from "./types.ts";

export async function runMcpStdioServer(options: McpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeMessage(output, jsonRpcError(undefined, -32700, "Parse error"));
      continue;
    }

    if (!("id" in request)) {
      if (request.method !== "notifications/initialized") {
        // Notifications do not receive responses by JSON-RPC design.
      }
      continue;
    }

    try {
      const result = await handleRequest(options.root, request, options);
      writeMessage(output, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMessage(output, jsonRpcError(request.id, mcpErrorCode(error), message));
    }
  }
}
