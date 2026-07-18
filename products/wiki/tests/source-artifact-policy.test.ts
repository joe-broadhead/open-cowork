import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("source content reads authorize Git raw artifact paths separately from visible manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-source-artifact-policy-"));
  try {
    await createWorkspace(root, "Source Artifact Policy Wiki");
    await mkdir(path.join(root, "sources", "raw", "private"), { recursive: true });
    await writeFile(path.join(root, "sources", "raw", "private", "secret-note.md"), "Private raw source body");
    await writeFile(
      path.join(root, "sources", "manifests", "public-pointer.yaml"),
      [
        "id: source:public:pointer",
        "title: Public Pointer Source",
        "source_type: manual",
        "retrieved_at: 2026-06-02T00:00:00.000Z",
        "storage:",
        "  kind: git",
        "  path: sources/raw/private/secret-note.md",
      ].join("\n") + "\n",
    );
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          { id: "section:public-source", title: "Public Source Manifest", paths: ["sources/manifests/public-pointer.yaml"], visibility: "public" },
          { id: "section:private-raw", title: "Private Raw Sources", paths: ["sources/raw/private/**"], visibility: "private" },
        ],
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, "policy", "grants.json"),
      JSON.stringify(
        [
          { principal: "group:all-users", section: "section:public-source", role: "viewer" },
          { principal: "group:raw", section: "section:private-raw", role: "viewer" },
        ],
        null,
        2,
      ) + "\n",
    );

    const visibleSource = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3Apublic%3Apointer");
    assert.equal(visibleSource.status, 200);
    assert.equal((visibleSource.body as { id?: string }).id, "source:public:pointer");

    const deniedHttpContent = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3Apublic%3Apointer/content");
    assert.equal(deniedHttpContent.status, 403);
    assert.match(JSON.stringify(deniedHttpContent.body), /sources\/raw\/private\/secret-note\.md/);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "mcp-source-artifact-denied",
          method: "tools/call",
          params: { name: "wiki.read_source", arguments: { id: "source:public:pointer", include_content: true } },
        },
        { scopes: scopesForRole("viewer") },
      ),
      /sources\/raw\/private\/secret-note\.md/,
    );

    const allowedHttpContent = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3Apublic%3Apointer/content", undefined, {
      scopes: scopesForRole("viewer"),
      principals: ["group:raw"],
    });
    assert.equal(allowedHttpContent.status, 200);
    assert.match(JSON.stringify(allowedHttpContent.body), /Private raw source body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
