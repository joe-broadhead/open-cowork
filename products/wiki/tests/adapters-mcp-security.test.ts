import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP proposal detail rejects artifacts not bound to the proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-artifact-binding-"));
  try {
    await createWorkspace(root, "MCP Artifact Binding Wiki");
    const firstProposalId = await proposeEdit(root, 1, "# Agent Memory\n\nFirst proposal owns this diff.");
    const secondProposalId = await proposeEdit(root, 2, "# Agent Memory\n\nSecond proposal owns this diff.");
    const firstProposalPath = path.join(root, "proposals", `${proposalStem(firstProposalId)}.yaml`);
    const originalProposalBody = await readFile(firstProposalPath, "utf8");

    await writeFile(
      firstProposalPath,
      originalProposalBody.replace(
        `path: proposals/diffs/${proposalStem(firstProposalId)}.diff`,
        `path: proposals/diffs/${proposalStem(secondProposalId)}.diff`,
      ),
    );

    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "wiki.read_proposal_detail",
          arguments: { id: firstProposalId },
        },
      }),
      /not bound to proposal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function proposeEdit(root: string, id: number, body: string): Promise<string> {
  const proposed = await handleMcpRequest(
    root,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "wiki.propose_edit",
        arguments: {
          page_id: "page:concept:agent-memory",
          body,
          actor_id: "actor:agent:wiki-editor",
          rationale: "Artifact binding regression fixture.",
        },
      },
    },
    { toolMode: "write" },
  );
  return (proposed as { structuredContent: { proposal: { id: string } } }).structuredContent.proposal.id;
}

function proposalStem(id: string): string {
  return id.replace(/:/g, "_").replace(/-/g, "_");
}
