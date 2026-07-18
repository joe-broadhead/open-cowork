import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, readPage } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("HTTP web forms drive proposal governance with policy scopes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-web-write-"));
  try {
    await createWorkspace(root, "HTTP Web Write Wiki");

    const readOnlyPage = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory");
    assert.equal(readOnlyPage.status, 200);
    assert.doesNotMatch(String(readOnlyPage.body), /Suggest Edit/);
    assert.doesNotMatch(String(readOnlyPage.body), /Suggest edit/);

    const readOnlyEditForm = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory/edit");
    assert.equal(readOnlyEditForm.status, 403);

    const contributorPage = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory", undefined, { scopes: scopesForRole("contributor") });
    assert.equal(contributorPage.status, 200);
    assert.match(String(contributorPage.body), /Suggest Edit/);

    const denied = await routeHttpRequest(root, "POST", "/pages/page%3Aconcept%3Aagent-memory/propose", {
      body: "# Agent Memory\n\nThis web edit should require proposal scope.",
      rationale: "Denied write test.",
    });
    assert.equal(denied.status, 403);

    const created = await routeHttpRequest(
      root,
      "POST",
      "/pages/page%3Aconcept%3Aagent-memory/propose",
      {
        body: "# Agent Memory\n\nWeb forms can propose, review, and apply page edits.",
        summary: "Web governance flow.",
        actor_id: "actor:user:web",
        rationale: "Web form smoke test.",
      },
      { scopes: scopesForRole("contributor") },
    );
    assert.equal(created.status, 303);
    assert.match(created.headers?.location ?? "", /^\/proposals\/proposal%3A/);
    const proposalId = decodeURIComponent((created.headers?.location ?? "").replace("/proposals/", ""));

    const openProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`);
    assert.equal(openProposal.status, 200);
    assert.doesNotMatch(String(openProposal.body), /Record Decision/);
    assert.doesNotMatch(String(openProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/review"`));

    const reviewerOpenProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`, undefined, { scopes: scopesForRole("reviewer") });
    assert.equal(reviewerOpenProposal.status, 200);
    assert.match(String(reviewerOpenProposal.body), /Record Decision/);

    const reviewed = await routeHttpRequest(
      root,
      "POST",
      `/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        decision: "accepted",
        rationale: "The web form edit is scoped.",
        actor_id: "actor:user:web-reviewer",
      },
      { scopes: scopesForRole("reviewer") },
    );
    assert.equal(reviewed.status, 303);

    const acceptedProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`);
    assert.equal(acceptedProposal.status, 200);
    assert.doesNotMatch(String(acceptedProposal.body), /Apply Proposal/);
    assert.doesNotMatch(String(acceptedProposal.body), /Apply To Git/);
    assert.doesNotMatch(String(acceptedProposal.body), /Close Without Applying/);
    assert.doesNotMatch(String(acceptedProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/apply"`));

    const maintainerAcceptedProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposalId)}`, undefined, { scopes: scopesForRole("maintainer") });
    assert.equal(maintainerAcceptedProposal.status, 200);
    assert.match(String(maintainerAcceptedProposal.body), /Apply Proposal/);
    assert.match(String(maintainerAcceptedProposal.body), /Apply To Git/);
    assert.match(String(maintainerAcceptedProposal.body), /Close Without Applying/);
    assert.match(String(maintainerAcceptedProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/apply"`));
    assert.match(String(maintainerAcceptedProposal.body), /name="actor_id"/);
    assert.match(String(maintainerAcceptedProposal.body), new RegExp(`method="post" action="/proposals/${encodeURIComponent(proposalId)}/close"`));
    assert.match(String(maintainerAcceptedProposal.body), /name="superseded_by"/);
    assert.match(String(maintainerAcceptedProposal.body), /name="rationale"/);

    const applied = await routeHttpRequest(
      root,
      "POST",
      `/proposals/${encodeURIComponent(proposalId)}/apply`,
      {
        actor_id: "actor:user:web-maintainer",
      },
      { scopes: scopesForRole("maintainer") },
    );
    assert.equal(applied.status, 303);

    const page = await readPage(root, "page:concept:agent-memory");
    assert.match(page.body, /Web forms can propose, review, and apply page edits/);

    const previousCorsOrigin = process.env.OPENWIKI_CORS_ORIGIN;
    delete process.env.OPENWIKI_CORS_ORIGIN;
    const server = await startHttpApi({ root, port: 0, defaultPolicy: { role: "maintainer" } });
    try {
      const livez = await fetch(`${server.url}/livez`);
      assert.equal(livez.headers.get("access-control-allow-origin"), null);

      const missingOrigin = await fetch(`${server.url}/pages/page%3Aconcept%3Aagent-memory/propose`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          body: "# Agent Memory\n\nForm-encoded bodies create proposals through the web server.",
          actor_id: "actor:user:web",
          rationale: "Form parser smoke test.",
        }).toString(),
        redirect: "manual",
      });
      assert.equal(missingOrigin.status, 403);

      const badOrigin = await fetch(`${server.url}/pages/page%3Aconcept%3Aagent-memory/propose`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "origin": "https://attacker.example",
        },
        body: new URLSearchParams({
          body: "# Agent Memory\n\nCross-site form posts should be rejected.",
          actor_id: "actor:user:web",
          rationale: "CSRF smoke test.",
        }).toString(),
        redirect: "manual",
      });
      assert.equal(badOrigin.status, 403);

      const nullOrigin = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "null",
        },
        body: "{}",
      });
      assert.equal(nullOrigin.status, 403);

      const apiBadOrigin = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://attacker.example",
        },
        body: "{}",
      });
      assert.equal(apiBadOrigin.status, 403);

      const apiSameOrigin = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": server.url,
        },
        body: "{}",
      });
      assert.equal(apiSameOrigin.status, 200);

      const trustedHeaderApiWithoutBrowserMetadata = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openwiki-proxy-secret": "proxy-secret-for-csrf-test",
          "x-openwiki-role": "admin",
          "x-openwiki-actor": "actor:user:web-admin",
        },
        body: "{}",
      });
      assert.equal(trustedHeaderApiWithoutBrowserMetadata.status, 403);

      const response = await fetch(`${server.url}/pages/page%3Aconcept%3Aagent-memory/propose`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "origin": server.url,
        },
        body: new URLSearchParams({
          body: "# Agent Memory\n\nForm-encoded bodies create proposals through the web server.",
          actor_id: "actor:user:web",
          rationale: "Form parser smoke test.",
        }).toString(),
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.match(response.headers.get("location") ?? "", /^\/proposals\/proposal%3A/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
      if (previousCorsOrigin === undefined) {
        delete process.env.OPENWIKI_CORS_ORIGIN;
      } else {
        process.env.OPENWIKI_CORS_ORIGIN = previousCorsOrigin;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Postgres-backed page view uses path authorization for suggest edit affordance", async () => {
  const source = await readFile(path.join(process.cwd(), "packages", "http-api", "src", "renderers", "content.ts"), "utf8");
  assert.match(source, /const repo = await loadRepository\(root\);/);
  assert.match(source, /const canSuggestEdit = canUsePathOperation\(repo, policy, "wiki\.propose_edit", page\.path\);/);
  assert.doesNotMatch(source, /const canSuggestEdit = admin;/);
});
