import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { routeHttpRequest, type HttpPolicyOptions } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole, type OpenWikiRole } from "@openwiki/policy";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import { buildSearchIndex, exportSearchCorpus } from "@openwiki/search";
import { proposeEdit } from "@openwiki/workflows";

interface SearchPermissionCorpus {
  common_term: string;
  sections: Array<{
    id: string;
    title: string;
    paths: string[];
    visibility: "public" | "internal" | "private";
    owner_principal?: string;
    default_reviewers?: string[];
    description?: string;
  }>;
  grants: Array<{ principal: string; section: string; role: OpenWikiRole }>;
  approval_rules: Array<{
    id: string;
    paths: string[];
    required_reviewers?: Array<{ principal?: string; role?: OpenWikiRole }>;
    require_separate_actor?: boolean;
  }>;
  pages: CorpusPage[];
  subjects: CorpusSubject[];
}

interface CorpusPage {
  id: string;
  path: string;
  page_type: string;
  title: string;
  summary: string;
  topics: string[];
  source_id: string;
  source_path: string;
  claim_id: string;
  unique_term: string;
  body: string;
}

interface CorpusSubject {
  id: string;
  label: string;
  role: OpenWikiRole;
  actor_id: string;
  principals: string[];
  visible_pages: string[];
}

