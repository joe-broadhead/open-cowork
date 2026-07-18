import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { routeHttpRequest } from "@openwiki/http-api";
import { hashOpenWikiToken } from "@openwiki/policy";
import { createWorkspace, loadRepository } from "@openwiki/repo";

const execFileAsync = promisify(execFile);

interface CliTokenResult {
  service_account: {
    id: string;
    actor_id: string;
    role?: string;
    scopes?: string[];
    principals?: string[];
    token_hash_count: number;
    active_token_count: number;
    revoked_token_count: number;
    expired_token_count: number;
    tokens: Array<{ id: string; status: string; created_at?: string; expires_at?: string }>;
    token_hashes?: unknown;
  };
  token: {
    id: string;
    value: string;
    created_at: string;
    expires_at?: string;
  };
}

interface ConfigShape {
  auth?: {
    service_accounts?: Array<{
      id: string;
      actor_id: string;
      role?: string;
      token_hashes?: string[];
      tokens?: Array<{ id: string; token_hash: string; revoked_at?: string }>;
    }>;
  };
}

interface McpJsonRpcResponse {
  result?: { structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
}

test("CLI manages service-account tokens without leaking secrets and MCP honors rotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-auth-token-"));
  try {
    await createWorkspace(root, { template: "team-wiki", title: "Auth Token Wiki" });
    const repo = await loadRepository(root);
    const page = repo.pages[0];
    assert.ok(page);

    const created = await runJsonCli<CliTokenResult>(root, [
      "auth",
      "token",
      "create",
      "--id",
      "service:test-proposal-agent",
      "--profile",
      "proposal-agent",
      "--actor",
      "actor:agent:test-proposal",
      "--description",
      "Proposal agent for tests",
      "--expires-in-days",
      "7",
      "--json",
    ]);
    assert.match(created.token.value, /^owk_agent_/);
    assert.equal(countOccurrences(created.stdout, created.token.value), 1);

    const configText = await readFile(path.join(root, "openwiki.json"), "utf8");
    assert.doesNotMatch(configText, new RegExp(escapeRegExp(created.token.value)));
    const config = JSON.parse(configText) as ConfigShape;
    const account = config.auth?.service_accounts?.find((candidate) => candidate.id === "service:test-proposal-agent");
    assert.equal(account?.actor_id, "actor:agent:test-proposal");
    assert.equal(account?.role, "contributor");
    assert.equal(account?.tokens?.[0]?.token_hash, hashOpenWikiToken(created.token.value));
    assert.equal(account?.token_hashes, undefined);

    const listed = await runJsonCli<{ service_accounts: unknown[] }>(root, ["auth", "token", "list", "--json"]);
    assert.equal(listed.service_accounts.length, 1);
    assertRedacted(listed.stdout, created.token.value);

    const inspected = await runJsonCli<{ service_account: CliTokenResult["service_account"] }>(root, [
      "auth",
      "token",
      "inspect",
      "service:test-proposal-agent",
      "--json",
    ]);
    assert.equal(inspected.service_account.active_token_count, 1);
    assert.equal(inspected.service_account.tokens[0]?.status, "active");
    assert.equal(inspected.service_account.token_hashes, undefined);
    assertRedacted(inspected.stdout, created.token.value);

    const deniedHttpList = await routeHttpRequest(root, "GET", "/api/v1/auth/service-accounts");
    assert.equal(deniedHttpList.status, 403);

    const httpList = await routeHttpRequest(root, "GET", "/api/v1/auth/service-accounts", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:security-admin",
    });
    assert.equal(httpList.status, 200);
    assertRedacted(JSON.stringify(httpList.body), created.token.value);
    assert.equal((httpList.body as { service_accounts: Array<CliTokenResult["service_account"]> }).service_accounts[0]?.active_token_count, 1);

    const httpInspect = await routeHttpRequest(root, "GET", "/api/v1/auth/service-accounts/" + encodeURIComponent("service:test-proposal-agent"), undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:security-admin",
    });
    assert.equal(httpInspect.status, 200);
    assertRedacted(JSON.stringify(httpInspect.body), created.token.value);

    const serviceAccountsPage = await routeHttpRequest(root, "GET", "/admin/service-accounts", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:security-admin",
    });
    assert.equal(serviceAccountsPage.status, 200);
    assert.match(String(serviceAccountsPage.body), /Service Accounts/);
    assert.match(String(serviceAccountsPage.body), /Token Metadata/);
    assert.match(String(serviceAccountsPage.body), /Revoke Token/);
    assertRedacted(String(serviceAccountsPage.body), created.token.value);

    const identities = await runJsonCli<{
      identities: { service_accounts: Array<CliTokenResult["service_account"]> };
    }>(root, ["policy", "identities", "--json"]);
    assert.equal(identities.identities.service_accounts[0]?.active_token_count, 1);
    assert.equal(identities.identities.service_accounts[0]?.token_hashes, undefined);
    assertRedacted(identities.stdout, created.token.value);

    const proposal = await mcpCall(root, "proposal", created.token.value, "wiki.propose_edit", {
      page_id: page.id,
      body: `# ${page.title}\n\nProposal tokens can suggest changes but cannot apply them.`,
      rationale: "Exercise proposal-mode service-account token.",
    });
    assert.equal(proposal.error, undefined);
    assert.ok(proposal.result);

    const deniedWrite = await mcpCall(root, "write", created.token.value, "wiki.run_lint", {});
    assert.equal(deniedWrite.error?.code, -32001);
    assert.match(deniedWrite.error?.message ?? "", /wiki:patch/);

    const maintainer = await runJsonCli<CliTokenResult>(root, [
      "auth",
      "token",
      "create",
      "--id",
      "service:test-maintainer",
      "--profile",
      "maintainer-automation",
      "--expires-in-days",
      "7",
      "--json",
    ]);
    const write = await mcpCall(root, "write", maintainer.token.value, "wiki.run_lint", {});
    assert.equal(write.error, undefined);
    assert.equal(write.result?.structuredContent?.status, "passed");

    const httpCreated = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/auth/service-accounts",
      {
        id: "service:http-readonly",
        profile: "hosted-readonly-agent",
        actor_id: "actor:agent:http-readonly",
        groups: ["readers"],
        expires_in_days: 7,
      },
      { scopes: ["wiki:admin"], actorId: "actor:user:security-admin" },
    );
    assert.equal(httpCreated.status, 201);
    const httpCreatedBody = httpCreated.body as CliTokenResult;
    assert.match(httpCreatedBody.token.value, /^owk_read_/);
    assert.equal(countOccurrences(JSON.stringify(httpCreated.body), httpCreatedBody.token.value), 1);
    const httpCreatedList = await routeHttpRequest(root, "GET", "/api/v1/auth/service-accounts", undefined, { scopes: ["wiki:admin"] });
    assertRedacted(JSON.stringify(httpCreatedList.body), httpCreatedBody.token.value);

    const inboxSubmitter = await runJsonCli<CliTokenResult>(root, [
      "auth",
      "token",
      "create",
      "--id",
      "service:test-inbox-submitter",
      "--profile",
      "inbox-submitter",
      "--expires-in-days",
      "7",
      "--json",
    ]);
    assert.match(inboxSubmitter.token.value, /^owk_submit_/);
    assert.equal(inboxSubmitter.service_account.role, undefined);
    assert.deepEqual(inboxSubmitter.service_account.scopes, ["wiki:inbox:read", "wiki:inbox:submit"]);
    assert.deepEqual(inboxSubmitter.service_account.principals, ["group:all-users"]);

    const inboxCurator = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/auth/service-accounts",
      {
        id: "service:http-inbox-curator",
        profile: "inbox-curator",
        expires_in_days: 7,
      },
      { scopes: ["wiki:admin"], actorId: "actor:user:security-admin" },
    );
    assert.equal(inboxCurator.status, 201);
    const inboxCuratorBody = inboxCurator.body as CliTokenResult;
    assert.match(inboxCuratorBody.token.value, /^owk_curate_/);
    assert.equal(inboxCuratorBody.service_account.role, undefined);
    assert.ok(inboxCuratorBody.service_account.scopes?.includes("wiki:inbox:process"));
    assert.ok(!inboxCuratorBody.service_account.scopes?.includes("wiki:commit"));
    assert.deepEqual(inboxCuratorBody.service_account.principals, ["group:knowledge-maintainers"]);

    const rotated = await runJsonCli<CliTokenResult>(root, [
      "auth",
      "token",
      "rotate",
      "service:test-proposal-agent",
      "--token-id",
      created.token.id,
      "--expires-in-days",
      "7",
      "--json",
    ]);
    assert.match(rotated.token.value, /^owk_agent_/);
    assert.notEqual(rotated.token.value, created.token.value);
    assert.equal(countOccurrences(rotated.stdout, rotated.token.value), 1);

    const httpRotated = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/auth/service-accounts/" + encodeURIComponent("service:http-readonly") + "/rotate",
      { expires_in_days: 7 },
      { scopes: ["wiki:admin"], actorId: "actor:user:security-admin" },
    );
    assert.equal(httpRotated.status, 200);
    const httpRotatedBody = httpRotated.body as CliTokenResult;
    assert.match(httpRotatedBody.token.value, /^owk_agent_|^owk_read_/);

    const oldTokenDenied = await mcpCall(root, "proposal", created.token.value, "wiki.propose_edit", {
      page_id: page.id,
      body: `# ${page.title}\n\nThe old token should not be accepted after rotation.`,
      rationale: "Exercise rotated token denial.",
    });
    assert.equal(oldTokenDenied.error?.code, -32001);

    const newTokenProposal = await mcpCall(root, "proposal", rotated.token.value, "wiki.propose_edit", {
      page_id: page.id,
      body: `# ${page.title}\n\nThe rotated token remains authorized for proposal mode.`,
      rationale: "Exercise rotated token authorization.",
    });
    assert.equal(newTokenProposal.error, undefined);
    assert.ok(newTokenProposal.result);

    const revoked = await runJsonCli<{ revoked_token_ids: string[] }>(root, [
      "auth",
      "token",
      "revoke",
      "service:test-proposal-agent",
      "--token-id",
      rotated.token.id,
      "--reason",
      "test complete",
      "--json",
    ]);
    assert.deepEqual(revoked.revoked_token_ids, [rotated.token.id]);

    const httpRevoked = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/auth/service-accounts/" + encodeURIComponent("service:http-readonly") + "/revoke",
      { reason: "test cleanup" },
      { scopes: ["wiki:admin"], actorId: "actor:user:security-admin" },
    );
    assert.equal(httpRevoked.status, 200);
    assert.ok((httpRevoked.body as { revoked_token_ids: string[] }).revoked_token_ids.length > 0);
    assertRedacted(JSON.stringify(httpRevoked.body), httpRotatedBody.token.value);

    const revokedDenied = await mcpCall(root, "proposal", rotated.token.value, "wiki.propose_edit", {
      page_id: page.id,
      body: `# ${page.title}\n\nRevoked tokens should not be accepted.`,
      rationale: "Exercise revoked token denial.",
    });
    assert.equal(revokedDenied.error?.code, -32001);

    const events = await readFile(path.join(root, "events", "events.jsonl"), "utf8");
    assert.match(events, /auth\.token\.created/);
    assert.match(events, /auth\.token\.rotated/);
    assert.match(events, /auth\.token\.revoked/);
    assert.doesNotMatch(events, new RegExp(escapeRegExp(created.token.value)));
    assert.doesNotMatch(events, new RegExp(escapeRegExp(rotated.token.value)));
    assert.doesNotMatch(events, /sha256:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runJsonCli<T>(root: string, args: string[]): Promise<T & { stdout: string }> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--no-warnings",
    "--import",
    "tsx",
    path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
    "--root",
    root,
    ...args,
  ]);
  return { ...(JSON.parse(stdout) as T), stdout };
}

async function mcpCall(root: string, mode: "proposal" | "write", token: string, name: string, args: Record<string, unknown>): Promise<McpJsonRpcResponse> {
  const result = await routeHttpRequest(
    root,
    "POST",
    `/mcp?tools=${mode}`,
    {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { token },
  );
  assert.equal(result.status, 200);
  return result.body as McpJsonRpcResponse;
}

function assertRedacted(output: string, token: string): void {
  assert.doesNotMatch(output, new RegExp(escapeRegExp(token)));
  assert.doesNotMatch(output, /sha256:/);
}

function countOccurrences(value: string, needle: string): number {
  return value.match(new RegExp(escapeRegExp(needle), "g"))?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
