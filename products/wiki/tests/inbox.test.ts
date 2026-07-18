import { routeHttpRequest } from "@openwiki/http-api";
import { createRun, executeRun } from "@openwiki/jobs";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, listInboxItems, loadRepository, readInboxPayload } from "@openwiki/repo";
import { exportStaticSite } from "@openwiki/static-export";
import { inboxMetricsSnapshot, processInboxItem, resetInboxMetricsForTests, submitInboxItem, watchInboxOnce } from "@openwiki/workflows";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("inbox records are idempotent, permissioned, processable, and private to static export", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-"));
  try {
    await createWorkspace(root, "Inbox Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Acme weekly sync",
      content: "Alice and Bob discussed renewal risk and next steps.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
      metadata: { meeting_date: "2026-05-31" },
    });
    assert.equal(submitted.duplicate, false);
    assert.equal(submitted.item.status, "received");
    assert.equal(submitted.item.sensitivity, "private");
    assert.ok(submitted.payload_path?.startsWith("inbox/payloads/"));

    const duplicate = await submitInboxItem({
      root,
      title: "Acme weekly sync duplicate",
      content: "Alice and Bob discussed renewal risk and next steps.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.existing_id, submitted.item.id);
    assert.equal((await listInboxItems(root)).total, 1);

    const otherOwnerSamePayload = await submitInboxItem({
      root,
      title: "Acme weekly sync other owner",
      content: "Alice and Bob discussed renewal risk and next steps.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:other",
      submittedBy: "actor:user:other",
    });
    assert.equal(otherOwnerSamePayload.duplicate, false);
    assert.equal((await listInboxItems(root)).total, 2);

    const payload = await readInboxPayload(root, submitted.item.id);
    assert.match(payload.content?.body ?? "", /renewal risk/);
    assert.equal(payload.content?.hash_verified, true);

    const invisibleToOtherUser = await routeHttpRequest(root, "GET", "/api/v1/inbox/items", undefined, {
      scopes: scopesForRole("contributor"),
      actorId: "actor:user:other",
    });
    assert.equal(invisibleToOtherUser.status, 200);
    assert.deepEqual(
      (invisibleToOtherUser.body as { items: Array<{ id: string }> }).items.map((item) => item.id),
      [otherOwnerSamePayload.item.id],
    );

    const blockedDetailRead = await routeHttpRequest(root, "GET", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}?include_content=true`, undefined, {
      scopes: scopesForRole("contributor"),
      actorId: "actor:user:other",
    });
    assert.equal(blockedDetailRead.status, 403);

    const blockedHttpProcess = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/process`, { dry_run: true }, {
      scopes: scopesForRole("maintainer"),
      actorId: "actor:user:other",
    });
    assert.equal(blockedHttpProcess.status, 403);

    const blockedQueuedProcess = await routeHttpRequest(root, "POST", "/api/v1/runs", { run_type: "inbox.process", input: { id: submitted.item.id } }, {
      scopes: ["wiki:patch"],
      actorId: "actor:user:joe",
    });
    assert.equal(blockedQueuedProcess.status, 403);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "blocked-inbox-run-scope",
          method: "tools/call",
          params: {
            name: "wiki.run_job",
            arguments: { run_type: "inbox.process", input: { id: submitted.item.id } },
          },
        },
        { toolMode: "write", scopes: ["wiki:patch"], actorId: "actor:user:joe" },
      ),
      /wiki:inbox:process/,
    );

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "blocked-inbox-process",
          method: "tools/call",
          params: {
            name: "wiki.inbox_process",
            arguments: { id: submitted.item.id, dry_run: true },
          },
        },
        { toolMode: "write", scopes: scopesForRole("maintainer"), actorId: "actor:user:other" },
      ),
      /not visible/,
    );
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "blocked-inbox-run-visible",
          method: "tools/call",
          params: {
            name: "wiki.run_job",
            arguments: { run_type: "inbox.process", input: { id: submitted.item.id } },
          },
        },
        { toolMode: "write", scopes: scopesForRole("maintainer"), actorId: "actor:user:other" },
      ),
      /not visible/,
    );

    const visibleToOwner = await routeHttpRequest(root, "GET", "/api/v1/inbox/items", undefined, {
      scopes: scopesForRole("contributor"),
      actorId: "actor:user:joe",
    });
    assert.equal(visibleToOwner.status, 200);
    assert.equal((visibleToOwner.body as { items: Array<{ id: string }> }).items[0]?.id, submitted.item.id);

    const processed = await processInboxItem({
      root,
      id: submitted.item.id,
      actorId: "actor:user:joe",
    });
    assert.equal(processed.item.status, "proposed");
    assert.ok(processed.source?.id.startsWith("source:"));
    assert.equal((await loadRepository(root)).inbox[0]?.source_ids?.[0], processed.source?.id);
    const processedAgain = await processInboxItem({
      root,
      id: submitted.item.id,
      actorId: "actor:user:joe",
    });
    assert.equal(processedAgain.idempotent, true);
    assert.equal(processedAgain.source?.id, processed.source?.id);
    assert.equal((await loadRepository(root)).sources.filter((source) => source.trust?.inbox_item_id === submitted.item.id).length, 1);

    const out = await exportStaticSite({ root, outDir: "public" });
    assert.ok(!out.files.some((file) => file.startsWith("inbox") || file.includes("inbox")));
    const searchRecords = await readFile(path.join(out.outDir, "search-records.jsonl"), "utf8");
    assert.doesNotMatch(searchRecords, /Acme weekly sync/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local write-mode MCP can read and process inbox items it submitted without explicit actor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-mcp-local-"));
  try {
    await createWorkspace(root, "Inbox MCP Local Wiki");

    const submitted = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "local-inbox-submit",
        method: "tools/call",
        params: {
          name: "wiki.inbox_submit",
          arguments: {
            title: "Local MCP inbox item",
            content: "Local stdio MCP should be able to complete its own inbox loop.",
          },
        },
      },
      { toolMode: "write" },
    );
    const submittedContent = submitted as {
      structuredContent: { item: { id: string; owner_actor_id?: string; submitted_by?: string } };
    };
    const inboxItemId = submittedContent.structuredContent.item.id;
    assert.equal(submittedContent.structuredContent.item.owner_actor_id, "actor:agent:openwiki-mcp");
    assert.equal(submittedContent.structuredContent.item.submitted_by, "actor:agent:openwiki-mcp");

    const listed = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "local-inbox-list",
        method: "tools/call",
        params: {
          name: "wiki.inbox_list",
          arguments: { statuses: ["received"] },
        },
      },
      { toolMode: "write" },
    );
    assert.deepEqual(
      (listed as { structuredContent: { items: Array<{ id: string }> } }).structuredContent.items.map((item) => item.id),
      [inboxItemId],
    );

    const read = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "local-inbox-read",
        method: "tools/call",
        params: {
          name: "wiki.inbox_read",
          arguments: { id: inboxItemId, include_content: true },
        },
      },
      { toolMode: "write" },
    );
    assert.match((read as { structuredContent: { content?: { body?: string } } }).structuredContent.content?.body ?? "", /complete its own inbox loop/);

    const processed = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "local-inbox-process",
        method: "tools/call",
        params: {
          name: "wiki.inbox_process",
          arguments: { id: inboxItemId, dry_run: true },
        },
      },
      { toolMode: "write" },
    );
    assert.equal((processed as { structuredContent: { dry_run: boolean; item: { id: string } } }).structuredContent.dry_run, true);
    assert.equal((processed as { structuredContent: { dry_run: boolean; item: { id: string } } }).structuredContent.item.id, inboxItemId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readInboxPayload rejects corrupted git payload content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-hash-"));
  try {
    await createWorkspace(root, "Inbox Hash Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Hash checked payload",
      content: "Original inbox payload",
      inboxKind: "note",
      provider: "test",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });
    assert.ok(submitted.payload_path);
    await writeFile(path.join(root, submitted.payload_path), "tampered payload");

    const payload = await readInboxPayload(root, submitted.item.id);
    assert.equal(payload.content, null);
    assert.equal(payload.unavailable_reason, "hash_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP and MCP inbox submission expose the shared workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-adapter-"));
  try {
    await createWorkspace(root, "Inbox Adapter Wiki");
    const httpSubmit = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/inbox/items",
      {
        title: "HTTP transcript",
        content: "HTTP-created transcript.",
        kind: "meeting_transcript",
        provider: "transcript_file",
        submitted_by: "actor:user:spoofed",
      },
      { scopes: scopesForRole("contributor"), actorId: "actor:user:http" },
    );
    assert.equal(httpSubmit.status, 201);
    assert.equal((httpSubmit.body as { item: { owner_actor_id: string } }).item.owner_actor_id, "actor:user:http");
    assert.equal((httpSubmit.body as { item: { submitted_by: string } }).item.submitted_by, "actor:user:http");

    const pageId = (await loadRepository(root)).pages[0]?.id;
    assert.equal(typeof pageId, "string");
    const httpProposal = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: pageId,
        body: "# Agent Memory\n\nAuthenticated actors own their proposal audit trail.",
        actor_id: "actor:user:spoofed",
        rationale: "Actor spoof regression test.",
      },
      { scopes: scopesForRole("contributor"), actorId: "actor:user:http" },
    );
    assert.equal(httpProposal.status, 201);
    assert.equal((httpProposal.body as { proposal: { actor_id: string } }).proposal.actor_id, "actor:user:http");

    const principalOnlyHttpProposal = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/proposals",
      {
        page_id: pageId,
        body: "# Agent Memory\n\nPrincipal-only contexts must not accept caller-supplied actor IDs.",
        actor_id: "actor:user:spoofed",
        rationale: "Principal-only actor spoof regression test.",
      },
      { scopes: scopesForRole("contributor"), principals: ["group:knowledge-contributors"] },
    );
    assert.equal(principalOnlyHttpProposal.status, 201);
    assert.equal((principalOnlyHttpProposal.body as { proposal: { actor_id: string } }).proposal.actor_id, "actor:user:local");

    const blockedOwnerSpoof = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/inbox/items",
      {
        title: "HTTP owner spoof",
        content: "This must not be filed into another user's inbox.",
        kind: "meeting_transcript",
        provider: "transcript_file",
        owner_actor_id: "actor:user:someone-else",
      },
      { scopes: scopesForRole("contributor"), actorId: "actor:user:http" },
    );
    assert.equal(blockedOwnerSpoof.status, 403);

    const mcpSubmit = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "wiki.inbox_submit",
          arguments: {
            title: "MCP transcript",
            content: "MCP-created transcript.",
            kind: "meeting_transcript",
            provider: "transcript_file",
          },
        },
      },
      { toolMode: "proposal", actorId: "actor:user:mcp" },
    );
    assert.equal((mcpSubmit as { structuredContent: { item: { title: string } } }).structuredContent.item.title, "MCP transcript");

    const mcpProposal = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "mcp-actor-spoof",
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: pageId,
            body: "# Agent Memory\n\nMCP authenticated actors own their proposal audit trail.",
            actor_id: "actor:user:spoofed",
          },
        },
      },
      { toolMode: "proposal", actorId: "actor:user:mcp" },
    );
    assert.equal(
      (mcpProposal as { structuredContent: { proposal: { actor_id: string } } }).structuredContent.proposal.actor_id,
      "actor:user:mcp",
    );

    const principalOnlyMcpProposal = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "mcp-principal-only-actor-spoof",
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: pageId,
            body: "# Agent Memory\n\nMCP principal-only contexts must not accept caller-supplied actor IDs.",
            actor_id: "actor:user:spoofed",
          },
        },
      },
      { toolMode: "proposal", principals: ["group:knowledge-contributors"] },
    );
    assert.equal(
      (principalOnlyMcpProposal as { structuredContent: { proposal: { actor_id: string } } }).structuredContent.proposal.actor_id,
      "actor:user:local",
    );

    const mcpList = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "wiki.inbox_list", arguments: { owner_actor_id: "actor:user:mcp" } },
      },
      { toolMode: "proposal", actorId: "actor:user:mcp" },
    );
    assert.equal((mcpList as { structuredContent: { total: number } }).structuredContent.total, 1);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "blocked-mcp-owner-spoof",
          method: "tools/call",
          params: {
            name: "wiki.inbox_submit",
            arguments: {
              title: "MCP owner spoof",
              content: "This must not be filed into another user's inbox.",
              owner_actor_id: "actor:user:someone-else",
            },
          },
        },
        { toolMode: "proposal", actorId: "actor:user:mcp" },
      ),
      /wiki:inbox:admin/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox watcher ingests transcript files with provider metadata and deduplicates by content hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-watch-root-"));
  const inboxDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-watch-src-"));
  try {
    await createWorkspace(root, "Inbox Watch Wiki");
    await writeFile(path.join(inboxDir, "2026-05-31-acme.md"), "# Acme meeting\n\nDiscussed launch blockers.\n");
    await writeFile(path.join(inboxDir, "2026-05-31-acme.md.json"), JSON.stringify({ title: "Acme Launch Meeting", provider: "transcript_file", participants: ["Alice"] }));
    const first = await watchInboxOnce({
      root,
      dir: inboxDir,
      adapter: "file",
      inboxKind: "meeting_transcript",
      ownerActorId: "actor:user:joe",
    });
    assert.equal(first.scanned, 1);
    assert.equal(first.submitted, 1);
    assert.equal(first.items[0]?.provider, "transcript_file");
    assert.equal(first.items[0]?.title, "Acme Launch Meeting");

    const second = await watchInboxOnce({
      root,
      dir: inboxDir,
      adapter: "file",
      inboxKind: "meeting_transcript",
      ownerActorId: "actor:user:joe",
    });
    assert.equal(second.duplicates, 1);

    const badDir = path.join(root, "incoming");
    await mkdir(badDir);
    await assert.rejects(
      watchInboxOnce({ root, dir: badDir, adapter: "file" }),
      /must not be inside the live OpenWiki workspace/,
    );

    const linkDir = path.join(path.dirname(inboxDir), `openwiki-inbox-watch-link-${Date.now()}`);
    await symlink(badDir, linkDir, "dir");
    await assert.rejects(
      watchInboxOnce({ root, dir: linkDir, adapter: "file" }),
      /must not be inside the live OpenWiki workspace/,
    );
    await rm(linkDir, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("queued inbox processing is idempotent under concurrent workers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-queue-"));
  try {
    await createWorkspace(root, "Inbox Queue Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Concurrent meeting",
      content: "One transcript should become one canonical source.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });
    const [firstRun, secondRun] = await Promise.all([
      createRun({ root, runType: "inbox.process", actorId: "actor:user:joe", input: { id: submitted.item.id } }),
      createRun({ root, runType: "inbox.process", actorId: "actor:user:joe", input: { id: submitted.item.id } }),
    ]);
    const [first, second] = await Promise.all([
      executeRun({ root, runId: firstRun.id, workerId: "actor:agent:worker_a" }),
      executeRun({ root, runId: secondRun.id, workerId: "actor:agent:worker_b" }),
    ]);
    assert.equal(first.run.status, "succeeded");
    assert.equal(second.run.status, "succeeded");
    const repo = await loadRepository(root);
    const item = repo.inbox.find((candidate) => candidate.id === submitted.item.id);
    assert.equal(item?.status, "proposed");
    assert.equal(item?.run_ids?.length, 2);
    assert.equal(repo.sources.filter((source) => source.trust?.inbox_item_id === submitted.item.id).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox processing jobs enforce target Space maintainer access before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-space-auth-"));
  try {
    await createWorkspace(root, { title: "Inbox Space Auth Wiki", template: "team-wiki" });
    const blockedSpaceSubmit = await routeHttpRequest(root, "POST", "/api/v1/inbox/items", {
      title: "Unauthorized Space submission",
      content: "This actor is not a contributor to the Team Knowledge Space.",
      target_space_id: "section:team-knowledge",
    }, {
      scopes: scopesForRole("contributor"),
      actorId: "actor:user:visitor",
    });
    assert.equal(blockedSpaceSubmit.status, 403);

    const allowedSpaceSubmit = await routeHttpRequest(root, "POST", "/api/v1/inbox/items", {
      title: "Authorized Space submission",
      content: "This actor can submit into the Team Knowledge Space.",
      target_space_id: "section:team-knowledge",
    }, {
      scopes: scopesForRole("contributor"),
      actorId: "actor:user:contributor",
      principals: ["group:knowledge-contributors"],
    });
    assert.equal(allowedSpaceSubmit.status, 201);

    const submitted = await submitInboxItem({
      root,
      title: "Team-only meeting",
      content: "This inbox item targets the team knowledge Space.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
      targetSpaceId: "section:team-knowledge",
    });
    const visibleButNotMaintainer = {
      scopes: scopesForRole("maintainer"),
      actorId: "actor:user:joe",
    };

    const direct = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/process`, { dry_run: true }, visibleButNotMaintainer);
    assert.equal(direct.status, 403);

    const ignore = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/ignore`, { reason: "not relevant" }, visibleButNotMaintainer);
    assert.equal(ignore.status, 403);

    const retry = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/retry`, undefined, visibleButNotMaintainer);
    assert.equal(retry.status, 403);

    const enqueue = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/process`, { enqueue: true }, visibleButNotMaintainer);
    assert.equal(enqueue.status, 403);

    const runCreate = await routeHttpRequest(root, "POST", "/api/v1/runs", { run_type: "inbox.process", input: { id: submitted.item.id } }, visibleButNotMaintainer);
    assert.equal(runCreate.status, 403);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "space-auth-inbox-process",
          method: "tools/call",
          params: {
            name: "wiki.inbox_process",
            arguments: { id: submitted.item.id, dry_run: true },
          },
        },
        { toolMode: "write", scopes: scopesForRole("maintainer"), actorId: "actor:user:joe" },
      ),
      /requires maintainer access/,
    );
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "space-auth-inbox-ignore",
          method: "tools/call",
          params: {
            name: "wiki.inbox_ignore",
            arguments: { id: submitted.item.id, reason: "not relevant" },
          },
        },
        { toolMode: "write", scopes: scopesForRole("maintainer"), actorId: "actor:user:joe" },
      ),
      /requires maintainer access/,
    );
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "space-auth-inbox-retry",
          method: "tools/call",
          params: {
            name: "wiki.inbox_retry",
            arguments: { id: submitted.item.id },
          },
        },
        { toolMode: "write", scopes: scopesForRole("maintainer"), actorId: "actor:user:joe" },
      ),
      /requires maintainer access/,
    );

    const allowed = await routeHttpRequest(root, "POST", `/api/v1/inbox/items/${encodeURIComponent(submitted.item.id)}/process`, { enqueue: true }, {
      scopes: scopesForRole("maintainer"),
      actorId: "actor:user:joe",
      principals: ["group:knowledge-maintainers"],
    });
    assert.equal(allowed.status, 202);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox processor categorizes provider failures with retry hints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-failure-"));
  try {
    await createWorkspace(root, "Inbox Failure Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Timeout meeting",
      content: "This transcript waits for a provider.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });
    const result = await processInboxItem({
      root,
      id: submitted.item.id,
      actorId: "actor:user:joe",
      processor: "fake",
      fakeProviderFailure: "provider_timeout",
    });
    assert.equal(result.item.status, "failed");
    assert.equal(result.failure?.category, "provider_timeout");
    assert.equal(result.failure?.retryable, true);
    assert.match(result.failure?.next_action ?? "", /retry/i);
    assert.ok(result.failure?.next_retry_at);
    const stored = (await loadRepository(root)).inbox.find((item) => item.id === submitted.item.id);
    assert.equal(stored?.processing?.failure_category, "provider_timeout");
    assert.equal(stored?.processing?.retryable, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox metrics expose redacted processing counters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-metrics-"));
  resetInboxMetricsForTests();
  try {
    await createWorkspace(root, "Inbox Metrics Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Metrics meeting",
      content: "Sensitive transcript body should not appear in metrics.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });
    await processInboxItem({
      root,
      id: submitted.item.id,
      actorId: "actor:user:joe",
    });
    await processInboxItem({
      root,
      id: submitted.item.id,
      actorId: "actor:user:joe",
    });
    const metrics = inboxMetricsSnapshot();
    assert.equal(metrics.received.find((metric) => metric.provider === "transcript_file" && metric.status === "received")?.count, 1);
    assert.equal(metrics.duplicates.find((metric) => metric.provider === "transcript_file" && metric.stage === "process")?.count, 1);
    assert.ok(metrics.processing_duration_seconds.some((metric) => metric.status === "succeeded"));
    const response = await routeHttpRequest(root, "GET", "/metrics", undefined, {
      actorId: "actor:user:metrics-admin",
      role: "admin",
    });
    assert.equal(response.status, 200);
    const body = String(response.body);
    assert.match(body, /openwiki_inbox_received_total/);
    assert.doesNotMatch(body, /Sensitive transcript body/);
  } finally {
    resetInboxMetricsForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox metrics bucket unknown label values to bounded series", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-inbox-metrics-labels-"));
  resetInboxMetricsForTests();
  try {
    await createWorkspace(root, "Inbox Metrics Labels Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Unbounded provider label",
      content: "Metrics should not expose arbitrary provider labels.",
      inboxKind: "bespoke_type",
      provider: "customer_specific_provider",
      submittedBy: "actor:user:joe",
    });
    const metrics = inboxMetricsSnapshot();
    assert.equal(metrics.received.find((metric) => metric.provider === "other" && metric.inbox_kind === "other")?.count, 1);
    assert.equal(metrics.received.some((metric) => metric.provider === submitted.item.provider), false);
  } finally {
    resetInboxMetricsForTests();
    await rm(root, { recursive: true, force: true });
  }
});
