
export function queryParameter(name: string, description: string, schema: Record<string, unknown> = { type: "string" }): unknown {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema,
  };
}

export function pathParameter(name: string, description: string, schema: Record<string, unknown> = { type: "string" }): unknown {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema,
  };
}

export function headerParameter(
  name: string,
  description: string,
  schema: Record<string, unknown> = { type: "string" },
  required = false,
): unknown {
  return {
    name,
    in: "header",
    required,
    description,
    schema,
  };
}

export function auditFilterParameters(): unknown[] {
  return [
    queryParameter("limit", "Maximum record count", { type: "integer", minimum: 1 }),
    queryParameter("actor_id", "Filter by actor ID"),
    queryParameter("event_type", "Filter event records by event type"),
    queryParameter("operation", "Filter event records by operation"),
    queryParameter("record_id", "Filter records related to this record ID"),
    queryParameter("since", "Filter records at or after this ISO timestamp"),
    queryParameter("until", "Filter records at or before this ISO timestamp"),
    queryParameter("cursor", "Opaque event pagination cursor returned as next_cursor"),
    queryParameter("timeline_cursor", "Opaque mixed audit timeline cursor returned as next_timeline_cursor"),
  ];
}

export function jsonResponse(description: string, schemaName: string): unknown {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

export function jsonRequestBody(schemaName: string): unknown {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

export function mcpJsonOrEventStreamResponse(description: string): unknown {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/McpJsonRpcResponse" },
      },
      "text/event-stream": {
        schema: { type: "string" },
      },
    },
  };
}

export function metricsResponse(description: string): unknown {
  return {
    description,
    content: {
      "text/plain": {
        schema: { type: "string" },
      },
    },
  };
}

export function eventStreamResponse(description: string): unknown {
  return {
    description,
    content: {
      "text/event-stream": {
        schema: { type: "string" },
      },
    },
  };
}

