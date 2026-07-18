

import { MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES, MCP_TOOL_OUTPUT_HARD_MAX_BYTES, MCP_TOOL_OUTPUT_MIN_MAX_BYTES, MCP_TOOL_OUTPUT_PREVIEW_MAX_BYTES } from "./types.ts";

export function toolResult(value: unknown): unknown {
  const text = JSON.stringify(value, null, 2);
  const originalBytes = Buffer.byteLength(text, "utf8");
  const limitBytes = mcpToolOutputMaxBytes();
  if (originalBytes > limitBytes) {
    const notice = `\n\n[OpenWiki MCP output truncated: ${originalBytes} bytes exceeded the ${limitBytes} byte limit. Narrow the query, lower limit, use offset/cursor pagination where available, or read a more specific record.]`;
    const previewLimit = Math.max(0, limitBytes - Buffer.byteLength(notice, "utf8"));
    const previewText = truncateUtf8(text, previewLimit);
    const structuredPreview = truncateUtf8(text, Math.min(MCP_TOOL_OUTPUT_PREVIEW_MAX_BYTES, previewLimit));
    return {
      content: [
        {
          type: "text",
          text: `${previewText}${notice}`,
        },
      ],
      structuredContent: {
        truncated: true,
        output_limit_bytes: limitBytes,
        original_bytes: originalBytes,
        preview_json: structuredPreview,
        guidance: [
          "Use tool-specific limit parameters before requesting broad lists.",
          "Use offset or cursor pagination where the tool supports it.",
          "Read specific records by ID instead of returning full search or graph neighborhoods.",
        ],
      },
      isError: false,
      _meta: {
        openwiki: {
          truncated: true,
          output_limit_bytes: limitBytes,
          original_bytes: originalBytes,
        },
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: value,
    isError: false,
  };
}

function mcpToolOutputMaxBytes(): number {
  const raw = process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES;
  }
  return Math.min(MCP_TOOL_OUTPUT_HARD_MAX_BYTES, Math.max(MCP_TOOL_OUTPUT_MIN_MAX_BYTES, Math.trunc(parsed)));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

export function resourceContents(uri: string, value: unknown): unknown {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
