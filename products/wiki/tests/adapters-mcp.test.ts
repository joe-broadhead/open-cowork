import { handleMcpRequest } from "@openwiki/mcp-server";
import { hashOpenWikiToken } from "@openwiki/policy";
import { createWorkspace, readPage } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP adapter exposes read-only OpenWiki tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-"));
  try {
    await createWorkspace(root, "MCP Wiki");

    const initialize = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    assert.deepEqual((initialize as { serverInfo: { name: string } }).serverInfo.name, "openwiki");

    assert.deepEqual(
      await handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: 11,
        method: "ping",
      }),
      {},
    );

    const tools = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const toolRecords = (tools as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    const toolNames = toolRecords.map((tool) => tool.name);
    assertEnumSchemasHaveExplicitTypes(toolRecords);
    assert.ok(toolNames.includes("wiki.search"));
    assert.ok(toolNames.includes("wiki.ask"));
    assert.ok(toolNames.includes("wiki.trace_claim"));
    assert.ok(toolNames.includes("wiki.list_events"));
    assert.ok(toolNames.includes("wiki.git_status"));
    assert.ok(toolNames.includes("wiki.list_runs"));
    assert.ok(toolNames.includes("wiki.list_topics"));
    assert.ok(toolNames.includes("wiki.list_open_questions"));
    assert.ok(toolNames.includes("wiki.detect_governance"));
    assert.ok(toolNames.includes("wiki.graph_neighbors"));
    assert.ok(toolNames.includes("wiki.graph_backlinks"));
    assert.ok(toolNames.includes("wiki.graph_related"));
    assert.ok(toolNames.includes("wiki.graph_path"));
    assert.ok(toolNames.includes("wiki.graph_orphans"));
    assert.ok(toolNames.includes("wiki.graph_stale"));
    assert.ok(!toolNames.includes("wiki.propose_edit"));

    const search = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "wiki.search",
        arguments: {
          query: "agnt memry",
          limit: 2,
          persona: "researcher",
          types: ["page"],
          mode: "hybrid",
          fuzzy: true,
          filters: { topics: ["agents"], status: ["draft"] },
          include_explain: true,
        },
      },
    });
    const structured = (search as { structuredContent: { results: Array<{ id: string }> } }).structuredContent;
    assert.equal(structured.results[0]?.id, "page:concept:agent-memory");

    const answer = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "wiki.ask",
        arguments: { question: "How does OpenWiki store agent memory?", limit: 3 },
      },
    });
    const answerContent = (answer as { structuredContent: { answer: string; citations: Array<{ id: string }> } })
      .structuredContent;
    assert.match(answerContent.answer, /OpenWiki found/);
    assert.equal(answerContent.citations[0]?.id, "source:2026-05-21-001");

    const tracedClaim = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "wiki.trace_claim",
        arguments: { id: "claim:2026-05-21-001" },
      },
    });
    const traceContent = (tracedClaim as {
      structuredContent: { claim: { id: string }; sources: Array<{ id: string }>; evidence_summary: { source_count: number } };
    }).structuredContent;
    assert.equal(traceContent.claim.id, "claim:2026-05-21-001");
    assert.equal(traceContent.sources[0]?.id, "source:2026-05-21-001");
    assert.equal(traceContent.evidence_summary.source_count, 1);

    const sourceWithContent = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "wiki.read_source",
        arguments: { id: "source:2026-05-21-001", include_content: true },
      },
    });
    assert.equal(
      (sourceWithContent as { structuredContent: { unavailable_reason?: string } }).structuredContent
        .unavailable_reason,
      "not_captured",
    );

    const topics = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "wiki.list_topics",
        arguments: {},
      },
    });
    assert.equal((topics as { structuredContent: { topics: Array<{ topic: string }> } }).structuredContent.topics[0]?.topic, "agents");

    const questions = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "wiki.list_open_questions",
        arguments: {},
      },
    });
    assert.equal(
      (questions as { structuredContent: { open_questions: Array<{ question: string }> } }).structuredContent
        .open_questions[0]?.question,
      "How should OpenWiki rank disputed claims?",
    );

    const graph = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 47,
      method: "tools/call",
      params: {
        name: "wiki.graph_neighbors",
        arguments: { id: "page:concept:agent-memory" },
      },
    });
    const graphContent = (graph as { structuredContent: { edges: Array<{ edge_type: string; to_id: string }> } }).structuredContent;
    assert.ok(graphContent.edges.some((edge) => edge.edge_type === "page_source" && edge.to_id === "source:2026-05-21-001"));

    const events = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "wiki.list_events",
        arguments: { limit: 10 },
      },
    });
    assert.deepEqual((events as { structuredContent: { events: unknown[] } }).structuredContent.events, []);

    const runs = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "wiki.list_runs",
        arguments: { limit: 10 },
      },
    });
    assert.deepEqual((runs as { structuredContent: { runs: unknown[] } }).structuredContent.runs, []);

    const resources = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    });
    const resourceUris = (resources as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri);
    assert.ok(resourceUris.includes("openwiki://index"));
    assert.ok(resourceUris.includes("openwiki://source/2026-05-21-001"));
    assert.ok(resourceUris.includes("openwiki://claim/2026-05-21-001"));

    const sourceResource = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 10,
      method: "resources/read",
      params: {
        uri: "openwiki://source/2026-05-21-001",
      },
    });
    assert.match(
      (sourceResource as { contents: Array<{ text: string }> }).contents[0]?.text ?? "",
      /OpenWiki Protocol Draft/,
    );

    const claimResource = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 11,
      method: "resources/read",
      params: {
        uri: "openwiki://claim/2026-05-21-001",
      },
    });
    assert.match((claimResource as { contents: Array<{ text: string }> }).contents[0]?.text ?? "", /OpenWiki stores/);

    const prompts = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 12,
      method: "prompts/list",
    });
    const promptNames = (prompts as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name);
    assert.deepEqual(promptNames, [
      "answer_with_citations",
      "research_topic",
      "review_edit",
      "ingest_source",
      "create_synthesis_page",
      "compare_sources",
      "find_contradictions",
      "prepare_briefing",
    ]);

    const prompt = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 13,
      method: "prompts/get",
      params: {
        name: "answer_with_citations",
        arguments: {
          question: "How does OpenWiki store agent memory?",
          persona: "researcher",
        },
      },
    });
    assert.match(
      (prompt as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text ?? "",
      /cite source and claim IDs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP index resource reports policy-filtered counts without raw workspace config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-index-policy-"));
  try {
    await createWorkspace(root, "MCP Index Policy Wiki");
    await mkdir(path.join(root, "wiki", "private"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "private", "secret.md"),
      [
        "---",
        "id: page:private:secret",
        "title: Secret",
        "type: concept",
        "summary: Private secret.",
        "topics:",
        "  - private",
        "source_ids: []",
        "claim_ids: []",
        "---",
        "",
        "# Secret",
        "",
        "MCP_INDEX_PRIVATE_SECRET",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          { id: "section:readable", title: "Readable", paths: ["wiki/concepts/**", "sources/**", "claims/**"], visibility: "internal" },
          { id: "section:private", title: "Private", paths: ["wiki/private/**"], visibility: "private" },
        ],
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, "policy", "grants.json"),
      JSON.stringify([{ principal: "group:all-users", section: "section:readable", role: "viewer" }], null, 2) + "\n",
    );

    const indexResource = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "index",
      method: "resources/read",
      params: { uri: "openwiki://index" },
    });
    const text = (indexResource as { contents: Array<{ text: string }> }).contents[0]?.text ?? "";
    const parsed = JSON.parse(text) as { workspace: Record<string, unknown>; counts: { pages: number } };
    assert.equal(parsed.counts.pages, 1);
    assert.equal(parsed.workspace.auth, undefined);
    assert.doesNotMatch(text, /MCP_INDEX_PRIVATE_SECRET/);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "resources-denied",
          method: "resources/list",
        },
        { scopes: [] },
      ),
      /wiki:read/,
    );
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "index-denied",
          method: "resources/read",
          params: { uri: "openwiki://index" },
        },
        { scopes: [] },
      ),
      /wiki:read/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP tool results are bounded and report truncation guidance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-bounds-"));
  const previousLimit = process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES;
  try {
    await createWorkspace(root, "MCP Bounds Wiki");
    const pagePath = path.join(root, "wiki", "concepts", "agent-memory.md");
    const original = await readFile(pagePath, "utf8");
    await writeFile(
      pagePath,
      original + "\n\n" + "Large MCP output fixture content.\n".repeat(250) + "\nUNIQUE_TAIL_SHOULD_BE_TRUNCATED\n",
    );
    process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES = "2048";

    const result = (await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "bounded-read",
      method: "tools/call",
      params: {
        name: "wiki.read_page",
        arguments: { id: "page:concept:agent-memory" },
      },
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { truncated: boolean; output_limit_bytes: number; original_bytes: number; guidance: string[] };
      _meta: { openwiki: { truncated: boolean } };
    };

    assert.equal(result.structuredContent.truncated, true);
    assert.equal(result._meta.openwiki.truncated, true);
    assert.equal(result.structuredContent.output_limit_bytes, 2048);
    assert.ok(result.structuredContent.original_bytes > 2048);
    assert.match(result.content[0]?.text ?? "", /OpenWiki MCP output truncated/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /UNIQUE_TAIL_SHOULD_BE_TRUNCATED/);
    assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 2048);
    assert.ok(result.structuredContent.guidance.some((entry) => /limit/.test(entry)));
  } finally {
    if (previousLimit === undefined) {
      delete process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES;
    } else {
      process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES = previousLimit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP adapter requires explicit modes for proposal and write tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-write-"));
  try {
    await createWorkspace(root, "MCP Write Wiki");
    await addServiceAccount(root, {
      id: "mcp-contributor",
      actor_id: "actor:agent:mcp-contributor",
      role: "contributor",
      token_hashes: [hashOpenWikiToken("mcp-contributor-secret")],
    });

    const proposalTools = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
      { toolMode: "proposal", token: "mcp-contributor-secret" },
    );
    const proposalToolNames = (proposalTools as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.ok(proposalToolNames.includes("wiki.propose_edit"));
    assert.ok(proposalToolNames.includes("wiki.propose_synthesis"));
    assert.ok(proposalToolNames.includes("wiki.propose_source"));
    assert.ok(proposalToolNames.includes("wiki.comment_on_proposal"));
    assert.ok(!proposalToolNames.includes("wiki.ingest_source"));
    assert.ok(!proposalToolNames.includes("wiki.apply_proposal"));

    const writeTools = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
      },
      { toolMode: "write" },
    );
    const writeToolNames = (writeTools as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.ok(writeToolNames.includes("wiki.list_workspaces"));
    assert.ok(writeToolNames.includes("wiki.connect_workspace"));
    assert.ok(writeToolNames.includes("wiki.propose_section_policy"));
    assert.ok(writeToolNames.includes("wiki.ingest_source"));
    assert.ok(writeToolNames.includes("wiki.fetch_source"));
    assert.ok(writeToolNames.includes("wiki.run_job"));
    assert.ok(writeToolNames.includes("wiki.run_lint"));
    assert.ok(writeToolNames.includes("wiki.create_synthesis"));
    assert.ok(writeToolNames.includes("wiki.publish"));
    assert.ok(writeToolNames.includes("wiki.git_pull"));
    assert.ok(writeToolNames.includes("wiki.git_push"));
    assert.ok(writeToolNames.includes("wiki.sync_now"));

    const published = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "wiki.publish",
          arguments: {
            out_dir: "mcp-public",
            actor_id: "actor:agent:mcp-maintainer",
          },
        },
      },
      { toolMode: "write" },
    );
    const publishedContent = (published as {
      structuredContent: { files: string[]; event: { type: string; operation?: string; actor_id?: string } };
    }).structuredContent;
    assert.ok(publishedContent.files.includes("events.jsonl"));
    assert.equal(publishedContent.event.type, "publish.completed");
    assert.equal(publishedContent.event.operation, "wiki.publish");
    assert.equal(publishedContent.event.actor_id, "actor:agent:mcp-maintainer");
    const publishedEvents = await readFile(path.join(root, "mcp-public", "events.jsonl"), "utf8");
    assert.match(publishedEvents, /publish\.completed/);

    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: "page:concept:agent-memory",
            body: "# Agent Memory\n\nThis edit should not be allowed in read mode.",
          },
        },
      }),
      /not enabled in MCP read mode/,
    );

    const proposed = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: "page:concept:agent-memory",
            body: "# Agent Memory\n\nMCP write mode can propose, review, and apply page edits.",
            actor_id: "actor:agent:wiki-editor",
            rationale: "Adapter smoke test.",
          },
        },
      },
      { toolMode: "write" },
    );
    const proposalId = (proposed as { structuredContent: { proposal: { id: string; status: string } } })
      .structuredContent.proposal.id;
    assert.match(proposalId, /^proposal:/);

    const proposalQueue = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "wiki.list_proposals",
        arguments: {
          statuses: ["open"],
        },
      },
    });
    assert.ok(
      (proposalQueue as { structuredContent: { proposals: Array<{ id: string }> } }).structuredContent.proposals.some(
        (proposal) => proposal.id === proposalId,
      ),
    );

    const proposalDetail = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "wiki.read_proposal_detail",
        arguments: {
          id: proposalId,
        },
      },
    });
    assert.match(
      (proposalDetail as { structuredContent: { diff?: { body: string } } }).structuredContent.diff?.body ?? "",
      /MCP write mode can propose/,
    );

    const mcpComment = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: {
          name: "wiki.comment_on_proposal",
          arguments: {
            proposal_id: proposalId,
            body: "MCP proposal comments should be durable governance notes.",
            actor_id: "actor:agent:mcp-contributor",
          },
        },
      },
      { toolMode: "proposal", token: "mcp-contributor-secret" },
    );
    assert.match(
      (mcpComment as { structuredContent: { comment: { id: string } } }).structuredContent.comment.id,
      /^comment:/,
    );

    const synthesis = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "wiki.propose_synthesis",
          arguments: {
            title: "MCP Synthesis",
            body: "# MCP Synthesis\n\nMCP clients can draft synthesis pages as reviewable proposals.",
            page_type: "concept",
            topics: ["agents"],
            actor_id: "actor:agent:wiki-editor",
            rationale: "Adapter synthesis smoke test.",
          },
        },
      },
      { toolMode: "proposal" },
    );
    assert.equal(
      (synthesis as { structuredContent: { proposal: { target_path: string } } }).structuredContent.proposal
        .target_path,
      "wiki/concepts/mcp-synthesis.md",
    );
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: {
            name: "wiki.propose_synthesis",
            arguments: {
              title: "Traversal",
              body: "# Traversal\n\nThis should not write outside wiki.",
              page_type: "../../../outside",
            },
          },
        },
        { toolMode: "proposal" },
      ),
      /safe path segment/,
    );

    const sourceProposal = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 35,
        method: "tools/call",
        params: {
          name: "wiki.propose_source",
          arguments: {
            title: "MCP Proposed Source",
            source_type: "webpage",
            url: "https://example.com/mcp-source",
            actor_id: "actor:agent:wiki-editor",
            rationale: "Adapter source proposal smoke test.",
          },
        },
      },
      { toolMode: "proposal" },
    );
    assert.match(
      (sourceProposal as { structuredContent: { source: { id: string }; proposal: { target_path: string } } })
        .structuredContent.source.id,
      /^source:/,
    );
    assert.match(
      (sourceProposal as { structuredContent: { source: { id: string }; proposal: { target_path: string } } })
        .structuredContent.proposal.target_path,
      /^sources\/manifests\//,
    );

    const reviewed = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "wiki.review_proposal",
          arguments: {
            proposal_id: proposalId,
            decision: "accepted",
            rationale: "The adapter-created proposal is scoped.",
            actor_id: "actor:user:maintainer",
          },
        },
      },
      { toolMode: "write" },
    );
    assert.equal(
      (reviewed as { structuredContent: { proposal: { status: string } } }).structuredContent.proposal.status,
      "accepted",
    );

    const applied = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "wiki.apply_proposal",
          arguments: {
            proposal_id: proposalId,
            actor_id: "actor:user:maintainer",
          },
        },
      },
      { toolMode: "write" },
    );
    assert.equal(
      (applied as { structuredContent: { proposal: { status: string } } }).structuredContent.proposal.status,
      "applied",
    );

    const source = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "wiki.ingest_source",
          arguments: {
            title: "MCP Evidence Note",
            source_type: "manual",
            content: "MCP ingested sources become searchable OpenWiki evidence.",
            actor_id: "actor:agent:wiki-editor",
          },
        },
      },
      { toolMode: "write" },
    );
    assert.match(
      (source as { structuredContent: { source: { id: string } } }).structuredContent.source.id,
      /^source:/,
    );

    const fetchedSource = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "wiki.fetch_source",
          arguments: {
            title: "MCP Fetch Note",
            url: "https://example.com/fetch-note.txt",
            connector_id: "docs",
            credential_ref: "cred:docs-reader",
            actor_id: "actor:agent:wiki-editor",
          },
        },
      },
      { toolMode: "write" },
    );
    const fetchedRun = (fetchedSource as {
      structuredContent: { run: { status: string; run_type: string; input?: Record<string, unknown> } };
    })
      .structuredContent.run;
    assert.equal(fetchedRun.status, "queued");
    assert.equal(fetchedRun.run_type, "source.fetch");
    assert.equal(fetchedRun.input?.title, "MCP Fetch Note");
    assert.equal(fetchedRun.input?.connector_id, undefined);
    assert.equal(fetchedRun.input?.credential_ref, undefined);

    const run = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "wiki.run_job",
          arguments: {
            run_type: "lint",
            actor_id: "actor:user:maintainer",
          },
        },
      },
      { toolMode: "write" },
    );
    assert.equal((run as { structuredContent: { run: { status: string } } }).structuredContent.run.status, "queued");
    const lint = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "wiki.run_lint",
          arguments: {},
        },
      },
      { toolMode: "write" },
    );
    assert.equal((lint as { structuredContent: { status: string } }).structuredContent.status, "passed");

    const page = await readPage(root, "page:concept:agent-memory");
    assert.match(page.body, /MCP write mode can propose, review, and apply page edits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function addServiceAccount(root: string, serviceAccount: Record<string, unknown>): Promise<void> {
  const configPath = path.join(root, "openwiki.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    auth?: { service_accounts?: Array<Record<string, unknown>> };
  };
  config.auth = {
    service_accounts: [...(config.auth?.service_accounts ?? []), serviceAccount],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function assertEnumSchemasHaveExplicitTypes(tools: Array<{ name: string; inputSchema: unknown }>): void {
  for (const tool of tools) {
    visitSchema(tool.inputSchema, tool.name + ".inputSchema");
  }
}

function visitSchema(value: unknown, schemaPath: string): void {
  if (!isRecord(value)) {
    return;
  }
  if (Array.isArray(value.enum)) {
    assert.equal(typeof value.type, "string", schemaPath + " enum schema must declare type for strict provider compatibility");
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "enum") {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((entry, index) => visitSchema(entry, schemaPath + "." + key + "[" + index + "]"));
      continue;
    }
    visitSchema(child, schemaPath + "." + key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