test("search permission eval corpus gates department knowledge across read paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-permissions-"));
  try {
    const corpus = await readSearchPermissionCorpus();
    await createWorkspace(root, "Search Permission Eval Wiki");
    await materializeSearchPermissionCorpus(root, corpus);

    const proposalIdsByPage = await seedDepartmentProposals(root, corpus);
    await buildSearchIndex(root);

    const repo = await loadRepository(root);
    assert.equal(corpus.pages.every((page) => repo.pages.some((record) => record.id === page.id)), true);
    assert.equal(corpus.pages.every((page) => repo.sources.some((record) => record.id === page.source_id)), true);
    assert.equal(corpus.pages.every((page) => repo.claims.some((record) => record.id === page.claim_id)), true);

    for (const subject of corpus.subjects) {
      const policy = policyForSubject(subject);
      const visible = new Set(subject.visible_pages);
      const hiddenPages = corpus.pages.filter((page) => !visible.has(page.id));

      const search = await routeHttpRequest(
        root,
        "GET",
        `/api/v1/search?q=${encodeURIComponent(corpus.common_term)}&type=page&limit=20&explain=true`,
        undefined,
        policy,
      );
      assert.equal(search.status, 200, `${subject.label} search should be allowed`);
      const searchBody = search.body as { results: Array<{ id: string; title: string; summary: string }> };
      const resultIds = searchBody.results.map((result) => result.id);
      for (const expectedId of subject.visible_pages) {
        assert.ok(resultIds.includes(expectedId), `${subject.label} should find ${expectedId}`);
      }
      assertNoPageLeak(`${subject.label} search`, JSON.stringify(search.body), hiddenPages);

      const graph = await routeHttpRequest(root, "GET", "/api/v1/graph", undefined, policy);
      assert.equal(graph.status, 200, `${subject.label} graph should be allowed`);
      assertNoPageLeak(`${subject.label} graph`, JSON.stringify(graph.body), hiddenPages);

      const graphPage = await routeHttpRequest(root, "GET", "/graph", undefined, policy);
      assert.equal(graphPage.status, 200, `${subject.label} graph page should be allowed`);
      assert.match(String(graphPage.body), /Workspace Graph/);
      assertNoPageLeak(`${subject.label} graph page`, String(graphPage.body), hiddenPages);

      const proposalList = await routeHttpRequest(root, "GET", "/api/v1/proposals?status=open&limit=20", undefined, policy);
      assert.equal(proposalList.status, 200, `${subject.label} proposal list should be allowed`);
      const visibleProposalIds = new Set((proposalList.body as { proposals: Array<{ id: string }> }).proposals.map((proposal) => proposal.id));
      for (const page of corpus.pages) {
        const proposalId = proposalIdsByPage.get(page.id);
        if (proposalId === undefined) {
          continue;
        }
        if (visible.has(page.id)) {
          assert.ok(visibleProposalIds.has(proposalId), `${subject.label} should see proposal for ${page.id}`);
        } else {
          assert.equal(visibleProposalIds.has(proposalId), false, `${subject.label} should not see proposal for ${page.id}`);
        }
      }
      assertNoPageLeak(`${subject.label} proposals`, JSON.stringify(proposalList.body), hiddenPages);

      for (const page of hiddenPages) {
        const hiddenTermSearch = await routeHttpRequest(
          root,
          "GET",
          `/api/v1/search?q=${encodeURIComponent(page.unique_term)}&limit=10&explain=true`,
          undefined,
          policy,
        );
        assert.equal(hiddenTermSearch.status, 200, `${subject.label} hidden-term search should not error`);
        assertNoPageLeak(`${subject.label} hidden search ${page.id}`, JSON.stringify(hiddenTermSearch.body), [page]);

        const hiddenAsk = await routeHttpRequest(
          root,
          "POST",
          "/api/v1/ask",
          { question: page.unique_term, limit: 5, include_explain: true },
          policy,
        );
        assert.equal(hiddenAsk.status, 200, `${subject.label} hidden ask should not error`);
        assertNoPageLeak(`${subject.label} hidden ask ${page.id}`, JSON.stringify(hiddenAsk.body), [page], {
          allowUniqueTerms: true,
        });

        const hiddenSourceRead = await routeHttpRequest(
          root,
          "GET",
          `/api/v1/sources/${encodeURIComponent(page.source_id)}`,
          undefined,
          policy,
        );
        assert.equal(hiddenSourceRead.status, 403, `${subject.label} should not read source for ${page.id}`);
      }

      for (const page of corpus.pages.filter((candidate) => visible.has(candidate.id))) {
        const sourceRead = await routeHttpRequest(
          root,
          "GET",
          `/api/v1/sources/${encodeURIComponent(page.source_id)}`,
          undefined,
          policy,
        );
        assert.equal(sourceRead.status, 200, `${subject.label} should read source for ${page.id}`);
      }
    }

    const hrSubject = corpus.subjects.find((subject) => subject.id === "subject:hr");
    assert.ok(hrSubject);
    const mcpSearch = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "eval-hr-search",
        method: "tools/call",
        params: {
          name: "wiki.search",
          arguments: {
            query: corpus.common_term,
            types: ["page"],
            limit: 20,
            include_explain: true,
          },
        },
      },
      {
        actorId: hrSubject.actor_id,
        principals: hrSubject.principals,
      },
    );
    const mcpSearchBody = (mcpSearch as { structuredContent: { results: Array<{ id: string }> } }).structuredContent;
    assert.ok(mcpSearchBody.results.some((result) => result.id === "page:hr:benefits"));
    assert.equal(mcpSearchBody.results.some((result) => result.id === "page:finance:forecast"), false);

    const publicSearchCorpus = await exportSearchCorpus(root, { visibility: "public" });
    const publicSearchPayload = JSON.stringify(publicSearchCorpus);
    assert.ok(publicSearchCorpus.records.some((record) => record.id === "page:public:company-handbook"));
    assertNoPageLeak(
      "public search corpus export",
      publicSearchPayload,
      corpus.pages.filter((page) => page.id !== "page:public:company-handbook"),
    );

    const adminSubject = corpus.subjects.find((subject) => subject.id === "subject:admin");
    assert.ok(adminSubject);
    const adminPreview = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/policy/preview?role=admin&principal=" +
        encodeURIComponent("group:platform-admins") +
        "&target_path=" +
        encodeURIComponent("wiki/admin/incident-controls.md") +
        "&target=" +
        encodeURIComponent("page:admin:incident-controls") +
        "&operation=wiki.read_page",
      undefined,
      policyForSubject(adminSubject),
    );
    assert.equal(adminPreview.status, 200);
    assert.equal(
      (adminPreview.body as { preview: { records: Array<{ id: string; visible: boolean }> } }).preview.records[0]
        ?.visible,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readSearchPermissionCorpus(): Promise<SearchPermissionCorpus> {
  const raw = await readFile(path.join(process.cwd(), "evals", "search-permissions", "corpus.json"), "utf8");
  return JSON.parse(raw) as SearchPermissionCorpus;
}

async function materializeSearchPermissionCorpus(root: string, corpus: SearchPermissionCorpus): Promise<void> {
  await writeJson(root, "policy/sections.json", corpus.sections);
  await writeJson(root, "policy/grants.json", corpus.grants);
  await writeJson(root, "policy/approval-rules.json", corpus.approval_rules);

  for (const page of corpus.pages) {
    await writeCorpusPage(root, page);
    await writeCorpusSource(root, page);
  }

  const claimIndexPath = path.join(root, "claims", "claim-index.jsonl");
  const existingClaims = await readFile(claimIndexPath, "utf8");
  const claims = corpus.pages.map((page) =>
    JSON.stringify({
      id: page.claim_id,
      uri: "openwiki://claim/" + page.claim_id.replace(/^claim:/, "").replace(/:/g, "/"),
      type: "claim",
      text: `${page.title} claim uses ${page.unique_term} and must obey section permissions.`,
      page_id: page.id,
      source_ids: [page.source_id],
      confidence: "high",
      risk: page.id === "page:public:company-handbook" ? "low" : "high",
      status: "active",
      last_verified_at: "2026-05-26T00:00:00.000Z",
    }),
  );
  await writeFile(claimIndexPath, existingClaims + claims.join("\n") + "\n");
}

async function writeCorpusPage(root: string, page: CorpusPage): Promise<void> {
  const absolutePath = path.join(root, page.path);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      "---",
      `id: ${page.id}`,
      `type: ${page.page_type}`,
      `title: ${page.title}`,
      `summary: ${page.summary}`,
      "status: draft",
      "topics:",
      ...page.topics.map((topic) => `  - ${topic}`),
      "source_ids:",
      `  - ${page.source_id}`,
      "claim_ids:",
      `  - ${page.claim_id}`,
      "created_at: 2026-05-26T00:00:00.000Z",
      "updated_at: 2026-05-26T00:00:00.000Z",
      "---",
      "",
      `# ${page.title}`,
      "",
      page.body,
      "",
    ].join("\n"),
  );
}

