
import { OPENWIKI_MCP_PROTOCOL_VERSION, OPENWIKI_MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES } from "@openwiki/core";
import { mcpToolModeOperations } from "@openwiki/policy";

import type { McpManifestDocument } from "./types.ts";

export function mcpManifest(): McpManifestDocument {
  return {
    name: "openwiki",
    version: "0.0.0",
    transport: ["stdio", "http", "streamable_http"],
    http_endpoint: "/mcp",
    http_transport: {
      type: "streamable_http",
      protocol_version: OPENWIKI_MCP_PROTOCOL_VERSION,
      methods: ["GET", "POST", "DELETE"],
      session_header: "MCP-Session-Id",
      protocol_version_header: "MCP-Protocol-Version",
    },
    default_tool_mode: "read",
    tool_output: {
      default_max_bytes: OPENWIKI_MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES,
      environment_variable: "OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES",
      behavior: "Tool calls that exceed the configured byte limit return a truncation envelope with preview_json and guidance.",
    },
    tool_modes: {
      read: mcpToolModeOperations("read"),
      proposal: mcpToolModeOperations("proposal"),
      write: mcpToolModeOperations("write"),
    },
    resources: [
      "openwiki://index",
      "openwiki://recent-changes",
      "openwiki://events",
      "openwiki://runs",
      "openwiki://topics",
      "openwiki://open-questions",
      "openwiki://graph",
      "openwiki://page/{page_id}",
      "openwiki://source/{source_id}",
      "openwiki://claim/{claim_id}",
      "openwiki://fact/{fact_id}",
      "openwiki://take/{take_id}",
      "openwiki://proposal/{proposal_id}",
      "openwiki://comment/{comment_id}",
      "openwiki://decision/{decision_id}",
      "openwiki://commit/{sha}",
    ],
    prompts: [
      "answer_with_citations",
      "research_topic",
      "review_edit",
      "ingest_source",
      "create_synthesis_page",
      "compare_sources",
      "find_contradictions",
      "prepare_briefing",
    ],
  };
}
