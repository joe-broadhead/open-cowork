import { routeHttpRequest } from "@openwiki/http-api";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, readPage } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("HTTP adapter creates, reviews, and applies proposals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-write-"));
  try {
    await createWorkspace(root, "HTTP Write Wiki");

    const created = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: "page:concept:agent-memory",
        body: "# Agent Memory\n\nHTTP clients can propose, review, and apply page edits.",
        actor_id: "actor:agent:http-client",
        rationale: "HTTP adapter smoke test.",
      },
      { scopes: scopesForRole("contributor") },
    );
    assert.equal(created.status, 201);
    const proposalId = (created.body as { proposal: { id: string; status: string } }).proposal.id;
    assert.match(proposalId, /^proposal:/);

    const queue = await routeHttpRequest(root, "GET", "/api/v1/proposals?status=open&limit=5");
    assert.equal(queue.status, 200);
    assert.equal((queue.body as { proposals: Array<{ id: string }>; total: number }).proposals[0]?.id, proposalId);
    assert.equal((queue.body as { proposals: Array<{ id: string }>; total: number }).total, 1);

    const secondCreated = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: "page:concept:agent-memory",
        body: "# Agent Memory\n\nA second proposal exercises queue pagination.",
        actor_id: "actor:agent:http-client",
        rationale: "Second HTTP adapter pagination test.",
      },
      { scopes: scopesForRole("contributor") },
    );
    assert.equal(secondCreated.status, 201);
    const firstProposalPage = await routeHttpRequest(root, "GET", "/api/v1/proposals?status=open&limit=1");
    assert.equal(firstProposalPage.status, 200);
    const firstProposalPageBody = firstProposalPage.body as { proposals: Array<{ id: string }>; next_cursor?: string };
    assert.equal(firstProposalPageBody.proposals.length, 1);
    assert.ok(firstProposalPageBody.next_cursor);
    const secondProposalPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/proposals?status=open&limit=1&cursor=${encodeURIComponent(firstProposalPageBody.next_cursor ?? "")}`,
    );
    assert.equal(secondProposalPage.status, 200);
    assert.notEqual(
      (secondProposalPage.body as { proposals: Array<{ id: string }> }).proposals[0]?.id,
      firstProposalPageBody.proposals[0]?.id,
    );

    const detail = await routeHttpRequest(root, "GET", `/api/v1/proposals/${encodeURIComponent(proposalId)}/detail`);
    assert.equal(detail.status, 200);
    const detailBody = detail.body as {
      proposal: { id: string };
      diff?: { body: string };
      snapshot?: { body: string };
      validation_report?: { status: string };
    };
    assert.equal(detailBody.proposal.id, proposalId);
    assert.match(detailBody.diff?.body ?? "", /HTTP clients can propose/);
    assert.match(detailBody.snapshot?.body ?? "", /HTTP clients can propose/);
    assert.equal(detailBody.validation_report?.status, "passed");

    const diff = await routeHttpRequest(root, "GET", `/api/v1/proposals/${encodeURIComponent(proposalId)}/diff`);
    assert.equal(diff.status, 200);
    assert.match((diff.body as { diff?: { body: string } }).diff?.body ?? "", /HTTP clients can propose/);

    const webQueue = await routeHttpRequest(root, "GET", "/proposals?status=open");
    assert.equal(webQueue.status, 200);
    assert.match(String(webQueue.body), /Proposal Queue/);
    assert.match(String(webQueue.body), /HTTP adapter smoke test/);
    assert.match(String(webQueue.body), /validation captured/);
    assert.match(String(webQueue.body), /needs review/);

    const webProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`);
    assert.equal(webProposal.status, 200);
    assert.match(String(webProposal.body), /Validation/);
    assert.doesNotMatch(String(webProposal.body), /Review Decision/);
    assert.doesNotMatch(String(webProposal.body), /Close Without Applying/);
    assert.match(String(webProposal.body), /HTTP clients can propose/);
    assert.match(String(webProposal.body), /class="ow-breadcrumb"/);
    assert.match(String(webProposal.body), /class="ow-article-meta"/);
    assert.match(String(webProposal.body), /<dt>Status<\/dt>/);
    assert.match(String(webProposal.body), /<dt>Diff<\/dt><dd><a href="\/api\/v1\/proposals\//);
    assert.match(String(webProposal.body), /class="ow-diff"/);
    assert.match(String(webProposal.body), /data-graph-mode="local"/);

    const reviewerWebProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`, undefined, {
      actorId: "actor:user:reviewer",
      scopes: scopesForRole("reviewer"),
    });
    assert.equal(reviewerWebProposal.status, 200);
    assert.match(String(reviewerWebProposal.body), /Review Decision/);
    assert.match(String(reviewerWebProposal.body), /Close Without Applying/);
    assert.match(String(reviewerWebProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/review"`));
    assert.match(String(reviewerWebProposal.body), /name="decision"/);
    assert.match(String(reviewerWebProposal.body), /name="actor_id"/);
    assert.match(String(reviewerWebProposal.body), /name="rationale"/);
    assert.match(String(reviewerWebProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/comment"`));
    assert.match(String(reviewerWebProposal.body), /name="body"/);

    const webProposalDiff = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}/diff`);
    assert.equal(webProposalDiff.status, 200);
    assert.match(String(webProposalDiff.body), /Diff: Edit Agent Memory/);
    assert.match(String(webProposalDiff.body), /class="ow-diff"/);
    assert.match(String(webProposalDiff.body), /HTTP clients can propose/);

    const adjacentProposalJson = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}.json`);
    assert.equal(adjacentProposalJson.status, 200);
    assert.equal((adjacentProposalJson.body as { id: string }).id, proposalId);

    const reviewed = await routeHttpRequest(
      root,
      "POST",
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        decision: "accepted",
        rationale: "The change is scoped.",
        actor_id: "actor:user:maintainer",
      },
      { scopes: scopesForRole("reviewer") },
    );
    assert.equal(reviewed.status, 200);
    assert.equal((reviewed.body as { proposal: { status: string } }).proposal.status, "accepted");
    const decisionId = (reviewed.body as { decision: { id: string } }).decision.id;

    const webDecisionDiff = await routeHttpRequest(root, "GET", `/decisions/${encodeURIComponent(decisionId)}/diff`);
    assert.equal(webDecisionDiff.status, 200);
    assert.match(String(webDecisionDiff.body), /class="ow-diff/);

    const traceAfterReview = await routeHttpRequest(root, "GET", "/api/v1/claims/claim%3A2026-05-21-001/trace");
    assert.equal(traceAfterReview.status, 200);
    const traceAfterReviewBody = traceAfterReview.body as {
      proposals: Array<{ id: string }>;
      decisions: Array<{ id: string }>;
      evidence_summary: { accepted_decision_count: number };
    };
    assert.ok(traceAfterReviewBody.proposals.some((proposal) => proposal.id === proposalId));
    assert.ok(traceAfterReviewBody.decisions.some((decision) => decision.id === decisionId));
    assert.equal(traceAfterReviewBody.evidence_summary.accepted_decision_count, 1);

    const deniedApply = await routeHttpRequest(
      root,
      "POST",
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/apply`,
      {
        actor_id: "actor:user:maintainer",
      },
      { scopes: scopesForRole("reviewer") },
    );
    assert.equal(deniedApply.status, 403);

    const applied = await routeHttpRequest(
      root,
      "POST",
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/apply`,
      {
        actor_id: "actor:user:maintainer",
      },
      { scopes: scopesForRole("maintainer") },
    );
    assert.equal(applied.status, 200);
    assert.equal((applied.body as { proposal: { status: string } }).proposal.status, "applied");

    const webDecision = await routeHttpRequest(root, "GET", `/decisions/${encodeURIComponent(decisionId)}`);
    assert.equal(webDecision.status, 200);
    assert.match(String(webDecision.body), /The change is scoped/);
    assert.match(String(webDecision.body), /class="ow-breadcrumb"/);
    assert.match(String(webDecision.body), /class="ow-article-meta"/);
    assert.match(String(webDecision.body), /<dt>Decision<\/dt>/);
    assert.match(String(webDecision.body), /Decision JSON/);
    assert.match(String(webDecision.body), /data-graph-mode="local"/);

    const adjacentDecisionJson = await routeHttpRequest(root, "GET", `/decisions/${encodeURIComponent(decisionId)}.json`);
    assert.equal(adjacentDecisionJson.status, 200);
    assert.equal((adjacentDecisionJson.body as { id: string }).id, decisionId);

    const decision = await routeHttpRequest(root, "GET", `/api/v1/decisions/${encodeURIComponent(decisionId)}`);
    assert.equal(decision.status, 200);
    assert.equal((decision.body as { id: string; decision: string }).id, decisionId);
    assert.equal((decision.body as { id: string; decision: string }).decision, "accepted");

    const decisionHistory = await routeHttpRequest(root, "GET", `/api/v1/decisions/${encodeURIComponent(decisionId)}/history`);
    assert.equal(decisionHistory.status, 200);
    assert.equal((decisionHistory.body as { record_id: string }).record_id, decisionId);

    const page = await readPage(root, "page:concept:agent-memory");
    assert.match(page.body, /HTTP clients can propose, review, and apply page edits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