export function openApiSchemas(): Record<string, unknown> {
  return {
    HealthProbeResponse: {
      type: "object",
      additionalProperties: true,
      required: ["status", "checked_at", "service"],
      properties: {
        status: { type: "string" },
        checked_at: { type: "string", format: "date-time" },
        service: { type: "string" },
      },
    },
    ReadinessProbeResponse: {
      type: "object",
      additionalProperties: true,
      required: ["status", "checked_at", "health"],
      properties: {
        status: { type: "string", enum: ["ready", "not_ready"] },
        checked_at: { type: "string", format: "date-time" },
        health: { $ref: "#/components/schemas/HealthResponse" },
      },
    },
    HealthResponse: {
      type: "object",
      additionalProperties: true,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok", "degraded"] },
        protocol_version: { type: "string" },
        workspace_id: { type: "string" },
        counts: { type: "object", additionalProperties: { type: "integer" } },
        components: { type: "object", additionalProperties: true },
        error: { type: "string" },
      },
    },
    CapabilitiesResponse: {
      type: "object",
      additionalProperties: false,
      required: ["protocol_version", "operations", "adapters", "scopes"],
      properties: {
        protocol_version: { type: "string" },
        operations: { type: "array", items: { type: "string" } },
        adapters: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
      },
    },
    PolicyResponse: {
      type: "object",
      additionalProperties: false,
      required: ["policy"],
      properties: {
        policy: { type: "object", additionalProperties: true },
      },
    },
    PermissionPreviewResponse: {
      type: "object",
      additionalProperties: false,
      required: ["preview"],
      properties: {
        preview: { type: "object", additionalProperties: true },
      },
    },
    PolicyIdentitiesResponse: {
      type: "object",
      additionalProperties: false,
      required: ["identities"],
      properties: {
        identities: { type: "object", additionalProperties: true },
      },
    },
    ServiceAccountListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["service_accounts"],
      properties: {
        service_accounts: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
    ServiceAccountInspectResponse: {
      type: "object",
      additionalProperties: false,
      required: ["service_account"],
      properties: {
        service_account: { type: "object", additionalProperties: true },
      },
    },
    ServiceAccountTokenResponse: {
      type: "object",
      additionalProperties: true,
      required: ["service_account", "token", "event"],
      properties: {
        service_account: { type: "object", additionalProperties: true },
        token: { type: "object", additionalProperties: true },
        event: { type: "object", additionalProperties: true },
      },
    },
    ServiceAccountRevokeResponse: {
      type: "object",
      additionalProperties: true,
      required: ["service_account", "revoked_token_ids", "event"],
      properties: {
        service_account: { type: "object", additionalProperties: true },
        revoked_token_ids: { type: "array", items: { type: "string" } },
        event: { type: "object", additionalProperties: true },
      },
    },
    ProposePolicyResponse: {
      type: "object",
      additionalProperties: true,
      required: ["proposal", "policy_file", "target_path", "validation", "diff"],
      properties: {
        proposal: { type: "object", additionalProperties: true },
        policy_file: { type: "string" },
        target_path: { type: "string" },
        validation: { type: "object", additionalProperties: true },
        diff: { type: "string" },
      },
    },
    SearchResponse: {
      type: "object",
      additionalProperties: false,
      required: ["results", "count", "total", "truncated", "persona"],
      properties: {
        results: {
          type: "array",
          items: { $ref: "#/components/schemas/SearchResult" },
        },
        count: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 0 },
        total_relation: { type: "string", enum: ["exact", "capped"] },
        truncated: { type: "boolean" },
        persona: { type: "string" },
        next_cursor: { type: "string" },
        facets: {
          type: "object",
          additionalProperties: false,
          properties: {
            types: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            status: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            topics: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
          },
        },
        facets_relation: { type: "string", enum: ["exact", "capped"] },
        explain: { $ref: "#/components/schemas/SearchExplain" },
      },
    },
    SearchResult: {
      type: "object",
      additionalProperties: true,
      required: ["id", "type", "title", "uri", "score", "matched_fields", "citations", "updated_at"],
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        url: { type: "string" },
        uri: { type: "string" },
        score: { type: "number" },
        matched_fields: { type: "array", items: { type: "string" } },
        citations: { type: "array", items: { type: "object", additionalProperties: true } },
        updated_at: { type: "string", format: "date-time" },
        highlights: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
        explain: { type: "object", additionalProperties: true },
      },
    },
    GraphAnalysisResponse: {
      type: "object",
      additionalProperties: true,
      required: [
        "schema_version",
        "node_count",
        "edge_count",
        "node_metrics",
        "hub_nodes",
        "components",
        "orphan_components",
        "candidate_missing_links",
        "surprising_connections",
        "stale_hubs",
        "source_coverage_gaps",
        "suggested_questions",
      ],
      properties: {
        schema_version: { type: "string", const: "openwiki-graph-analysis-v1" },
        node_count: { type: "integer", minimum: 0 },
        edge_count: { type: "integer", minimum: 0 },
        node_metrics: { type: "array", items: { type: "object", additionalProperties: true } },
        hub_nodes: { type: "array", items: { type: "object", additionalProperties: true } },
        components: { type: "array", items: { type: "object", additionalProperties: true } },
        orphan_components: { type: "array", items: { type: "object", additionalProperties: true } },
        candidate_missing_links: { type: "array", items: { type: "object", additionalProperties: true } },
        surprising_connections: { type: "array", items: { type: "object", additionalProperties: true } },
        stale_hubs: { type: "array", items: { type: "object", additionalProperties: true } },
        source_coverage_gaps: { type: "array", items: { type: "object", additionalProperties: true } },
        suggested_questions: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
    SearchExplain: {
      type: "object",
      additionalProperties: true,
      properties: {
        query_tokens: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["lexical", "hybrid"] },
        fuzzy: { type: "boolean" },
        rrf: {
          type: "object",
          required: ["enabled", "k", "overfetch", "fetch_limit"],
          properties: {
            enabled: { type: "boolean" },
            k: { type: "number" },
            overfetch: { type: "integer", minimum: 1 },
            fetch_limit: { type: "integer", minimum: 1 },
          },
        },
        retrievers_used: { type: "array", items: { type: "string" } },
        retriever_stats: { type: "object", additionalProperties: true },
        ranking_signals: { type: "array", items: { type: "string" } },
        reranker: { type: "object", additionalProperties: true },
        diagnostics: {
          type: "object",
          additionalProperties: true,
          properties: {
            backend: { type: "string", enum: ["sqlite", "postgres"] },
            candidate_strategy: { type: "string" },
            index_content_hash: { type: "string" },
            index_record_count: { type: "integer", minimum: 0 },
            candidate_ids: { type: "integer", minimum: 0 },
            record_json_reads: { type: "integer", minimum: 0 },
            scanned_rows: { type: "integer", minimum: 0 },
            embedding_model: { type: "string" },
            embedding_dimensions: { type: "integer", minimum: 1 },
            embedding_provider: { type: "string" },
            elapsed_ms: { type: "number", minimum: 0 },
          },
        },
      },
    },
    RecordsListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["records", "count", "total"],
      properties: {
        records: {
          type: "array",
          items: { $ref: "#/components/schemas/RecordListItem" },
        },
        count: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 0 },
        next_cursor: { type: "string" },
      },
    },
    RecordListItem: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "title"],
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        title: { type: "string" },
        path: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
        updated_at: { type: "string" },
        href: { type: "string" },
      },
    },
    AnswerResponse: {
      type: "object",
      additionalProperties: true,
      required: ["question", "answer", "citations", "evidence", "search"],
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        citations: { type: "array", items: { type: "object", additionalProperties: true } },
        evidence: { type: "array", items: { type: "object", additionalProperties: true } },
        search: { $ref: "#/components/schemas/SearchResponse" },
      },
    },
    AskRequest: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1 },
        include_explain: { type: "boolean" },
      },
    },
    ThinkRequest: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1 },
        include_explain: { type: "boolean" },
      },
    },
    DreamRunRequest: {
      type: "object",
      additionalProperties: false,
      properties: {
        phases: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1000 },
        dry_run: { type: "boolean" },
        create_proposals: { type: "boolean" },
        provider: { type: "string" },
        schema_pack: { type: "string" },
        actor_id: { type: "string" },
        wait: { type: "boolean" },
      },
    },
    ThinkResponse: {
      type: "object",
      additionalProperties: true,
      required: ["question", "answer", "citations", "evidence", "search", "gaps", "diagnostics"],
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        citations: { type: "array", items: { type: "object", additionalProperties: true } },
        evidence: { type: "array", items: { type: "object", additionalProperties: true } },
        search: { $ref: "#/components/schemas/SearchResponse" },
        gaps: { type: "array", items: { type: "object", additionalProperties: true } },
        diagnostics: { type: "object", additionalProperties: true },
      },
    },
    RepositoryValidationReport: {
      type: "object",
      additionalProperties: true,
      required: ["id", "workspace_id", "status", "checked_at", "issue_count", "issues", "counts"],
      properties: {
        id: { type: "string" },
        workspace_id: { type: "string" },
        status: { type: "string", enum: ["passed", "failed"] },
        checked_at: { type: "string", format: "date-time" },
        issue_count: { type: "integer", minimum: 0 },
        issues: { type: "array", items: { $ref: "#/components/schemas/ValidationIssue" } },
        counts: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
      },
    },
    ValidationIssue: {
      type: "object",
      additionalProperties: false,
      required: ["severity", "code", "message"],
      properties: {
        severity: { type: "string", enum: ["info", "warning", "error"] },
        code: { type: "string" },
        message: { type: "string" },
        path: { type: "string" },
      },
    },
    ErrorResponse: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: {
          type: "object",
          additionalProperties: true,
          required: ["message"],
          properties: {
            message: { type: "string" },
          },
        },
      },
    },
    McpJsonRpcResponse: {
      type: "object",
      additionalProperties: true,
      required: ["jsonrpc", "id"],
      properties: {
        jsonrpc: { const: "2.0" },
        id: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
        },
        result: {},
        error: {
          type: "object",
          additionalProperties: true,
          required: ["code", "message"],
          properties: {
            code: { type: "integer" },
            message: { type: "string" },
          },
        },
      },
    },
    WebhookReceiveResponse: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "event"],
      properties: {
        provider: { type: "string", enum: ["github", "gitlab"] },
        event: { type: "object", additionalProperties: true },
        run: {
          anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
        },
      },
    },
    ProposalCommentsResponse: {
      type: "object",
      additionalProperties: false,
      required: ["comments", "total"],
      properties: {
        comments: { type: "array", items: { $ref: "#/components/schemas/ProposalComment" } },
        total: { type: "integer", minimum: 0 },
      },
    },
    ProposalCommentResponse: {
      type: "object",
      additionalProperties: true,
      required: ["proposal", "comment"],
      properties: {
        proposal: { type: "object", additionalProperties: true },
        comment: { $ref: "#/components/schemas/ProposalComment" },
      },
    },
    ProposalComment: {
      type: "object",
      additionalProperties: false,
      required: ["id", "uri", "type", "proposal_id", "actor_id", "body", "created_at", "path"],
      properties: {
        id: { type: "string" },
        uri: { type: "string" },
        type: { const: "comment" },
        proposal_id: { type: "string" },
        actor_id: { type: "string" },
        body: { type: "string" },
        created_at: { type: "string", format: "date-time" },
        path: { type: "string" },
      },
    },
    ProposeSourceResponse: {
      type: "object",
      additionalProperties: true,
      required: ["proposal", "source", "validation", "diff"],
      properties: {
        proposal: { type: "object", additionalProperties: true },
        source: { type: "object", additionalProperties: true },
        validation: { type: "object", additionalProperties: true },
        diff: { type: "string" },
      },
    },
    CreateSynthesisResponse: {
      type: "object",
      additionalProperties: true,
      required: ["proposal", "decision", "page", "applied_paths", "validation", "repository_validation"],
      properties: {
        proposal: { type: "object", additionalProperties: true },
        decision: { type: "object", additionalProperties: true },
        page: { type: "object", additionalProperties: true },
        applied_paths: { type: "array", items: { type: "string" } },
        validation: { type: "object", additionalProperties: true },
        repository_validation: { type: "object", additionalProperties: true },
        commit: { type: "string" },
      },
    },
    PublishResponse: {
      type: "object",
      additionalProperties: true,
      required: ["root", "outDir", "files", "event"],
      properties: {
        root: { type: "string" },
        outDir: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        event: { type: "object", additionalProperties: true },
      },
    },
    CommitChangesResponse: {
      type: "object",
      additionalProperties: true,
      required: ["root", "is_git_repo", "committed", "status", "mode", "message", "staged_paths"],
      properties: {
        root: { type: "string" },
        is_git_repo: { type: "boolean" },
        committed: { type: "boolean" },
        status: { type: "string", enum: ["committed", "no_changes", "not_git_repo"] },
        mode: { type: "string", enum: ["staged", "paths", "all"] },
        message: { type: "string" },
        staged_paths: { type: "array", items: { type: "string" } },
        sha: { type: "string" },
        short_sha: { type: "string" },
        event: { type: "object", additionalProperties: true },
      },
    },
    GitStatusEntry: {
      type: "object",
      additionalProperties: false,
      required: ["index", "working_tree", "path"],
      properties: {
        index: { type: "string" },
        working_tree: { type: "string" },
        path: { type: "string" },
      },
    },
    GitRemoteStatusResponse: {
      type: "object",
      additionalProperties: true,
      required: ["root", "is_git_repo", "ahead", "behind", "clean", "staged_paths", "unstaged_paths", "untracked_paths", "changes"],
      properties: {
        root: { type: "string" },
        is_git_repo: { type: "boolean" },
        branch: { type: "string" },
        upstream: { type: "string" },
        remote: { type: "string" },
        remote_url: { type: "string" },
        ahead: { type: "integer" },
        behind: { type: "integer" },
        clean: { type: "boolean" },
        staged_paths: { type: "array", items: { type: "string" } },
        unstaged_paths: { type: "array", items: { type: "string" } },
        untracked_paths: { type: "array", items: { type: "string" } },
        changes: { type: "array", items: { $ref: "#/components/schemas/GitStatusEntry" } },
      },
    },
    GitRemoteConfigureResponse: {
      type: "object",
      additionalProperties: true,
      required: ["root", "is_git_repo", "remote", "branch", "config_path"],
      properties: {
        root: { type: "string" },
        is_git_repo: { type: "boolean" },
        remote: { type: "string" },
        branch: { type: "string" },
        remote_url: { type: "string" },
        credential_ref: { type: "string" },
        config_path: { type: "string" },
      },
    },
    GitRemoteSyncResponse: {
      type: "object",
      additionalProperties: true,
      required: ["root", "is_git_repo", "operation", "status", "stdout", "stderr"],
      properties: {
        root: { type: "string" },
        is_git_repo: { type: "boolean" },
        operation: { type: "string", enum: ["pull", "push"] },
        status: { type: "string", enum: ["pulled", "pushed", "not_git_repo", "no_remote"] },
        remote: { type: "string" },
        branch: { type: "string" },
        remote_url: { type: "string" },
        before: { $ref: "#/components/schemas/GitRemoteStatusResponse" },
        after: { $ref: "#/components/schemas/GitRemoteStatusResponse" },
        stdout: { type: "string" },
        stderr: { type: "string" },
      },
    },
  };
}
