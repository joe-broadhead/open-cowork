import { createRun } from "@openwiki/jobs";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("source fetch run records are scoped and reject secret inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-source-fetch-run-"));
  try {
    await createWorkspace(root, "Source Fetch Run Wiki");
    const run = await createRun({
      root,
      runType: "source.fetch",
      actorId: "actor:user:researcher",
      input: {
        title: "Queued Evidence",
        connector_kind: "github",
        connector_id: "github-docs",
        credential_ref: "cred:github-reader",
        github_owner: "openwiki",
        github_repo: "docs",
        source_path: "spec/openwiki.md",
        ref: "abc123",
        ignored: "not persisted",
      },
    });
    assert.deepEqual(run.input, {
      title: "Queued Evidence",
      connector_kind: "github",
      connector_id: "github-docs",
      credential_ref: "cred:github-reader",
      github_owner: "openwiki",
      github_repo: "docs",
      source_path: "spec/openwiki.md",
      ref: "abc123",
    });
    assert.deepEqual(run.subject_paths, ["sources/manifests", "sources/raw"]);
    assert.equal(run.sensitivity, "internal");

    await assert.rejects(
      createRun({
        root,
        runType: "source.fetch",
        actorId: "actor:user:researcher",
        input: {
          title: "Secret Evidence",
          url: "https://example.com/evidence.txt",
          headers: { authorization: "Bearer should-not-persist" },
        },
      }),
      /Sensitive source\.fetch run input field 'headers'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP run jobs reject unknown run types before enqueue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-run-job-"));
  try {
    await createWorkspace(root, "MCP Run Job Wiki");
    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: 71,
          method: "tools/call",
          params: {
            name: "wiki.run_job",
            arguments: {
              run_type: "unsupported.job",
              actor_id: "actor:user:maintainer",
            },
          },
        },
        { toolMode: "write", role: "admin" },
      ),
      /Unsupported OpenWiki run type/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