async function writeCorpusSource(root: string, page: CorpusPage): Promise<void> {
  const absolutePath = path.join(root, page.source_path);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      `id: ${page.source_id}`,
      `title: ${page.title} Source ${page.unique_term}`,
      "source_type: manual",
      "retrieved_at: 2026-05-26T00:00:00.000Z",
      `content_hash: sha256:${page.unique_term}`,
      "trust:",
      "  reliability: high",
      page.id === "page:public:company-handbook" ? "  sensitivity: public" : "  sensitivity: private",
    ].join("\n") + "\n",
  );
}

async function seedDepartmentProposals(root: string, corpus: SearchPermissionCorpus): Promise<Map<string, string>> {
  const proposalIdsByPage = new Map<string, string>();
  for (const page of corpus.pages.filter((candidate) => candidate.id !== "page:public:company-handbook")) {
    const proposed = await proposeEdit({
      root,
      pageId: page.id,
      body: `# ${page.title}\n\nProposed update for ${page.unique_term} in the permission eval corpus.`,
      actorId: actorForPage(page),
      rationale: `Permission eval proposal for ${page.id}.`,
    });
    proposalIdsByPage.set(page.id, proposed.proposal.id);
  }
  return proposalIdsByPage;
}

function actorForPage(page: CorpusPage): string {
  if (page.id.startsWith("page:hr:")) {
    return "actor:user:hr-maintainer";
  }
  if (page.id.startsWith("page:finance:")) {
    return "actor:user:finance-maintainer";
  }
  if (page.id.startsWith("page:engineering:")) {
    return "actor:user:engineering-maintainer";
  }
  if (page.id.startsWith("page:admin:")) {
    return "actor:user:platform-admin";
  }
  return "actor:user:executive-reviewer";
}

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value, null, 2) + "\n");
}

function policyForSubject(subject: CorpusSubject): HttpPolicyOptions {
  return {
    actorId: subject.actor_id,
    role: subject.role,
    scopes: scopesForRole(subject.role),
    principals: subject.principals,
  };
}

function assertNoPageLeak(
  label: string,
  payload: string,
  pages: CorpusPage[],
  options: { allowUniqueTerms?: boolean } = {},
): void {
  for (const page of pages) {
    assert.doesNotMatch(payload, new RegExp(escapeRegExp(page.id)), `${label} leaked ${page.id}`);
    assert.doesNotMatch(payload, new RegExp(escapeRegExp(page.source_id)), `${label} leaked ${page.source_id}`);
    assert.doesNotMatch(payload, new RegExp(escapeRegExp(page.claim_id)), `${label} leaked ${page.claim_id}`);
    assert.doesNotMatch(payload, new RegExp(escapeRegExp(page.title)), `${label} leaked ${page.title}`);
    if (!options.allowUniqueTerms) {
      assert.doesNotMatch(payload, new RegExp(escapeRegExp(page.unique_term)), `${label} leaked ${page.unique_term}`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
