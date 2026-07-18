
import type { Writable } from "node:stream";
import { InvalidGitRevisionError } from "@openwiki/git";
import { OpenWikiError, openWikiMcpJsonRpcCodeForError } from "@openwiki/core";

export function writeMessage(output: Writable, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

export function jsonRpcError(id: string | number | undefined, code: number, message: string): unknown {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

export function mcpErrorCode(error: unknown): number {
  if (error instanceof InvalidGitRevisionError) {
    return -32602;
  }
  if (error instanceof OpenWikiError) {
    return openWikiMcpJsonRpcCodeForError(error);
  }
  return -32603;
}
