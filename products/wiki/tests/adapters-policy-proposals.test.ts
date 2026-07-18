import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("policy changes are governed through proposals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-policy-proposal-"));
  try {
    await createWorkspace(root, "Policy Proposal Wiki");

    const deniedRead = await routeHttpRequest(root, "GET", "/api/v1/policy");
    assert.equal(deniedRead.status, 403);

    const readPolicy = await routeHttpRequest(root, "GET", "/api/v1/policy", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:admin",
    });
    assert.equal(readPolicy.status, 200);
    assert.equal((readPolicy.body as { policy: { sections: unknown[] } }).policy.sections.length, 1);

    const nextSections = [
      ...(readPolicy.body as { policy: { sections: unknown[] } }).policy.sections,
      {
        id: "section:finance",
        title: "Finance",
        paths: ["wiki/finance/**"],
        visibility: "private",
      },
    ];

    const deniedProposal = await routeHttpRequest(root, "POST", "/api/v1/policy/proposals", {
      policy_file: "sections",
      records: nextSections,
      actor_id: "actor:user:employee",
      rationale: "Should require admin.",
    });
    assert.equal(deniedProposal.status, 403);

    const proposed = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/policy/proposals",
      {
        policy_file: "sections",
        records: nextSections,
        actor_id: "actor:user:admin",
        rationale: "Add private finance section.",
      },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(proposed.status, 201);
    const proposedBody = proposed.body as { proposal: { id: string; target_path: string }; validation: { status: string } };
    assert.equal(proposedBody.proposal.target_path, "policy/sections.json");
    assert.equal(proposedBody.validation.status, "passed");

    const webPolicyProposal = await routeHttpRequest(root, "GET", `/proposals/${encodeURIComponent(proposedBody.proposal.id)}`, undefined, {
      scopes: scopesForRole("admin"),
    });
    assert.equal(webPolicyProposal.status, 200);
    assert.match(String(webPolicyProposal.body), /Policy Scope And Blast Radius/);
    assert.match(String(webPolicyProposal.body), /policy\/sections\.json/);

    const mcpPolicy = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "read-policy",
        method: "tools/call",
        params: { name: "wiki.read_policy", arguments: {} },
      },
      { toolMode: "write", scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal((mcpPolicy as { structuredContent: { policy: { grants: unknown[] } } }).structuredContent.policy.grants.length, 1);

    const mcpProposal = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "propose-policy",
        method: "tools/call",
        params: {
          name: "wiki.propose_policy",
          arguments: {
            policy_file: "grants",
            body: JSON.stringify((mcpPolicy as { structuredContent: { policy: { grants: unknown[] } } }).structuredContent.policy.grants, null, 2),
            actor_id: "actor:user:admin",
            rationale: "MCP policy proposal smoke test.",
          },
        },
      },
      { toolMode: "write", scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(
      (mcpProposal as { structuredContent: { proposal: { target_path: string } } }).structuredContent.proposal.target_path,
      "policy/grants.json",
    );

    const mcpSectionProposal = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "propose-section-policy",
        method: "tools/call",
        params: {
          name: "wiki.propose_section_policy",
          arguments: {
            section_id: "section:ops",
            title: "Operations",
            paths: ["wiki/ops/**"],
            visibility: "private",
            viewer_principals: ["group:ops"],
            reviewer_principals: ["group:ops-reviewers"],
            admin_principals: ["group:ops-admins"],
            actor_id: "actor:user:admin",
            rationale: "MCP section policy proposal smoke test.",
          },
        },
      },
      { toolMode: "write", scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(
      (mcpSectionProposal as { structuredContent: { proposal: { target_path: string } } }).structuredContent.proposal.target_path,
      "policy",
    );
    const sectionProposalId = (mcpSectionProposal as { structuredContent: { proposal: { id: string } } }).structuredContent.proposal.id;
    const sectionProposalEvent = (await loadRepository(root)).events.find(
      (event) => event.type === "proposal.created" && event.record_id === sectionProposalId,
    );
    assert.equal(sectionProposalEvent?.operation, "wiki.propose_section_policy");

    const reviewed = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposedBody.proposal.id) + "/review",
      { decision: "accepted", rationale: "Policy change reviewed.", actor_id: "actor:user:admin" },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(reviewed.status, 200);

    const applied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(proposedBody.proposal.id) + "/apply",
      { actor_id: "actor:user:admin" },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(applied.status, 200);

    const repo = await loadRepository(root);
    assert.ok(repo.policy.sections.some((section) => section.id === "section:finance"));
    assert.match(await readFile(path.join(root, "policy", "sections.json"), "utf8"), /section:finance/);

    const webPolicy = await routeHttpRequest(root, "GET", "/policy", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:admin",
    });
    assert.equal(webPolicy.status, 200);
    assert.match(String(webPolicy.body), /Edit Advanced Policy/);
    assert.match(String(webPolicy.body), /Create Space/);
    assert.match(String(webPolicy.body), /Edit Space Proposal/);
    assert.match(String(webPolicy.body), /method="get" action="\/spaces\/preview"/);
    assert.match(String(webPolicy.body), /method="post" action="\/policy\/sections\/propose"/);
    assert.match(String(webPolicy.body), /method="post" action="\/policy\/propose"/);
    for (const fieldName of [
      "actor_id",
      "role",
      "principal",
      "target_path",
      "target_id",
      "operation",
      "replace_grants",
      "section_id",
      "title",
      "paths",
      "visibility",
      "owner_principal",
      "contributor_principals",
      "reviewer_principals",
      "maintainer_principals",
      "admin_principals",
      "viewer_principals",
      "policy_file",
      "body",
      "rationale",
    ]) {
      assert.match(String(webPolicy.body), new RegExp(`name="${fieldName}"`));
    }

    const previewPage = await routeHttpRequest(
      root,
      "GET",
      "/spaces/preview?actor_id=" +
        encodeURIComponent("actor:user:employee") +
        "&principal=" +
        encodeURIComponent("group:finance") +
        "&target_path=" +
        encodeURIComponent("wiki/finance/budget.md") +
        "&operation=wiki.propose_edit",
      undefined,
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(previewPage.status, 200);
    assert.match(String(previewPage.body), /Permission Preview/);
    assert.match(String(previewPage.body), /Matching Spaces/);
    assert.match(String(previewPage.body), /wiki\.propose_edit/);

    const sectionProposal = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/policy/sections/proposals",
      {
        section_id: "section:hr",
        title: "HR",
        paths: ["wiki/hr/**", "sources/hr/**", "claims/hr/**"],
        visibility: "private",
        owner_principal: "group:hr-admins",
        viewer_principals: ["group:hr"],
        reviewer_principals: ["group:hr-reviewers"],
        admin_principals: ["group:hr-admins"],
        actor_id: "actor:user:admin",
        rationale: "Add governed HR section.",
      },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(sectionProposal.status, 201);
    const sectionProposalBody = sectionProposal.body as {
      proposal: { id: string; target_path: string; target_ids: string[]; snapshot_paths?: Record<string, string> };
      validation: { status: string };
    };
    assert.equal(sectionProposalBody.proposal.target_path, "policy");
    assert.deepEqual(sectionProposalBody.proposal.target_ids, ["policy:sections", "policy:grants", "policy:approval-rules"]);
    assert.ok(sectionProposalBody.proposal.snapshot_paths?.sections);
    assert.equal(sectionProposalBody.proposal.snapshot_paths.sections.endsWith("/sections.json"), true);
    assert.equal(sectionProposalBody.validation.status, "passed");

    const sectionSnapshot = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/proposals/" + encodeURIComponent(sectionProposalBody.proposal.id) + "/snapshot",
      undefined,
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(sectionSnapshot.status, 200);
    assert.match(JSON.stringify((sectionSnapshot.body as { snapshots?: unknown }).snapshots), /section:hr/);

    const sectionReviewed = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(sectionProposalBody.proposal.id) + "/review",
      { decision: "accepted", rationale: "HR policy reviewed.", actor_id: "actor:user:admin" },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(sectionReviewed.status, 200);

    const sectionApplied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals/" + encodeURIComponent(sectionProposalBody.proposal.id) + "/apply",
      { actor_id: "actor:user:admin" },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(sectionApplied.status, 200);
    assert.deepEqual((sectionApplied.body as { applied_paths: string[] }).applied_paths, [
      "policy/sections.json",
      "policy/grants.json",
      "policy/approval-rules.json",
    ]);

    const appliedRepo = await loadRepository(root);
    assert.ok(appliedRepo.policy.sections.some((section) => section.id === "section:hr" && section.owner_principal === "group:hr-admins"));
    assert.ok(appliedRepo.policy.grants.some((grant) => grant.section === "section:hr" && grant.principal === "group:hr-reviewers" && grant.role === "reviewer"));
    assert.ok(appliedRepo.policy.grants.some((grant) => grant.section === "section:hr" && grant.principal === "group:hr-admins" && grant.role === "admin"));
    assert.ok(
      appliedRepo.policy.approval_rules.some(
        (rule) =>
          rule.id === "approval:hr" &&
          rule.require_separate_actor === true &&
          rule.required_reviewers?.some((reviewer) => reviewer.principal === "group:hr-reviewers"),
      ),
    );

    const sectionEditProposal = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/policy/sections/proposals",
      {
        section_id: "section:hr",
        title: "People Operations",
        paths: ["wiki/hr/**", "sources/hr/**"],
        visibility: "private",
        viewer_principals: ["group:hr-readers"],
        admin_principals: ["group:hr-admins"],
        replace_grants: true,
        actor_id: "actor:user:admin",
        rationale: "Edit HR space grants.",
      },
      { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
    );
    assert.equal(sectionEditProposal.status, 201);
    const sectionEditProposalId = (sectionEditProposal.body as { proposal: { id: string } }).proposal.id;
    assert.equal(
      (
        await routeHttpRequest(
          root,
          "POST",
          "/api/v1/proposals/" + encodeURIComponent(sectionEditProposalId) + "/review",
          { decision: "accepted", rationale: "Space edit reviewed.", actor_id: "actor:user:admin" },
          { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await routeHttpRequest(
          root,
          "POST",
          "/api/v1/proposals/" + encodeURIComponent(sectionEditProposalId) + "/apply",
          { actor_id: "actor:user:admin" },
          { scopes: ["wiki:admin"], actorId: "actor:user:admin" },
        )
      ).status,
      200,
    );
    const editedRepo = await loadRepository(root);
    assert.ok(editedRepo.policy.sections.some((section) => section.id === "section:hr" && section.title === "People Operations"));
    assert.ok(editedRepo.policy.grants.some((grant) => grant.section === "section:hr" && grant.principal === "group:hr-readers" && grant.role === "viewer"));
    assert.equal(
      editedRepo.policy.grants.some((grant) => grant.section === "section:hr" && grant.principal === "group:hr-reviewers"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
