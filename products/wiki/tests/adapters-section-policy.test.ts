import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { hashOpenWikiToken, materializeEffectivePermissions, scopesForRole } from "@openwiki/policy";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import { exportStaticSite } from "@openwiki/static-export";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Git-backed section policy gates private team content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-section-policy-"));
  try {
    await createWorkspace(root, "Section Policy Wiki");
    await mkdir(path.join(root, "wiki", "hr"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "hr", "benefits.md"),
      [
        "---",
        "id: page:hr:benefits",
        "type: hr",
        "title: HR Benefits",
        "summary: Private HR benefits policy.",
        "status: draft",
        "topics:",
        "  - hr",
        "source_ids:",
        "  - source:hr:benefits",
        "  - source:2026-05-21-001",
        "claim_ids:",
        "  - claim:hr:benefits",
        "created_at: 2026-05-22T00:00:00.000Z",
        "updated_at: 2026-05-22T00:00:00.000Z",
        "---",
        "# HR Benefits",
        "",
        "Private HR benefits content should stay inside the HR section.",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "wiki", "concepts", "benefits-overview.md"),
      [
        "---",
        "id: page:concept:benefits-overview",
        "type: concept",
        "title: Public Benefits Overview",
        "summary: Public benefits overview for all employees.",
        "status: draft",
        "topics:",
        "  - benefits",
        "source_ids: []",
        "claim_ids: []",
        "created_at: 2026-05-22T00:00:00.000Z",
        "updated_at: 2026-05-22T00:00:00.000Z",
        "---",
        "# Public Benefits Overview",
        "",
        "This public benefits overview links to [private benefits page](page:hr:benefits) and [Public Benefits Bridge](page:concept:benefits-bridge).",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "wiki", "concepts", "benefits-bridge.md"),
      [
        "---",
        "id: page:concept:benefits-bridge",
        "type: concept",
        "title: Public Benefits Bridge",
        "summary: Public bridge page for graph path visibility tests.",
        "status: draft",
        "topics:",
        "  - benefits",
        "source_ids: []",
        "claim_ids: []",
        "created_at: 2026-05-22T00:00:00.000Z",
        "updated_at: 2026-05-22T00:00:00.000Z",
        "---",
        "# Public Benefits Bridge",
        "",
        "This public bridge links to [Agent Memory](page:concept:agent-memory).",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "sources", "manifests", "source_hr_private.yaml"),
      [
        "id: source:hr:benefits",
        "title: HR Benefits Source",
        "source_type: manual",
        "retrieved_at: 2026-05-22T00:00:00.000Z",
        "content_hash: sha256:hr-private",
        "trust:",
        "  reliability: high",
        "  sensitivity: private",
      ].join("\n") + "\n",
    );
    const claimIndexPath = path.join(root, "claims", "claim-index.jsonl");
    const existingClaims = await readFile(claimIndexPath, "utf8");
    await writeFile(
      claimIndexPath,
      existingClaims +
        JSON.stringify({
          id: "claim:hr:benefits",
          uri: "openwiki://claim/hr/benefits",
          type: "claim",
          text: "HR benefits private claim must not leak to non-HR users.",
          page_id: "page:hr:benefits",
          source_ids: ["source:hr:benefits"],
          confidence: "high",
          risk: "high",
          status: "active",
          last_verified_at: "2026-05-22T00:00:00.000Z",
        }) +
        "\n",
    );
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          { id: "section:public", title: "Public Concepts", paths: ["wiki/concepts/**", "sources/**", "claims/**"], visibility: "public" },
          { id: "section:hr", title: "HR", paths: ["wiki/hr/**", "wiki/hrs/**", "sources/manifests/source_hr_private.yaml"], visibility: "private" },
        ],
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, "policy", "grants.json"),
      JSON.stringify(
        [
          { principal: "group:all-users", section: "section:public", role: "viewer" },
          { principal: "group:hr", section: "section:hr", role: "maintainer" },
        ],
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, "policy", "approval-rules.json"),
      JSON.stringify(
        [
          {
            id: "approval-rule:hr",
            paths: ["wiki/hr/**"],
            required_reviewers: [{ principal: "group:hr", role: "reviewer" }],
            require_separate_actor: true,
          },
        ],
        null,
        2,
      ) + "\n",
    );

    await addServiceAccount(root, {
      id: "hr-reader",
      actor_id: "actor:agent:hr-reader",
      role: "viewer",
      principals: ["group:hr"],
      token_hashes: [hashOpenWikiToken("hr-reader-secret")],
    });

    const policyRepo = await loadRepository(root);
    const effectivePermissions = materializeEffectivePermissions(policyRepo.config, policyRepo.policy);
    assert.ok(
      effectivePermissions.some(
        (permission) =>
          permission.principal === "actor:agent:hr-reader" &&
          permission.section === "section:hr" &&
          permission.role === "maintainer" &&
          permission.scopes.includes("wiki:commit"),
      ),
    );

    const deniedRead = await routeHttpRequest(root, "GET", "/api/v1/pages/page%3Ahr%3Abenefits");
    assert.equal(deniedRead.status, 403);

    const hrRead = await routeHttpRequest(root, "GET", "/api/v1/pages/page%3Ahr%3Abenefits", undefined, {
      scopes: scopesForRole("viewer"),
      principals: ["group:hr"],
    });
    assert.equal(hrRead.status, 200);
    assert.equal((hrRead.body as { id: string }).id, "page:hr:benefits");

    const hrServiceRead = await routeHttpRequest(root, "GET", "/api/v1/pages/page%3Ahr%3Abenefits", undefined, {
      token: "hr-reader-secret",
    });
    assert.equal(hrServiceRead.status, 200);
    assert.equal((hrServiceRead.body as { id: string }).id, "page:hr:benefits");

    const deniedPreview = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/policy/preview?target_path=" + encodeURIComponent("wiki/hr/benefits.md"),
    );
    assert.equal(deniedPreview.status, 403);

    const hrPreview = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/policy/preview?actor_id=" +
        encodeURIComponent("actor:user:hr-reader") +
        "&role=viewer&principal=" +
        encodeURIComponent("group:hr") +
        "&target_path=" +
        encodeURIComponent("wiki/hr/benefits.md") +
        "&target=" +
        encodeURIComponent("page:hr:benefits") +
        "&operation=wiki.read_page",
      undefined,
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(hrPreview.status, 200);
    const hrPreviewBody = hrPreview.body as {
      preview: {
        paths: Array<{ path: string; role?: string; access: { read: boolean; maintain: boolean } }>;
        records: Array<{ id: string; visible: boolean }>;
        operations: Array<{ operation: string; allowed: boolean; path_allowed?: boolean }>;
      };
    };
    assert.equal(hrPreviewBody.preview.paths[0]?.path, "wiki/hr/benefits.md");
    assert.equal(hrPreviewBody.preview.paths[0]?.role, "maintainer");
    assert.equal(hrPreviewBody.preview.paths[0]?.access.read, true);
    assert.equal(hrPreviewBody.preview.paths[0]?.access.maintain, true);
    assert.equal(hrPreviewBody.preview.records[0]?.visible, true);
    assert.equal(hrPreviewBody.preview.operations[0]?.operation, "wiki.read_page");
    assert.equal(hrPreviewBody.preview.operations[0]?.allowed, true);

    const identities = await routeHttpRequest(root, "GET", "/api/v1/policy/identities", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:admin",
    });
    assert.equal(identities.status, 200);
    const identityBody = identities.body as {
      identities: {
        service_accounts: Array<{ id: string; token_hash_count: number; token_hashes?: string[] }>;
        principal_groups: Array<{ principal_id: string; group_id: string }>;
      };
    };
    assert.equal(identityBody.identities.service_accounts[0]?.id, "hr-reader");
    assert.equal(identityBody.identities.service_accounts[0]?.token_hash_count, 1);
    assert.equal(identityBody.identities.service_accounts[0]?.token_hashes, undefined);
    assert.ok(
      identityBody.identities.principal_groups.some(
        (entry) => entry.principal_id === "actor:agent:hr-reader" && entry.group_id === "group:hr",
      ),
    );

    const publicPreview = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/policy/preview?role=viewer&target_path=" +
        encodeURIComponent("wiki/hr/benefits.md") +
        "&target=" +
        encodeURIComponent("page:hr:benefits") +
        "&operation=wiki.read_page",
      undefined,
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(publicPreview.status, 200);
    const publicPreviewBody = publicPreview.body as {
      preview: {
        paths: Array<{ role?: string; access: { read: boolean } }>;
        records: Array<{ id: string; visible: boolean }>;
        operations: Array<{ operation: string; allowed: boolean; path_allowed?: boolean }>;
      };
    };
    assert.equal(publicPreviewBody.preview.paths[0]?.role, undefined);
    assert.equal(publicPreviewBody.preview.paths[0]?.access.read, false);
    assert.equal(publicPreviewBody.preview.records[0]?.visible, false);
    assert.equal(publicPreviewBody.preview.operations[0]?.allowed, false);
    assert.equal(publicPreviewBody.preview.operations[0]?.path_allowed, false);

    const publicSearch = await routeHttpRequest(root, "GET", "/api/v1/search?q=benefits&limit=5");
    assert.equal(publicSearch.status, 200);
    assert.ok(
      (publicSearch.body as { results: Array<{ id: string }> }).results.some(
        (result) => result.id === "page:concept:benefits-overview",
      ),
    );
    assert.ok(
      !(publicSearch.body as { results: Array<{ id: string }> }).results.some((result) => result.id === "page:hr:benefits"),
    );

    const publicAsk = await routeHttpRequest(root, "POST", "/api/v1/ask", { question: "HR benefits private claim", limit: 5 });
    assert.equal(publicAsk.status, 200);
    assert.ok(!(publicAsk.body as { evidence: Array<{ id: string }> }).evidence.some((item) => item.id === "page:hr:benefits"));

    const publicGraph = await routeHttpRequest(root, "GET", "/api/v1/graph");
    assert.equal(publicGraph.status, 200);
    assert.ok(!(publicGraph.body as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === "page:hr:benefits"));
    assert.ok(!(publicGraph.body as { edges: Array<{ from_id: string; to_id: string }> }).edges.some((edge) => edge.from_id === "page:hr:benefits" || edge.to_id === "source:hr:benefits"));

    const publicGraphReport = await routeHttpRequest(root, "GET", "/api/v1/graph/report?limit=25");
    assert.equal(publicGraphReport.status, 200);
    assert.doesNotMatch(JSON.stringify(publicGraphReport.body), /page:hr:benefits|source:hr:benefits|HR Benefits|Private HR benefits/);

    const publicGraphPath = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/graph/path?from_id=" +
        encodeURIComponent("page:concept:benefits-overview") +
        "&to_id=" +
        encodeURIComponent("source:2026-05-21-001"),
    );
    assert.equal(publicGraphPath.status, 200);
    const publicGraphPathBody = publicGraphPath.body as { found: boolean; nodes: Array<{ id: string }> };
    assert.equal(publicGraphPathBody.found, true);
    assert.deepEqual(
      publicGraphPathBody.nodes.map((node) => node.id),
      [
        "page:concept:benefits-overview",
        "page:concept:benefits-bridge",
        "page:concept:agent-memory",
        "source:2026-05-21-001",
      ],
    );
    const publicMcpGraphPath = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "public-graph-path",
        method: "tools/call",
        params: {
          name: "wiki.graph_path",
          arguments: {
            from_id: "page:concept:benefits-overview",
            to_id: "source:2026-05-21-001",
          },
        },
      },
      { scopes: scopesForRole("viewer") },
    );
    assert.deepEqual(
      (publicMcpGraphPath as { structuredContent: { nodes: Array<{ id: string }> } }).structuredContent.nodes.map((node) => node.id),
      publicGraphPathBody.nodes.map((node) => node.id),
    );

    const hrGraph = await routeHttpRequest(root, "GET", "/api/v1/graph", undefined, {
      scopes: scopesForRole("viewer"),
      principals: ["group:hr"],
    });
    assert.equal(hrGraph.status, 200);
    assert.ok((hrGraph.body as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === "page:hr:benefits"));

    const publicDashboard = await routeHttpRequest(root, "GET", "/");
    assert.equal(publicDashboard.status, 200);
    assert.doesNotMatch(String(publicDashboard.body), /HR Benefits|Private HR benefits/);

    const deniedSourceRead = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3Ahr%3Abenefits");
    assert.equal(deniedSourceRead.status, 403);
    const deniedSourceContent = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3Ahr%3Abenefits/content");
    assert.equal(deniedSourceContent.status, 403);
    const deniedClaimRead = await routeHttpRequest(root, "GET", "/api/v1/claims/claim%3Ahr%3Abenefits");
    assert.equal(deniedClaimRead.status, 403);
    const deniedClaimTrace = await routeHttpRequest(root, "GET", "/api/v1/claims/claim%3Ahr%3Abenefits/trace");
    assert.equal(deniedClaimTrace.status, 403);

    const hrSearch = await routeHttpRequest(root, "GET", "/api/v1/search?q=benefits&limit=5", undefined, {
      scopes: scopesForRole("viewer"),
      principals: ["group:hr"],
    });
    assert.equal(hrSearch.status, 200);
    assert.ok((hrSearch.body as { results: Array<{ id: string }> }).results.some((result) => result.id === "page:hr:benefits"));

    const deniedTrustedSynthesis = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/synthesis/create",
      {
        title: "HR Compensation",
        body: "# HR Compensation\n\nTrusted synthesis must still respect section policy.",
        page_type: "hr",
        actor_id: "actor:user:maintainer",
      },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:maintainer" },
    );
    assert.equal(deniedTrustedSynthesis.status, 403);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "policy-create-synthesis",
          method: "tools/call",
          params: {
            name: "wiki.create_synthesis",
            arguments: {
              title: "HR MCP Synthesis",
              body: "# HR MCP Synthesis\n\nMCP trusted synthesis must still respect section policy.",
              page_type: "hr",
              actor_id: "actor:user:maintainer",
            },
          },
        },
        { toolMode: "write", actorId: "actor:user:maintainer" },
      ),
      /requires maintainer access/
    );

    const deniedProposal = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: "page:hr:benefits",
        body: "# HR Benefits\n\nUnauthorized proposal.",
        actor_id: "actor:user:employee",
        rationale: "Should be blocked.",
      },
      { scopes: scopesForRole("contributor"), actorId: "actor:user:employee" },
    );
    assert.equal(deniedProposal.status, 403);

    const created = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: "page:hr:benefits",
        body: "# HR Benefits\n\nHR can propose section-scoped edits.",
        actor_id: "actor:user:hr-editor",
        rationale: "HR section update.",
      },
      { scopes: scopesForRole("contributor"), actorId: "actor:user:hr-editor", principals: ["group:hr"] },
    );
    assert.equal(created.status, 201);
    const proposalId = (created.body as { proposal: { id: string } }).proposal.id;

    const publicProposalList = await routeHttpRequest(root, "GET", "/api/v1/proposals?status=open");
    assert.equal(publicProposalList.status, 200);
    assert.ok(
      !(publicProposalList.body as { proposals: Array<{ id: string }> }).proposals.some((proposal) => proposal.id === proposalId),
    );
    const deniedProposalDetail = await routeHttpRequest(root, "GET", "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/detail");
    assert.equal(deniedProposalDetail.status, 403);

    const publicProposalDashboard = await routeHttpRequest(root, "GET", "/");
    assert.equal(publicProposalDashboard.status, 200);
    assert.doesNotMatch(String(publicProposalDashboard.body), /HR section update|HR can propose/);

    const sameActorReview = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/review",
      { decision: "accepted", rationale: "Same actor should not review.", actor_id: "actor:user:hr-editor" },
      { scopes: scopesForRole("reviewer"), actorId: "actor:user:hr-editor", principals: ["group:hr"] },
    );
    assert.equal(sameActorReview.status, 403);

    const reviewed = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/review",
      { decision: "accepted", rationale: "Reviewed by HR.", actor_id: "actor:user:hr-reviewer" },
      { scopes: scopesForRole("reviewer"), actorId: "actor:user:hr-reviewer", principals: ["group:hr"] },
    );
    assert.equal(reviewed.status, 200);

    const deniedApply = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/apply",
      { actor_id: "actor:user:maintainer" },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:maintainer" },
    );
    assert.equal(deniedApply.status, 403);

    const applied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposalId) + "/apply",
      { actor_id: "actor:user:hr-maintainer" },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:hr-maintainer", principals: ["group:hr"] },
    );
    assert.equal(applied.status, 200);

    const mcpSearch = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "policy-search",
      method: "tools/call",
      params: { name: "wiki.search", arguments: { query: "benefits", limit: 5 } },
    });
    assert.ok(
      !(mcpSearch as { structuredContent: { results: Array<{ id: string }> } }).structuredContent.results.some(
        (result) => result.id === "page:hr:benefits",
      ),
    );

    const mcpAsk = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "policy-ask",
      method: "tools/call",
      params: { name: "wiki.ask", arguments: { question: "HR benefits private claim", limit: 5 } },
    });
    assert.ok(
      !(mcpAsk as { structuredContent: { evidence: Array<{ id: string }> } }).structuredContent.evidence.some(
        (item) => item.id === "page:hr:benefits",
      ),
    );

    const mcpGraph = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "policy-graph",
      method: "tools/call",
      params: { name: "wiki.graph_neighbors", arguments: { id: "page:hr:benefits" } },
    });
    assert.ok(
      !(mcpGraph as { structuredContent: { nodes: Array<{ id: string }> } }).structuredContent.nodes.some(
        (node) => node.id === "page:hr:benefits",
      ),
    );

    const mcpGraphReport = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "policy-graph-report",
      method: "tools/call",
      params: { name: "wiki.graph_report", arguments: { limit: 25 } },
    });
    assert.doesNotMatch(JSON.stringify((mcpGraphReport as { structuredContent: unknown }).structuredContent), /page:hr:benefits|source:hr:benefits|HR Benefits|Private HR benefits/);

    const hrMcpGraph = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "policy-hr-graph",
        method: "tools/call",
        params: { name: "wiki.graph_neighbors", arguments: { id: "page:hr:benefits" } },
      },
      { principals: ["group:hr"] },
    );
    assert.ok(
      (hrMcpGraph as { structuredContent: { nodes: Array<{ id: string }> } }).structuredContent.nodes.some(
        (node) => node.id === "page:hr:benefits",
      ),
    );

    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: "policy-read-source",
        method: "tools/call",
        params: { name: "wiki.read_source", arguments: { id: "source:hr:benefits", include_content: true } },
      }),
      /not visible/,
    );

    const exported = await exportStaticSite({ root, outDir: "public" });
    assert.ok(!exported.files.includes("hrs/benefits.md"));
    assert.ok(!exported.files.includes("sources/hr:benefits.json"));
    const exportedEvents = await readFile(path.join(exported.outDir, "events.jsonl"), "utf8");
    assert.doesNotMatch(exportedEvents, /HR Benefits|hr:benefits|wiki\/hr/);
    const exportedClaims = await readFile(path.join(exported.outDir, "claims.jsonl"), "utf8");
    assert.doesNotMatch(exportedClaims, /claim:hr:benefits|private claim/);
    const exportedSearch = await readFile(path.join(exported.outDir, "search-index.json"), "utf8");
    assert.doesNotMatch(exportedSearch, /HR Benefits|private claim|source:hr:benefits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source writes and generic run dispatch require source Space grants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-source-policy-"));
  try {
    await createWorkspace(root, "Source Policy Wiki");
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          {
            id: "section:wiki",
            title: "Wiki Content",
            paths: ["wiki/**", "claims/**", "proposals/**", "decisions/**", "events/**", "runs/**", "policy/**", "openwiki.json", ".gitignore"],
            visibility: "public",
          },
          { id: "section:sources", title: "Private Sources", paths: ["sources/**"], visibility: "private" },
        ],
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, "policy", "grants.json"),
      JSON.stringify(
        [
          { principal: "group:all-users", section: "section:wiki", role: "maintainer" },
          { principal: "group:sources", section: "section:sources", role: "maintainer" },
        ],
        null,
        2,
      ) + "\n",
    );

    const deniedIngest = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/ingest",
      { title: "Denied Source", content: "private evidence" },
      { role: "researcher", actorId: "actor:user:researcher" },
    );
    assert.equal(deniedIngest.status, 403);
    assert.match(JSON.stringify(deniedIngest.body), /requires contributor access to sources\/manifests/);

    const allowedIngest = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/ingest",
      { title: "Allowed Source", content: "private evidence" },
      { role: "maintainer", actorId: "actor:user:source-maintainer", principals: ["group:sources"] },
    );
    assert.equal(allowedIngest.status, 201);

    const deniedPropose = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/propose",
      { title: "Denied Proposed Source", content_hash: "sha256:abc" },
      { role: "researcher", actorId: "actor:user:researcher" },
    );
    assert.equal(deniedPropose.status, 403);

    const patchOnlySourceFetch = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "source.fetch", input: { title: "Patch-only fetch", url: "https://example.com/source.txt" } },
      { scopes: ["wiki:patch"], actorId: "actor:user:patch-only" },
    );
    assert.equal(patchOnlySourceFetch.status, 403);
    assert.match(JSON.stringify(patchOnlySourceFetch.body), /wiki:ingest:draft/);

    const deniedSourceFetch = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "source.fetch", input: { title: "Denied fetch", url: "https://example.com/source.txt" } },
      { role: "maintainer", actorId: "actor:user:maintainer" },
    );
    assert.equal(deniedSourceFetch.status, 403);
    assert.match(JSON.stringify(deniedSourceFetch.body), /requires contributor access to sources/);

    const allowedSourceFetch = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "source.fetch", input: { title: "Allowed fetch", url: "https://example.com/source.txt" } },
      { role: "maintainer", actorId: "actor:user:source-maintainer", principals: ["group:sources"] },
    );
    assert.equal(allowedSourceFetch.status, 202);
    const allowedSourceFetchRun = (allowedSourceFetch.body as { run: { id: string; input?: Record<string, unknown>; subject_paths?: string[] } }).run;
    assert.deepEqual(allowedSourceFetchRun.subject_paths, ["sources/manifests", "sources/raw"]);
    assert.equal(allowedSourceFetchRun.input?.title, "Allowed fetch");
    assert.equal(allowedSourceFetchRun.input?.url, undefined);

    const deniedRunDetail = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/runs/${encodeURIComponent(allowedSourceFetchRun.id)}`,
      undefined,
      { role: "maintainer", actorId: "actor:user:maintainer" },
    );
    assert.equal(deniedRunDetail.status, 404);
    const allowedRunDetail = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/runs/${encodeURIComponent(allowedSourceFetchRun.id)}`,
      undefined,
      { role: "maintainer", actorId: "actor:user:source-maintainer", principals: ["group:sources"] },
    );
    assert.equal(allowedRunDetail.status, 200);
    const allowedRunDetailBody = allowedRunDetail.body as { run: { input?: Record<string, unknown> } };
    assert.equal(allowedRunDetailBody.run.input?.url, undefined);

    const deniedRuns = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/runs",
      undefined,
      { role: "maintainer", actorId: "actor:user:maintainer" },
    );
    assert.equal(deniedRuns.status, 200);
    assert.equal((deniedRuns.body as { runs: Array<{ id: string }> }).runs.some((run) => run.id === allowedSourceFetchRun.id), false);
    const allowedRuns = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/runs",
      undefined,
      { role: "maintainer", actorId: "actor:user:source-maintainer", principals: ["group:sources"] },
    );
    assert.equal(allowedRuns.status, 200);
    assert.equal((allowedRuns.body as { runs: Array<{ id: string }> }).runs.some((run) => run.id === allowedSourceFetchRun.id), true);

    const patchOnlyExport = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "static.export", input: { out_dir: "public" } },
      { scopes: ["wiki:patch"], actorId: "actor:user:patch-only" },
    );
    assert.equal(patchOnlyExport.status, 403);
    assert.match(JSON.stringify(patchOnlyExport.body), /wiki:publish/);

    const disallowedWatch = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "inbox.watch", input: { adapter: "file", inbox_dir: "/tmp/inbox" } },
      { role: "admin", actorId: "actor:user:admin" },
    );
    assert.equal(disallowedWatch.status, 403);
    assert.match(JSON.stringify(disallowedWatch.body), /not available through HTTP/);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "source-fetch-denied",
          method: "tools/call",
          params: {
            name: "wiki.fetch_source",
            arguments: { title: "Denied MCP fetch", url: "https://example.com/source.txt" },
          },
        },
        { toolMode: "write", role: "maintainer" },
      ),
      /requires contributor access to sources/,
    );
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
