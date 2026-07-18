import { OPENWIKI_MCP_PROTOCOL_VERSION } from "@openwiki/core";

import {
  queryParameter,
  pathParameter,
  headerParameter,
  auditFilterParameters,
  jsonRequestBody,
  jsonResponse,
  mcpJsonOrEventStreamResponse,
  metricsResponse,
  eventStreamResponse,
  openApiSchemas,
} from "./openapi-helpers.ts";
import type { OpenApiDocument } from "./types.ts";

export function openApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenWiki API",
      version: "0.0.0",
    },
    paths: {
      "/livez": {
        get: { responses: { "200": jsonResponse("Liveness probe", "HealthProbeResponse") } },
      },
      "/api/v1/livez": {
        get: { responses: { "200": jsonResponse("Liveness probe", "HealthProbeResponse") } },
      },
      "/readyz": {
        get: {
          responses: {
            "200": jsonResponse("Readiness probe", "ReadinessProbeResponse"),
            "503": jsonResponse("Readiness probe", "ReadinessProbeResponse"),
          },
        },
      },
      "/api/v1/readyz": {
        get: {
          responses: {
            "200": jsonResponse("Readiness probe", "ReadinessProbeResponse"),
            "503": jsonResponse("Readiness probe", "ReadinessProbeResponse"),
          },
        },
      },
      "/healthz": {
        get: { responses: { "200": jsonResponse("Component health", "HealthResponse") } },
      },
      "/api/v1/health": {
        get: { responses: { "200": jsonResponse("Component health", "HealthResponse") } },
      },
      "/metrics": {
        get: { responses: { "200": metricsResponse("Prometheus metrics") } },
      },
      "/api/v1/metrics": {
        get: { responses: { "200": metricsResponse("Prometheus metrics") } },
      },
      "/mcp": {
        get: {
          parameters: [
            headerParameter("Accept", "Must include text/event-stream for Streamable HTTP server-to-client streams", {
              type: "string",
            }, true),
            headerParameter("MCP-Protocol-Version", "Negotiated MCP protocol version", {
              type: "string",
              enum: [OPENWIKI_MCP_PROTOCOL_VERSION],
            }),
            headerParameter("MCP-Session-Id", "Session ID returned by a prior initialize response", { type: "string" }, true),
          ],
          responses: {
            "200": eventStreamResponse("MCP server-to-client SSE stream"),
            "400": jsonResponse("Missing MCP session", "McpJsonRpcResponse"),
            "404": jsonResponse("Unknown MCP session", "McpJsonRpcResponse"),
            "406": jsonResponse("Missing text/event-stream Accept header", "McpJsonRpcResponse"),
          },
        },
        post: {
          parameters: [
            queryParameter("tools", "Enabled MCP tool tier for this request", {
              type: "string",
              enum: ["read", "proposal", "write"],
            }),
            headerParameter("Accept", "Streamable HTTP clients should send application/json, text/event-stream", {
              type: "string",
            }),
            headerParameter("MCP-Protocol-Version", "Negotiated MCP protocol version", {
              type: "string",
              enum: [OPENWIKI_MCP_PROTOCOL_VERSION],
            }),
            headerParameter("MCP-Session-Id", "Session ID returned by initialize; optional for one-shot compatibility", {
              type: "string",
            }),
          ],
          responses: {
            "200": mcpJsonOrEventStreamResponse("MCP JSON-RPC response"),
            "202": { description: "Accepted JSON-RPC notification" },
            "400": jsonResponse("Invalid JSON-RPC request", "McpJsonRpcResponse"),
            "403": jsonResponse("Invalid Origin header", "McpJsonRpcResponse"),
            "404": jsonResponse("Unknown MCP session", "McpJsonRpcResponse"),
          },
        },
        delete: {
          parameters: [
            headerParameter("MCP-Protocol-Version", "Negotiated MCP protocol version", {
              type: "string",
              enum: [OPENWIKI_MCP_PROTOCOL_VERSION],
            }),
            headerParameter("MCP-Session-Id", "Session ID returned by initialize", { type: "string" }, true),
          ],
          responses: {
            "204": { description: "MCP session terminated" },
            "400": jsonResponse("Missing MCP session", "McpJsonRpcResponse"),
            "404": jsonResponse("Unknown MCP session", "McpJsonRpcResponse"),
          },
        },
      },
      "/api/v1/capabilities": {
        get: { responses: { "200": jsonResponse("Capabilities", "CapabilitiesResponse") } },
      },
      "/api/v1/openapi.json": {
        get: { responses: { "200": { description: "OpenAPI document" } } },
      },
      "/openapi.json": {
        get: { responses: { "200": { description: "OpenAPI document" } } },
      },
      "/api/v1/mcp-manifest": {
        get: { responses: { "200": { description: "MCP manifest" } } },
      },
      "/mcp-manifest.json": {
        get: { responses: { "200": { description: "MCP manifest" } } },
      },
      "/api/v1/policy": {
        get: { responses: { "200": jsonResponse("OpenWiki policy", "PolicyResponse") } },
      },
      "/api/v1/policy/identities": {
        get: { responses: { "200": jsonResponse("Policy identity summary", "PolicyIdentitiesResponse") } },
      },
      "/api/v1/policy/preview": {
        get: {
          parameters: [
            queryParameter("actor_id", "Actor ID to preview"),
            queryParameter("role", "Role to preview"),
            queryParameter("scope", "Scope to preview; may be repeated"),
            queryParameter("principal", "Principal to preview; may be repeated"),
            queryParameter("group", "Group name or group principal to preview; may be repeated"),
            queryParameter("target_path", "Repository path to preview"),
            queryParameter("target", "Record ID to preview"),
            queryParameter("target_id", "Record ID to preview"),
            queryParameter("operation", "OpenWiki operation to preview"),
          ],
          responses: { "200": jsonResponse("Permission preview", "PermissionPreviewResponse") },
        },
      },
      "/api/v1/policy/proposals": {
        post: { responses: { "201": jsonResponse("Created policy proposal", "ProposePolicyResponse") } },
      },
      "/api/v1/policy/sections/proposals": {
        post: { responses: { "201": jsonResponse("Created section policy proposal", "ProposeSectionPolicyResponse") } },
      },
      "/api/v1/auth/service-accounts": {
        get: { responses: { "200": jsonResponse("Sanitized service-account list", "ServiceAccountListResponse") } },
        post: { responses: { "201": jsonResponse("Created service-account token", "ServiceAccountTokenResponse") } },
      },
      "/api/v1/auth/service-accounts/{id}": {
        get: {
          parameters: [pathParameter("id", "Service-account id")],
          responses: { "200": jsonResponse("Sanitized service-account metadata", "ServiceAccountInspectResponse") },
        },
      },
      "/api/v1/auth/service-accounts/{id}/revoke": {
        post: {
          parameters: [pathParameter("id", "Service-account id")],
          responses: { "200": jsonResponse("Revoked service-account token metadata", "ServiceAccountRevokeResponse") },
        },
      },
      "/api/v1/auth/service-accounts/{id}/rotate": {
        post: {
          parameters: [pathParameter("id", "Service-account id")],
          responses: { "200": jsonResponse("Rotated service-account token", "ServiceAccountTokenResponse") },
        },
      },
      "/api/v1/workspaces": {
        get: { responses: { "200": jsonResponse("Workspace registry", "WorkspaceRegistryResponse") } },
      },
      "/api/v1/index": {
        get: { responses: { "200": jsonResponse("Workspace index summary", "WorkspaceIndexResponse") } },
      },
      "/api/v1/workspaces/connect": {
        post: { responses: { "200": jsonResponse("Connected workspace Git repo", "WorkspaceConnectResponse") } },
      },
      "/api/v1/search": {
        get: {
          parameters: [
            queryParameter("q", "Search query"),
            queryParameter("limit", "Maximum result count", { type: "integer", minimum: 1 }),
            queryParameter("offset", "Result offset", { type: "integer", minimum: 0 }),
            queryParameter("cursor", "Opaque search pagination cursor returned as next_cursor"),
            queryParameter("type", "Filter to one record type"),
            queryParameter("persona", "Search persona"),
            queryParameter("mode", "Search mode", { type: "string", enum: ["lexical", "hybrid"] }),
            queryParameter("fuzzy", "Enable fuzzy retriever", { type: "boolean" }),
            queryParameter("highlights", "Include matched text snippets", { type: "boolean" }),
            queryParameter("explain", "Include ranking diagnostics", { type: "boolean" }),
          ],
          responses: { "200": jsonResponse("Search results", "SearchResponse") },
        },
      },
      "/api/v1/records": {
        get: {
          parameters: [
            queryParameter("type", "Filter to one record type"),
            queryParameter("prefix", "Filter records by ID, title, or path substring"),
            queryParameter("limit", "Maximum record count", { type: "integer", minimum: 1 }),
            queryParameter("cursor", "Opaque record pagination cursor returned as next_cursor"),
          ],
          responses: { "200": jsonResponse("Record listing", "RecordsListResponse") },
        },
      },
      "/api/v1/ask": {
        post: {
          requestBody: jsonRequestBody("AskRequest"),
          responses: { "200": jsonResponse("Answer with citations", "AnswerResponse") },
        },
      },
      "/api/v1/think": {
        post: {
          requestBody: jsonRequestBody("ThinkRequest"),
          responses: { "200": jsonResponse("Cited synthesis with gaps and diagnostics", "ThinkResponse") },
        },
      },
      "/api/v1/recall": {
        post: {
          responses: { "200": { description: "Policy-visible recall results with hot memory" } },
        },
      },
      "/api/v1/lint": {
        post: {
          responses: {
            "200": jsonResponse("Repository validation report", "RepositoryValidationReport"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/topics": { get: { responses: { "200": { description: "Topic summaries" } } } },
      "/api/v1/open-questions": { get: { responses: { "200": { description: "Open questions" } } } },
      "/api/v1/inbox/items": {
        get: { responses: { "200": jsonResponse("Inbox items", "InboxItemsResponse") } },
        post: { responses: { "201": jsonResponse("Submitted inbox item", "SubmitInboxItemResponse") } },
      },
      "/api/v1/inbox/items/{id}": {
        get: { responses: { "200": jsonResponse("Inbox item detail", "InboxItemResponse") } },
      },
      "/api/v1/inbox/items/{id}/process": {
        post: { responses: { "200": jsonResponse("Processed inbox item", "ProcessInboxItemResponse") } },
      },
      "/api/v1/inbox/items/{id}/ignore": {
        post: { responses: { "200": jsonResponse("Ignored inbox item", "InboxStatusResponse") } },
      },
      "/api/v1/inbox/items/{id}/retry": {
        post: { responses: { "200": jsonResponse("Retried inbox item", "InboxStatusResponse") } },
      },
      "/api/v1/governance/detectors": {
        get: {
          parameters: [
            queryParameter("detector", "Detector to run; may be repeated", {
              type: "string",
              enum: ["stale_claim", "missing_source", "broken_link", "orphan_page"],
            }),
            queryParameter("stale_after_days", "Claim verification age threshold in days", {
              type: "integer",
              minimum: 1,
            }),
          ],
          responses: { "200": jsonResponse("Governance detector report", "GovernanceDetectorReport") },
        },
      },
      "/api/v1/graph": { get: { responses: { "200": { description: "Workspace graph" } } } },
      "/api/v1/graph/{id}/neighbors": { get: { responses: { "200": { description: "Graph neighbors" } } } },
      "/api/v1/graph/{id}/backlinks": { get: { responses: { "200": { description: "Graph backlinks" } } } },
      "/api/v1/graph/{id}/related": { get: { responses: { "200": { description: "Graph related records" } } } },
      "/api/v1/graph/path": { get: { responses: { "200": { description: "Graph path" } } } },
      "/api/v1/graph/orphans": { get: { responses: { "200": { description: "Graph orphan pages" } } } },
      "/api/v1/graph/stale": { get: { responses: { "200": { description: "Graph stale claims" } } } },
      "/api/v1/graph/report": {
        get: {
          parameters: [
            queryParameter("limit", "Maximum report items per section", { type: "integer", minimum: 1, maximum: 100 }),
          ],
          responses: { "200": jsonResponse("Graph intelligence report", "GraphAnalysisResponse") },
        },
      },
      "/api/v1/pages/{id}": { get: { responses: { "200": { description: "Page record" } } } },
      "/api/v1/pages/{id}/history": { get: { responses: { "200": { description: "Page history" } } } },
      "/api/v1/pages/{id}/diff": { get: { responses: { "200": { description: "Page diff" } } } },
      "/api/v1/sources": { get: { responses: { "200": { description: "Source records" } } } },
      "/api/v1/sources/{id}": { get: { responses: { "200": { description: "Source record" } } } },
      "/api/v1/sources/{id}/content": { get: { responses: { "200": { description: "Source content" } } } },
      "/api/v1/sources/{id}/history": { get: { responses: { "200": { description: "Source history" } } } },
      "/api/v1/sources/{id}/diff": { get: { responses: { "200": { description: "Source diff" } } } },
      "/api/v1/sources/ingest": { post: { responses: { "201": { description: "Ingested source" } } } },
      "/api/v1/sources/propose": {
        post: { responses: { "201": jsonResponse("Created source proposal", "ProposeSourceResponse") } },
      },
      "/api/v1/sources/fetch": {
        post: {
          responses: {
            "202": { description: "Queued source fetch" },
            "201": { description: "Fetched and ingested source when wait=true" },
          },
        },
      },
      "/api/v1/claims/{id}": { get: { responses: { "200": { description: "Claim record" } } } },
      "/api/v1/claims/{id}/trace": { get: { responses: { "200": { description: "Claim trace" } } } },
      "/api/v1/claims/{id}/history": { get: { responses: { "200": { description: "Claim history" } } } },
      "/api/v1/claims/{id}/diff": { get: { responses: { "200": { description: "Claim diff" } } } },
      "/api/v1/facts": {
        get: { responses: { "200": { description: "Fact records" } } },
      },
      "/api/v1/facts/proposals": {
        post: { responses: { "201": { description: "Created fact proposal" } } },
      },
      "/api/v1/facts/{id}": {
        get: { parameters: [pathParameter("id", "Fact ID")], responses: { "200": { description: "Fact record" } } },
      },
      "/api/v1/facts/{id}/history": { get: { responses: { "200": { description: "Fact history" } } } },
      "/api/v1/facts/{id}/diff": { get: { responses: { "200": { description: "Fact diff" } } } },
      "/api/v1/facts/{id}/forget": {
        post: { parameters: [pathParameter("id", "Fact ID")], responses: { "201": { description: "Created forget-fact proposal" } } },
      },
      "/api/v1/takes": {
        get: { responses: { "200": { description: "Take records" } } },
      },
      "/api/v1/takes/scorecard": {
        get: { responses: { "200": { description: "Take scoring aggregates" } } },
      },
      "/api/v1/takes/proposals": {
        post: { responses: { "201": { description: "Created take proposal" } } },
      },
      "/api/v1/takes/{id}": {
        get: { parameters: [pathParameter("id", "Take ID")], responses: { "200": { description: "Take record" } } },
      },
      "/api/v1/takes/{id}/history": { get: { responses: { "200": { description: "Take history" } } } },
      "/api/v1/takes/{id}/diff": { get: { responses: { "200": { description: "Take diff" } } } },
      "/api/v1/takes/{id}/resolve": {
        post: { parameters: [pathParameter("id", "Take ID")], responses: { "201": { description: "Created resolve-take proposal" } } },
      },
      "/api/v1/trajectory": {
        get: { responses: { "200": { description: "Record or query trajectory timeline" } } },
      },
      "/api/v1/proposals": {
        get: { responses: { "200": { description: "Proposal queue" } } },
        post: { responses: { "201": { description: "Created proposal" } } },
      },
      "/api/v1/synthesis": { post: { responses: { "201": { description: "Created synthesis proposal" } } } },
      "/api/v1/synthesis/create": {
        post: { responses: { "201": jsonResponse("Created and applied synthesis page", "CreateSynthesisResponse") } },
      },
      "/api/v1/proposals/{id}": { get: { responses: { "200": { description: "Proposal record" } } } },
      "/api/v1/proposals/{id}/detail": { get: { responses: { "200": { description: "Proposal detail" } } } },
      "/api/v1/proposals/{id}/diff": { get: { responses: { "200": { description: "Proposal diff" } } } },
      "/api/v1/proposals/{id}/snapshot": { get: { responses: { "200": { description: "Proposal snapshot" } } } },
      "/api/v1/proposals/{id}/validation": { get: { responses: { "200": { description: "Proposal validation report" } } } },
      "/api/v1/proposals/{id}/comments": {
        get: { responses: { "200": jsonResponse("Proposal comments", "ProposalCommentsResponse") } },
        post: { responses: { "201": jsonResponse("Created proposal comment", "ProposalCommentResponse") } },
      },
      "/api/v1/proposals/{id}/review": {
        post: { responses: { "200": { description: "Reviewed proposal" } } },
      },
      "/api/v1/proposals/{id}/close": {
        post: { responses: { "200": { description: "Closed proposal" } } },
      },
      "/api/v1/proposals/{id}/apply": {
        post: { responses: { "200": { description: "Applied proposal" } } },
      },
      "/api/v1/decisions/{id}": { get: { responses: { "200": { description: "Decision record" } } } },
      "/api/v1/decisions/{id}/history": { get: { responses: { "200": { description: "Decision history" } } } },
      "/api/v1/decisions/{id}/diff": { get: { responses: { "200": { description: "Decision diff" } } } },
      "/api/v1/recent-changes": { get: { responses: { "200": { description: "Recent changes" } } } },
      "/api/v1/git/status": {
        get: {
          responses: {
            "200": jsonResponse("Git remote status", "GitRemoteStatusResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/git/configure": {
        post: {
          responses: {
            "200": jsonResponse("Git remote configure result", "GitRemoteConfigureResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/git/pull": {
        post: {
          responses: {
            "200": jsonResponse("Git pull result", "GitRemoteSyncResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/git/push": {
        post: {
          responses: {
            "200": jsonResponse("Git push result", "GitRemoteSyncResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/sync/now": {
        post: {
          responses: {
            "200": jsonResponse("Safe sync result", "SyncWorkspaceNowResult"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/events": {
        get: {
          parameters: auditFilterParameters(),
          responses: { "200": { description: "Event log" } },
        },
      },
      "/api/v1/audit/export": {
        get: {
          parameters: auditFilterParameters(),
          responses: { "200": { description: "Audit export" } },
        },
      },
      "/api/v1/events/stream": {
        get: {
          parameters: [
            queryParameter("limit", "Maximum event count to replay", { type: "integer", minimum: 1 }),
            queryParameter("since", "Event ID or ISO timestamp cursor"),
            queryParameter("once", "Close after replaying current events", { type: "boolean" }),
            queryParameter("poll_ms", "Polling interval for live streams", { type: "integer", minimum: 250 }),
          ],
          responses: { "200": eventStreamResponse("Server-Sent Event stream") },
        },
      },
      "/api/v1/runs": {
        get: { responses: { "200": { description: "Run ledger" } } },
        post: {
          responses: {
            "202": { description: "Queued run" },
            "201": { description: "Created and executed run when wait=true" },
          },
        },
      },
      "/api/v1/runs/monitor": {
        get: { responses: { "200": { description: "Run and queue monitor summary" } } },
      },
      "/api/v1/runs/{id}": {
        get: {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "Run detail with related events and job state" } },
        },
      },
      "/api/v1/dream/runs": {
        get: {
          parameters: [
            queryParameter("limit", "Maximum dream run records to return", { type: "integer", minimum: 1 }),
          ],
          responses: { "200": { description: "Dream run ledger" } },
        },
        post: {
          requestBody: jsonRequestBody("DreamRunRequest"),
          responses: {
            "201": { description: "Created and executed policy-bound dream run" },
          },
        },
      },
      "/api/v1/dream/runs/{id}": {
        get: {
          parameters: [pathParameter("id", "Dream run ID")],
          responses: { "200": { description: "Dream run detail" } },
        },
      },
      "/api/v1/publish": {
        post: {
          responses: {
            "200": jsonResponse("Published static site", "PublishResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/commit": {
        post: {
          responses: {
            "201": jsonResponse("Committed OpenWiki changes", "CommitChangesResponse"),
            "200": jsonResponse("No commit was created", "CommitChangesResponse"),
            "401": jsonResponse("Unauthorized", "ErrorResponse"),
            "403": jsonResponse("Forbidden", "ErrorResponse"),
          },
        },
      },
      "/api/v1/webhooks/github": {
        post: { responses: { "202": jsonResponse("Received GitHub webhook", "WebhookReceiveResponse") } },
      },
      "/api/v1/webhooks/gitlab": {
        post: { responses: { "202": jsonResponse("Received GitLab webhook", "WebhookReceiveResponse") } },
      },
    },
    components: {
      schemas: openApiSchemas(),
    },
  };
}
