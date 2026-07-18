import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OpenWikiConfig } from "@openwiki/core";
import { routeHttpRequest, startHttpApi, type HttpRouteResult } from "@openwiki/http-api";
import { hashOpenWikiToken } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { canSeeAdminSurface, httpCanReadPostgresRecordEntry, httpCanSeeUnfilteredIndex } from "../packages/http-api/src/auth.ts";

test("OAuth authorization code with PKCE resolves into bounded MCP policy and supports refresh and revoke", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-code-"));
  try {
    await createWorkspace(root, "OAuth Code Wiki");
    await configureOAuth(root, {
      enabled: true,
      issuer: "http://localhost:3030",
      clients: [
        {
          client_id: "openclaw-local",
          client_name: "OpenClaw Local",
          public: true,
          redirect_uris: ["http://localhost/callback"],
          actor_id: "actor:agent:openclaw",
          role: "viewer",
          scopes: ["wiki:read", "wiki:search", "wiki:ask"],
          grant_types: ["authorization_code", "refresh_token"],
          bounds: {
            operations: ["wiki.list_recent_changes"],
            tool_modes: ["read"],
          },
          access_token_ttl_seconds: 60,
          refresh_token_ttl_seconds: 3600,
        },
      ],
    });

    const verifier = "local-openclaw-verifier-value-that-is-long-enough";
    const authorize = await authorizeOAuthCodeWithConsent(
      root,
      `/oauth/authorize?response_type=code&client_id=openclaw-local&redirect_uri=${encodeURIComponent("http://localhost/callback")}&code_challenge_method=S256&code_challenge=${pkceChallenge(verifier)}&scope=${encodeURIComponent("wiki:read wiki:search wiki:ask")}&state=abc`,
      { actorId: "actor:user:owner", role: "viewer", principals: ["group:owner"] },
    );
    assert.equal(authorize.status, 302);
    const code = new URL(authorize.headers?.location ?? "").searchParams.get("code");
    assert.ok(code);

    const codeAttempts = await Promise.all([
      routeHttpRequest(root, "POST", "/oauth/token", {
        grant_type: "authorization_code",
        client_id: "openclaw-local",
        code,
        redirect_uri: "http://localhost/callback",
        code_verifier: verifier,
      }),
      routeHttpRequest(root, "POST", "/oauth/token", {
        grant_type: "authorization_code",
        client_id: "openclaw-local",
        code,
        redirect_uri: "http://localhost/callback",
        code_verifier: verifier,
      }),
    ]);
    const token = codeAttempts.find((attempt) => attempt.status === 200) ?? codeAttempts[0]!;
    const replayedCode = codeAttempts.find((attempt) => attempt.status !== 200) ?? codeAttempts[1]!;
    assert.equal(token.status, 200);
    assert.equal(replayedCode.status, 400);
    const tokenBody = token.body as { access_token: string; refresh_token: string; token_type: string };
    assert.equal(tokenBody.token_type, "Bearer");
    assert.ok(tokenBody.access_token.startsWith("owat_"));
    assert.ok(tokenBody.refresh_token.startsWith("owrt_"));

    const stateText = await readFile(path.join(root, ".openwiki", "runtime", "oauth-state.json"), "utf8");
    assert.equal(stateText.includes(tokenBody.access_token), false);
    assert.equal(stateText.includes(tokenBody.refresh_token), false);

    const recentChanges = await callMcpTool(root, tokenBody.access_token, "wiki.list_recent_changes", { limit: 1 });
    assert.equal(recentChanges.status, 200);
    assert.equal((recentChanges.body as { error?: unknown }).error, undefined);

    const listedTools = await listMcpTools(root, tokenBody.access_token);
    assert.equal(listedTools.status, 200);
    const tools = (listedTools.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, ["wiki.list_recent_changes"]);

    const denied = await callMcpTool(root, tokenBody.access_token, "wiki.ask", { question: "What is this?" });
    assert.equal(denied.status, 200);
    assert.match(JSON.stringify(denied.body), /outside this credential's policy bounds/);

    const refreshAttempts = await Promise.all([
      routeHttpRequest(root, "POST", "/oauth/token", {
        grant_type: "refresh_token",
        client_id: "openclaw-local",
        refresh_token: tokenBody.refresh_token,
      }),
      routeHttpRequest(root, "POST", "/oauth/token", {
        grant_type: "refresh_token",
        client_id: "openclaw-local",
        refresh_token: tokenBody.refresh_token,
      }),
    ]);
    const refreshed = refreshAttempts.find((attempt) => attempt.status === 200) ?? refreshAttempts[0]!;
    const replayedRefresh = refreshAttempts.find((attempt) => attempt.status !== 200) ?? refreshAttempts[1]!;
    assert.equal(refreshed.status, 200);
    assert.equal(replayedRefresh.status, 400);
    const refreshedBody = refreshed.body as { access_token: string; refresh_token: string };
    assert.notEqual(refreshedBody.access_token, tokenBody.access_token);
    assert.notEqual(refreshedBody.refresh_token, tokenBody.refresh_token);

    const revoke = await routeHttpRequest(root, "POST", "/oauth/revoke", {
      client_id: "openclaw-local",
      token: refreshedBody.access_token,
    });
    assert.equal(revoke.status, 200);
    const revokedSearch = await callMcpTool(root, refreshedBody.access_token, "wiki.list_recent_changes", { limit: 1 });
    assert.equal(revokedSearch.status, 401);

    const expiring = await routeHttpRequest(root, "POST", "/oauth/token", {
      grant_type: "refresh_token",
      client_id: "openclaw-local",
      refresh_token: refreshedBody.refresh_token,
    });
    assert.equal(expiring.status, 200);
    const expiringBody = expiring.body as { access_token: string };
    await expireAccessToken(root, expiringBody.access_token);
    const expiredSearch = await callMcpTool(root, expiringBody.access_token, "wiki.list_recent_changes", { limit: 1 });
    assert.equal(expiredSearch.status, 401);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth authorization code cannot grant scopes above the authenticated actor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-scope-ceiling-"));
  try {
    await createWorkspace(root, "OAuth Scope Ceiling Wiki");
    await configureOAuth(root, {
      enabled: true,
      issuer: "http://localhost:3030",
      clients: [
        {
          client_id: "admin-client",
          client_name: "Admin Client",
          public: true,
          redirect_uris: ["http://localhost/callback"],
          actor_id: "actor:agent:admin-client",
          role: "admin",
          scopes: ["wiki:admin"],
          grant_types: ["authorization_code"],
        },
      ],
    });

    const authorize = await routeHttpRequest(
      root,
      "GET",
      `/oauth/authorize?response_type=code&client_id=admin-client&redirect_uri=${encodeURIComponent("http://localhost/callback")}&code_challenge_method=S256&code_challenge=${pkceChallenge("viewer-verifier-value-that-is-long-enough")}&scope=${encodeURIComponent("wiki:admin")}`,
      undefined,
      { actorId: "actor:user:viewer", role: "viewer" },
    );
    assert.equal(authorize.status, 400);
    assert.match(JSON.stringify(authorize.body), /authenticated actor grant/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth client credentials work for trusted automation while DCR stays disabled by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-client-"));
  try {
    await createWorkspace(root, "OAuth Client Wiki");
    await configureOAuth(root, {
      enabled: true,
      issuer: "http://localhost:3030",
      clients: [
        {
          client_id: "trusted-ci",
          client_name: "Trusted CI",
          public: false,
          redirect_uris: ["http://localhost/callback"],
          client_secret_hashes: [hashOpenWikiToken("trusted-ci-secret")],
          actor_id: "actor:agent:trusted-ci",
          role: "viewer",
          scopes: ["wiki:read", "wiki:search"],
          grant_types: ["client_credentials"],
          bounds: { operations: ["wiki.list_recent_changes"] },
        },
      ],
    });

    const register = await routeHttpRequest(root, "POST", "/oauth/register", {
      redirect_uris: ["http://localhost/callback"],
    });
    assert.equal(register.status, 403);

    const token = await routeHttpRequest(root, "POST", "/oauth/token", {
      grant_type: "client_credentials",
      client_id: "trusted-ci",
      client_secret: "trusted-ci-secret",
      scope: "wiki:read",
    });
    assert.equal(token.status, 200);
    const body = token.body as { access_token: string; refresh_token?: string };
    assert.ok(body.access_token.startsWith("owat_"));
    assert.equal(body.refresh_token, undefined);

    const search = await callMcpTool(root, body.access_token, "wiki.list_recent_changes", { limit: 1 });
    assert.equal(search.status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth hosted HTTPS issuer requires shared Postgres state", async () => {
  await withEnv({ OPENWIKI_RUNTIME_MODE: "hosted", OPENWIKI_OAUTH_STATE_BACKEND: undefined, OPENWIKI_OPERATIONAL_STATE_BACKEND: undefined, OPENWIKI_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-hosted-state-"));
    try {
      await createWorkspace(root, "OAuth Hosted State Wiki");
      await configureOAuth(root, {
        enabled: true,
        issuer: "https://wiki.example.com",
        clients: [],
      });
      const metadata = await routeHttpRequest(root, "GET", "/.well-known/oauth-authorization-server");
      assert.equal(metadata.status, 503);
      assert.match(JSON.stringify(metadata.body), /OAuth.*state.*postgres/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("OAuth hosted bearer resolution ignores file-backed state", async () => {
  await withEnv({ OPENWIKI_RUNTIME_MODE: "hosted", OPENWIKI_OAUTH_STATE_BACKEND: undefined, OPENWIKI_OPERATIONAL_STATE_BACKEND: undefined, OPENWIKI_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-hosted-bearer-"));
    try {
      await createWorkspace(root, "OAuth Hosted Bearer Wiki");
      await configureOAuth(root, {
        enabled: true,
        issuer: "https://wiki.example.com",
        clients: [],
      });
      const token = "owat_stale_file_backed_token";
      const statePath = path.join(root, ".openwiki", "runtime", "oauth-state.json");
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({
        dynamic_clients: [],
        authorization_codes: [],
        access_tokens: [
          {
            id: "oauth-access:stale",
            token_hash: hashOpenWikiToken(token),
            client_id: "stale-file-client",
            actor_id: "actor:agent:stale",
            scopes: ["wiki:read"],
            role: "viewer",
            created_at: "2026-06-14T00:00:00.000Z",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        ],
        refresh_tokens: [],
      }, null, 2)}\n`);

      const index = await routeHttpRequest(root, "GET", "/api/v1/index", undefined, { token });
      assert.equal(index.status, 401);
      assert.match(JSON.stringify(index.body), /requires.*token|trusted identity/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("OAuth Postgres state path runs runtime migrations unless disabled", async () => {
  const source = await readFile(path.join(process.cwd(), "packages/http-api/src/oauth-runtime.ts"), "utf8");
  assert.match(source, /migratePostgresRuntime/);
  assert.match(source, /function ensureOAuthPostgresState/);
  assert.match(source, /OPENWIKI_POSTGRES_MIGRATE === "0"/);
  assert.match(source, /await ensureOAuthPostgresState\(resolved\)/);
  assert.match(source, /await ensureOAuthPostgresState\(\{ enabled: true, stateBackend: "postgres" \}\)/);
});

test("OAuth dynamic clients are pending until explicitly approved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-dcr-pending-"));
  try {
    await createWorkspace(root, "OAuth DCR Pending Wiki");
    await configureOAuth(root, {
      enabled: true,
      issuer: "http://localhost:3030",
      dynamic_client_registration: {
        enabled: true,
        default_role: "viewer",
        default_scopes: ["wiki:read", "wiki:search"],
      },
      clients: [],
    });

    const registered = await routeHttpRequest(root, "POST", "/oauth/register", {
      redirect_uris: ["http://localhost/callback"],
      client_name: "Pending Client",
    });
    assert.equal(registered.status, 201);
    const clientId = (registered.body as { client_id?: string; approval_status?: string }).client_id;
    assert.equal((registered.body as { approval_status?: string }).approval_status, "pending");
    assert.match((registered.body as { approval_endpoint?: string }).approval_endpoint ?? "", /\/oauth\/clients\/owc_[a-f0-9]+\/approve$/);
    assert.ok(clientId);

    const verifier = "pending-client-verifier-value-that-is-long-enough";
    const pendingAuthorize = await routeHttpRequest(
      root,
      "GET",
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://localhost/callback")}&code_challenge_method=S256&code_challenge=${pkceChallenge(verifier)}&scope=${encodeURIComponent("wiki:read")}`,
      undefined,
      { actorId: "actor:user:owner", role: "viewer" },
    );
    assert.equal(pendingAuthorize.status, 403);
    assert.match(JSON.stringify(pendingAuthorize.body), /administrator approval/);

    const boundedAdminApproval = await routeHttpRequest(
      root,
      "POST",
      `/oauth/clients/${encodeURIComponent(clientId)}/approve`,
      undefined,
      { actorId: "actor:user:bounded-admin", role: "admin", bounds: { pathPrefixes: ["wiki/public"] } },
    );
    assert.equal(boundedAdminApproval.status, 403);

    const approval = await routeHttpRequest(
      root,
      "POST",
      `/oauth/clients/${encodeURIComponent(clientId)}/approve`,
      undefined,
      { actorId: "actor:user:owner", role: "admin" },
    );
    assert.equal(approval.status, 200);
    assert.equal((approval.body as { approval_status?: string }).approval_status, "approved");

    const authorized = await authorizeOAuthCodeWithConsent(
      root,
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://localhost/callback")}&code_challenge_method=S256&code_challenge=${pkceChallenge(verifier)}&scope=${encodeURIComponent("wiki:read")}`,
      { actorId: "actor:user:owner", role: "viewer" },
    );
    assert.equal(authorized.status, 302);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth token endpoint accepts standard form requests through the HTTP server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-form-"));
  const previousOrigin = process.env.OPENWIKI_PUBLIC_ORIGIN;
  let server: Awaited<ReturnType<typeof startHttpApi>> | undefined;
  try {
    await createWorkspace(root, "OAuth Form Wiki");
    await configureOAuth(root, {
      enabled: true,
      issuer: "http://localhost:3030",
      clients: [
        {
          client_id: "trusted-form",
          public: false,
          redirect_uris: ["http://localhost/callback"],
          client_secret_hashes: [hashOpenWikiToken("trusted-form-secret")],
          actor_id: "actor:agent:trusted-form",
          role: "viewer",
          scopes: ["wiki:read"],
          grant_types: ["client_credentials"],
        },
      ],
    });
    delete process.env.OPENWIKI_PUBLIC_ORIGIN;
    server = await startHttpApi({ root, host: "127.0.0.1", port: 0 });

    const response = await fetch(`${server.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "trusted-form",
        client_secret: "trusted-form-secret",
        scope: "wiki:read",
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { access_token?: string; token_type?: string };
    assert.equal(body.token_type, "Bearer");
    assert.ok(body.access_token?.startsWith("owat_"));
  } finally {
    if (server !== undefined) {
      await server.close();
    }
    if (previousOrigin === undefined) {
      delete process.env.OPENWIKI_PUBLIC_ORIGIN;
    } else {
      process.env.OPENWIKI_PUBLIC_ORIGIN = previousOrigin;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth fails closed when enabled without an issuer or public origin", async () => {
  await withEnv({ OPENWIKI_PUBLIC_ORIGIN: undefined, OPENWIKI_OAUTH_ISSUER: undefined, OPENWIKI_OAUTH_ENABLED: undefined }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-missing-origin-"));
    try {
      await createWorkspace(root, "OAuth Missing Origin Wiki");
      await configureOAuth(root, { enabled: true, clients: [] });
      const metadata = await routeHttpRequest(root, "GET", "/.well-known/oauth-authorization-server");
      assert.equal(metadata.status, 503);
      assert.match(JSON.stringify(metadata.body), /issuer/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("OAuth env toggle accepts Helm boolean values", async () => {
  await withEnv({ OPENWIKI_OAUTH_ENABLED: "true", OPENWIKI_OAUTH_ISSUER: "http://localhost:3030" }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-oauth-env-"));
    try {
      await createWorkspace(root, "OAuth Env Wiki");
      const metadata = await routeHttpRequest(root, "GET", "/.well-known/oauth-authorization-server");
      assert.equal(metadata.status, 200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("bounded admin policies cannot use unfiltered hosted read shortcuts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-bounded-admin-"));
  const boundedAdmin = {
    role: "admin" as const,
    scopes: ["wiki:admin" as const],
    bounds: { pathPrefixes: ["wiki/allowed"] },
  };

  assert.equal(httpCanSeeUnfilteredIndex({ role: "admin" }), true);
  assert.equal(canSeeAdminSurface({ role: "admin" }), true);
  assert.equal(httpCanSeeUnfilteredIndex(boundedAdmin), false);
  assert.equal(canSeeAdminSurface(boundedAdmin), false);
  assert.equal(httpCanReadPostgresRecordEntry(boundedAdmin, { sensitivity: "private" }), false);
  assert.equal(httpCanReadPostgresRecordEntry(boundedAdmin, { sensitivity: "public" }), false);

  try {
    await createWorkspace(root, "Bounded Admin Wiki");
    const deniedLogs = await routeHttpRequest(root, "GET", "/api/v1/auth/request-logs", undefined, boundedAdmin);
    assert.equal(deniedLogs.status, 403);
    const allowedLogs = await routeHttpRequest(root, "GET", "/api/v1/auth/request-logs", undefined, { scopes: ["wiki:admin"] });
    assert.equal(allowedLogs.status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function callMcpTool(root: string, accessToken: string, name: string, args: Record<string, unknown>): Promise<HttpRouteResult> {
  return routeHttpRequest(
    root,
    "POST",
    "/mcp?tools=read",
    {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
    { token: accessToken },
  );
}

async function listMcpTools(root: string, accessToken: string): Promise<HttpRouteResult> {
  return routeHttpRequest(
    root,
    "POST",
    "/mcp?tools=read",
    {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    },
    { token: accessToken },
  );
}

async function authorizeOAuthCodeWithConsent(root: string, authorizeUrl: string, policy: Parameters<typeof routeHttpRequest>[4]): Promise<HttpRouteResult> {
  const consent = await routeHttpRequest(root, "GET", authorizeUrl, undefined, policy);
  assert.equal(consent.status, 200);
  assert.equal(consent.contentType, "text/html; charset=utf-8");
  assert.equal(await authorizationCodeCount(root), 0);
  return routeHttpRequest(root, "POST", "/oauth/authorize", hiddenFormFields(String(consent.body)), policy);
}

async function authorizationCodeCount(root: string): Promise<number> {
  const statePath = path.join(root, ".openwiki", "runtime", "oauth-state.json");
  const stateText = await readFile(statePath, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (stateText === undefined) {
    return 0;
  }
  const state = JSON.parse(stateText) as { authorization_codes?: unknown[] };
  return state.authorization_codes?.length ?? 0;
}

function hiddenFormFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      fields[htmlUnescape(name)] = htmlUnescape(value);
    }
  }
  return fields;
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

async function configureOAuth(root: string, oauth: NonNullable<OpenWikiConfig["auth"]>["oauth"]): Promise<void> {
  const filePath = path.join(root, "openwiki.json");
  const config = JSON.parse(await readFile(filePath, "utf8")) as OpenWikiConfig;
  await writeFile(
    filePath,
    `${JSON.stringify({ ...config, runtime: { ...(config.runtime ?? {}), profile: "hosted" }, auth: { ...(config.auth ?? {}), oauth } }, null, 2)}\n`,
  );
}

async function expireAccessToken(root: string, accessToken: string): Promise<void> {
  const statePath = path.join(root, ".openwiki", "runtime", "oauth-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as { access_tokens: Array<{ token_hash: string; expires_at: string }> };
  const tokenHash = hashOpenWikiToken(accessToken);
  for (const token of state.access_tokens) {
    if (token.token_hash === tokenHash) {
      token.expires_at = "2000-01-01T00:00:00.000Z";
    }
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
