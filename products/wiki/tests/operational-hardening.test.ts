import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { writeOpenWikiLog } from "@openwiki/core";
import { resetHttpOperationalStateForTests, routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { createRun } from "@openwiki/jobs";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { fetchAndIngestSource, proposeEdit, resetSourceFetchMetricsForTests } from "@openwiki/workflows";
import { resetWriteCoordinationMetricsForTests } from "../packages/workflows/src/write-coordination-metrics.ts";
import { classifyOperationalRoute } from "../packages/http-api/src/operational.ts";
import { browserWriteProtectionFailure } from "../packages/http-api/src/browser-security.ts";
import { optionalRequestActor } from "../packages/http-api/src/request.ts";

const OPERATIONAL_ENV = [
  "OPENWIKI_RATE_LIMIT_ENABLED",
  "OPENWIKI_RATE_LIMIT_WINDOW_MS",
  "OPENWIKI_RATE_LIMIT_REQUESTS",
  "OPENWIKI_RATE_LIMIT_MCP",
  "OPENWIKI_RATE_LIMIT_SEARCH",
  "OPENWIKI_RATE_LIMIT_ASK",
  "OPENWIKI_RATE_LIMIT_SOURCE",
  "OPENWIKI_RATE_LIMIT_PROPOSAL",
  "OPENWIKI_RATE_LIMIT_POLICY",
  "OPENWIKI_RATE_LIMIT_INBOX",
  "OPENWIKI_RATE_LIMIT_JOB",
  "OPENWIKI_RATE_LIMIT_AUTH",
  "OPENWIKI_RATE_LIMIT_MAX_KEYS",
  "OPENWIKI_OPERATIONAL_STATE_BACKEND",
  "OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES",
  "OPENWIKI_SOURCE_FETCH_DEFAULT_MAX_BYTES",
  "OPENWIKI_SOURCE_FETCH_MAX_BYTES",
  "OPENWIKI_SOURCE_FETCH_DEFAULT_TIMEOUT_MS",
  "OPENWIKI_SOURCE_FETCH_MAX_TIMEOUT_MS",
  "OPENWIKI_REQUEST_LOGS",
  "OPENWIKI_STRUCTURED_LOGS",
  "OPENWIKI_PUBLIC_ORIGIN",
] as const;

test("HTTP rate limits reject excessive search calls while isolating actors", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_SEARCH: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rate-limit-"));
      try {
        await createWorkspace(root, "Rate Limit Wiki");

        const actorA = { actorId: "actor:user:rate-a", role: "viewer" as const };
        const actorB = { actorId: "actor:user:rate-b", role: "viewer" as const };

        const firstA = await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, actorA);
        assert.equal(firstA.status, 200);

        const firstB = await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, actorB);
        assert.equal(firstB.status, 200);

        const secondA = await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, actorA);
        assert.equal(secondA.status, 429);
        assert.equal(secondA.headers?.["x-ratelimit-limit"], "1");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("HTTP rate limits can isolate bearer-token dimensions", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_SEARCH: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-token-rate-limit-"));
      try {
        await createWorkspace(root, "Token Rate Limit Wiki");

        const tokenA = { token: "wiki:search wiki:read token-a" };
        const tokenB = { token: "wiki:search wiki:read token-b" };

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, tokenA)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, tokenB)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, tokenA)).status, 429);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("HTTP rate limits apply default buckets to protected routes without specialized buckets", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_REQUESTS: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-default-rate-limit-"));
      try {
        await createWorkspace(root, "Default Rate Limit Wiki");
        const admin = { actorId: "actor:user:admin", role: "admin" as const };

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/workspaces", undefined, admin)).status, 200);
        const limited = await routeHttpRequest(root, "GET", "/api/v1/workspaces", undefined, admin);
        assert.equal(limited.status, 429);
        assert.equal(rateLimitErrorBucket(limited.body), "default");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("HTTP rate limits use route-specific inbox and job buckets", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_REQUESTS: "100",
      OPENWIKI_RATE_LIMIT_INBOX: "1",
      OPENWIKI_RATE_LIMIT_JOB: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-specific-rate-limit-"));
      try {
        await createWorkspace(root, "Specific Rate Limit Wiki");
        const admin = { actorId: "actor:user:admin", role: "admin" as const };

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/inbox/items", undefined, admin)).status, 200);
        const inboxLimited = await routeHttpRequest(root, "GET", "/api/v1/inbox/items", undefined, admin);
        assert.equal(inboxLimited.status, 429);
        assert.equal(rateLimitErrorBucket(inboxLimited.body), "inbox");

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/runs", undefined, admin)).status, 200);
        const jobLimited = await routeHttpRequest(root, "GET", "/api/v1/runs", undefined, admin);
        assert.equal(jobLimited.status, 429);
        assert.equal(rateLimitErrorBucket(jobLimited.body), "job");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("operational classification preserves sync-now route metadata", () => {
  const route = classifyOperationalRoute("POST", new URL("https://example.test/api/v1/sync/now"));
  const wrongMethodRoute = classifyOperationalRoute("GET", new URL("https://example.test/api/v1/sync/now"));

  assert.equal(route.route, "/api/v1/sync/now");
  assert.equal(route.operation, "wiki.sync_now");
  assert.equal(route.bucket, "job");
  assert.equal(wrongMethodRoute.operation, "wiki.read");
  assert.equal(wrongMethodRoute.bucket, "default");
});

test("browser write origins do not trust arbitrary Host headers", async () => {
  await withOperationalEnv({ OPENWIKI_PUBLIC_ORIGIN: "https://wiki.example.com" }, async () => {
    const spoofed = browserWriteProtectionFailure({
      method: "POST",
      url: "/policy/propose",
      headers: {
        host: "attacker.example",
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
    } as never);
    assert.equal(spoofed?.status, 403);

    const configured = browserWriteProtectionFailure({
      method: "POST",
      url: "/policy/propose",
      headers: {
        host: "internal.service",
        origin: "https://wiki.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
    } as never);
    assert.equal(configured, undefined);

    const localDevelopment = browserWriteProtectionFailure({
      method: "POST",
      url: "/policy/propose",
      headers: {
        host: "127.0.0.1:3030",
        origin: "http://127.0.0.1:3030",
        "content-type": "application/x-www-form-urlencoded",
      },
    } as never);
    assert.equal(localDevelopment, undefined);
  });
});

test("authenticated policies ignore body actor identity", async () => {
  assert.deepEqual(optionalRequestActor({ scopes: ["wiki:patch"] }, { actor_id: "actor:user:spoofed" }), {});
  assert.deepEqual(optionalRequestActor({ actorId: "actor:user:trusted", scopes: ["wiki:patch"] }, { actor_id: "actor:user:spoofed" }), {
    actorId: "actor:user:trusted",
  });
  assert.deepEqual(optionalRequestActor({}, { actor_id: "actor:user:form" }), { actorId: "actor:user:form" });

  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-actor-spoof-route-"));
  try {
    await createWorkspace(root, "Actor Spoof Route Wiki");
    const response = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "lint", actor_id: "actor:user:spoofed" },
      { actorId: "actor:user:trusted", scopes: scopesForRole("maintainer") },
    );
    assert.equal(response.status, 202);
    assert.equal((response.body as { run: { actor_id: string } }).run.actor_id, "actor:user:trusted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source fetch budgets reject HTTP, job, and workflow requests above workspace ceilings", async () => {
  await withOperationalEnv({}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-source-budget-"));
    try {
      await createWorkspace(root, "Source Budget Wiki");
      await configureSourceFetchBudget(root, {
        max_bytes: 32,
        max_timeout_ms: 1000,
      });
      const admin = { actorId: "actor:user:admin", role: "admin" as const };

      await assert.rejects(
        fetchAndIngestSource({
          root,
          title: "Oversized Workflow Source",
          url: "https://example.com/source.md",
          maxBytes: 33,
          fetcher: async () => new Response("ok"),
        }),
        /source fetch max_bytes must be between 1 and 32/,
      );
      await assert.rejects(
        createRun({
          root,
          runType: "source.fetch",
          input: {
            title: "Oversized Queued Source",
            url: "https://example.com/source.md",
            max_bytes: 33,
          },
        }),
        /source fetch max_bytes must be between 1 and 32/,
      );
      await assert.rejects(
        routeHttpRequest(
          root,
          "POST",
          "/api/v1/sources/fetch",
          { title: "Slow HTTP Source", url: "https://example.com/source.md", timeout_ms: 1001 },
          admin,
        ),
        /source fetch timeout_ms must be between 1 and 1000/,
      );
      await assert.rejects(
        handleMcpRequest(
          root,
          {
            jsonrpc: "2.0",
            id: "source-budget",
            method: "tools/call",
            params: {
              name: "wiki.fetch_source",
              arguments: {
                title: "Oversized MCP Source",
                url: "https://example.com/source.md",
                max_bytes: 33,
                actor_id: "actor:agent:source-fetcher",
              },
            },
          },
          { toolMode: "write" },
        ),
        /source fetch max_bytes must be between 1 and 32/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("local development can explicitly disable rate limits", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "0",
      OPENWIKI_RATE_LIMIT_SEARCH: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rate-disabled-"));
      try {
        await createWorkspace(root, "Disabled Rate Limit Wiki");
        const policy = { actorId: "actor:user:local", role: "viewer" as const };

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, policy)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, policy)).status, 200);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("HTTP rate-limit key storage is capped for long-running servers", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_SEARCH: "1",
      OPENWIKI_RATE_LIMIT_MAX_KEYS: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rate-cap-"));
      try {
        await createWorkspace(root, "Rate Cap Wiki");

        const ipA = { remoteAddress: "198.51.100.10" };
        const ipB = { remoteAddress: "198.51.100.11" };

        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, {}, ipA)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, {}, ipA)).status, 429);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, {}, ipB)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, {}, ipA)).status, 200);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("HTTP MCP rate limiting uses the same token context as authorization", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_MCP: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-rate-limit-"));
      try {
        await createWorkspace(root, "MCP Rate Limit Wiki");
        const body = {
          jsonrpc: "2.0",
          id: "search",
          method: "tools/call",
          params: {
            name: "wiki.search",
            arguments: { query: "agent memory", limit: 1 },
          },
        };

        const tokenA = { token: "wiki:search wiki:read mcp-token-a" };
        const tokenB = { token: "wiki:search wiki:read mcp-token-b" };

        assert.equal((await routeHttpRequest(root, "POST", "/mcp?tools=read", body, tokenA)).status, 200);
        assert.equal((await routeHttpRequest(root, "POST", "/mcp?tools=read", body, tokenB)).status, 200);
        assert.equal((await routeHttpRequest(root, "POST", "/mcp?tools=read", body, tokenA)).status, 429);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("structured request logs redact tokens and sensitive request material", async () => {
  await withOperationalEnv({}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-request-logs-"));
    try {
      await createWorkspace(root, "Request Log Wiki");
      const logs: Array<Record<string, unknown>> = [];
      const token = "wiki:search wiki:read raw-secret-token";

      const response = await routeHttpRequest(
        root,
        "GET",
        "/api/v1/search?q=agent&limit=1",
        undefined,
        { token },
        { requestId: "request-log-test", remoteAddress: "203.0.113.10", logger: (entry) => logs.push(entry) },
      );
      assert.equal(response.status, 200);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.request_id, "request-log-test");
      assert.equal(logs[0]?.operation, "wiki.search");
      assert.equal(logs[0]?.status, 200);

      const serialized = JSON.stringify(logs);
      assert.doesNotMatch(serialized, /raw-secret-token/);
      assert.doesNotMatch(serialized, /203\.0\.113\.10/);
      assert.match(serialized, /token_hash/);
      assert.match(serialized, /ip_hash/);

      writeOpenWikiLog(
        {
          event: "redaction_probe",
          metadata: {
            authorization: "Bearer should-not-leak",
            headers: { cookie: "session=secret" },
            body: { password: "secret-password" },
            token_hash: "safe-token-hash",
          },
        },
        { sink: (entry) => logs.push(entry) },
      );
      const redacted = JSON.stringify(logs.at(-1));
      assert.doesNotMatch(redacted, /should-not-leak|session=secret|secret-password/);
      assert.match(redacted, /safe-token-hash/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("metrics expose HTTP, MCP, rate-limit, proposal, write-lock, and queue signals", async () => {
  await withOperationalEnv(
    {
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
      OPENWIKI_RATE_LIMIT_WINDOW_MS: "60000",
      OPENWIKI_RATE_LIMIT_SEARCH: "1",
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-operational-metrics-"));
      try {
        await createWorkspace(root, "Operational Metrics Wiki");
        await proposeEdit({
          root,
          pageId: "page:concept:agent-memory",
          body: "# Agent Memory\n\nOperational metrics should include proposal lifecycle events.",
          actorId: "actor:user:metrics",
          rationale: "Exercise proposal lifecycle metrics.",
        });
        await fetchAndIngestSource({
          root,
          title: "Operational Source",
          url: "https://example.com/operational-source.md",
          actorId: "actor:user:metrics",
          fetcher: async () =>
            new Response("# Operational Source\n\nFetched source metrics coverage.", {
              status: 200,
              headers: { "content-type": "text/markdown" },
            }),
        });

        const policy = { actorId: "actor:user:metrics", role: "viewer" as const };
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, policy)).status, 200);
        assert.equal((await routeHttpRequest(root, "GET", "/api/v1/search?q=agent&limit=1", undefined, policy)).status, 429);

        const mcpBody = {
          jsonrpc: "2.0",
          id: "metrics-search",
          method: "tools/call",
          params: { name: "wiki.search", arguments: { query: "agent memory", limit: 1 } },
        };
        assert.equal((await routeHttpRequest(root, "POST", "/mcp?tools=read", mcpBody, { role: "viewer" })).status, 200);

        const metrics = await routeHttpRequest(root, "GET", "/metrics", undefined, {
          actorId: "actor:user:metrics-admin",
          role: "admin",
        });
        assert.equal(metrics.status, 200);
        const text = String(metrics.body);
        assert.match(text, /openwiki_http_requests_total\{/);
        assert.match(text, /route="\/api\/v1\/search"/);
        assert.match(text, /openwiki_mcp_tool_calls_total\{/);
        assert.match(text, /tool="wiki\.search"/);
        assert.match(text, /openwiki_rate_limit_rejections_total\{/);
        assert.match(text, /openwiki_proposal_lifecycle_events_total\{/);
        assert.match(text, /openwiki_write_lock_acquisitions_total\{/);
        assert.match(text, /openwiki_write_lock_wait_seconds_total\{/);
        assert.match(text, /openwiki_queue_runs/);
        assert.match(text, /openwiki_job_duration_seconds_total/);
        assert.match(text, /openwiki_http_request_duration_seconds_bucket\{/);
        assert.match(text, /openwiki_mcp_tool_duration_seconds_bucket\{/);
        assert.match(text, /openwiki_search_duration_seconds_bucket\{/);
        assert.match(text, /openwiki_source_fetch_attempts_total\{/);
        assert.match(text, /connector_kind="http",status="success"/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

test("served HTTP MCP requests contribute to request metrics", async () => {
  await withOperationalEnv({}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-served-mcp-metrics-"));
    try {
      await createWorkspace(root, "Served MCP Metrics Wiki");
      const server = await startHttpApi({
        root,
        port: 0,
        defaultPolicy: { actorId: "actor:user:metrics-admin", role: "admin" },
      });
      try {
        const response = await fetch(`${server.url}/mcp?tools=read`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "served-mcp-request-id" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "tools",
            method: "tools/list",
          }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-request-id"), "served-mcp-request-id");
        assert.equal(response.headers.get("x-openwiki-request-id"), "served-mcp-request-id");

        const metrics = await fetch(`${server.url}/metrics`);
        assert.equal(metrics.status, 200);
        const text = await metrics.text();
        assert.match(text, /openwiki_http_requests_total\{[^}]*route="\/mcp"/);
      } finally {
        await server.close({ timeoutMs: 1000 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("served HTTP route ETags are conditional only for GET and HEAD", async () => {
  await withOperationalEnv({}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-etag-"));
    try {
      await createWorkspace(root, "HTTP ETag Wiki");
      const server = await startHttpApi({ root, port: 0 });
      try {
        const getResponse = await fetch(`${server.url}/api/v1/search?q=agent&limit=1`);
        assert.equal(getResponse.status, 200);
        const etag = getResponse.headers.get("etag");
        assert.ok(etag);

        const conditionalGet = await fetch(`${server.url}/api/v1/search?q=agent&limit=1`, {
          headers: { "if-none-match": etag },
        });
        assert.equal(conditionalGet.status, 304);
        assert.equal(conditionalGet.headers.get("x-content-type-options"), "nosniff");
        assert.match(conditionalGet.headers.get("content-security-policy") ?? "", /default-src 'self'/);
        assert.equal(await conditionalGet.text(), "");

        const conditionalHead = await fetch(`${server.url}/api/v1/search?q=agent&limit=1`, {
          method: "HEAD",
          headers: { "if-none-match": etag },
        });
        assert.equal(conditionalHead.status, 304);
        assert.equal(await conditionalHead.text(), "");

        const postBody = JSON.stringify({ question: "What does this wiki contain?", limit: 1 });
        const postResponse = await fetch(`${server.url}/api/v1/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", "if-none-match": etag },
          body: postBody,
        });
        assert.notEqual(postResponse.status, 304);
        assert.equal(postResponse.status, 200);
        assert.match(await postResponse.text(), /"answer"/);
      } finally {
        await server.close({ timeoutMs: 1000 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("served HTTP API sanitizes unexpected internal error responses", async () => {
  await withOperationalEnv({}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-sanitized-error-"));
    try {
      await createWorkspace(root, "HTTP Sanitized Error Wiki");
      const server = await startHttpApi({ root, port: 0 });
      try {
        await writeFile(path.join(root, "openwiki.json"), "{");
        const response = await fetch(`${server.url}/api/v1/index`, {
          headers: { "x-request-id": "sanitized-error-request" },
        });
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("x-openwiki-request-id"), "sanitized-error-request");
        const body = (await response.json()) as { error?: { code?: string; message?: string; request_id?: string } };
        assert.equal(body.error?.code, "internal");
        assert.equal(body.error?.message, "Internal server error");
        assert.equal(body.error?.request_id, "sanitized-error-request");
        assert.doesNotMatch(JSON.stringify(body), /Expected property name|JSON/);
      } finally {
        await server.close({ timeoutMs: 1000 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("started HTTP API exposes an idempotent graceful close helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-close-"));
  try {
    await createWorkspace(root, "HTTP Close Wiki");
    const server = await startHttpApi({ root, port: 0 });
    const live = await fetch(`${server.url}/livez`);
    assert.equal(live.status, 200);
    await Promise.all([server.close({ timeoutMs: 1000 }), server.close({ timeoutMs: 1000 })]);
    assert.equal(server.server.listening, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operations documentation covers Prometheus, request logs, and deployment defaults", async () => {
  const operations = [
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "monitoring.md"), "utf8"),
  ].join("\n");
  const observability = await readFile(path.join(process.cwd(), "docs", "deployment", "observability.md"), "utf8");
  const runbooks = await readFile(path.join(process.cwd(), "docs", "deployment", "runbooks.md"), "utf8");
  const dashboard = JSON.parse(await readFile(path.join(process.cwd(), "deploy", "observability", "grafana-dashboard.json"), "utf8")) as { panels?: unknown[]; title?: string };
  const alerts = await readFile(path.join(process.cwd(), "deploy", "observability", "prometheus-rules.yaml"), "utf8");
  assert.match(operations, /OPENWIKI_RATE_LIMIT_ENABLED/);
  assert.match(operations, /OPENWIKI_RATE_LIMIT_POLICY/);
  assert.match(operations, /OPENWIKI_RATE_LIMIT_INBOX/);
  assert.match(operations, /OPENWIKI_RATE_LIMIT_JOB/);
  assert.match(operations, /OPENWIKI_SOURCE_FETCH_MAX_BYTES/);
  assert.match(operations, /OPENWIKI_SOURCE_FETCH_MAX_TIMEOUT_MS/);
  assert.match(operations, /OPENWIKI_REQUEST_LOGS/);
  assert.match(operations, /OPENWIKI_STRUCTURED_LOGS/);
  assert.match(operations, /OPENWIKI_SHUTDOWN_TIMEOUT_MS/);
  assert.match(operations, /OPENWIKI_RATE_LIMIT_MAX_KEYS/);
  assert.match(operations, /OPENWIKI_OPERATIONAL_STATE_BACKEND/);
  assert.match(operations, /OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES/);
  assert.match(operations, /Prometheus scrape example/);
  assert.match(operations, /Local personal wiki/);
  assert.match(operations, /Enterprise\/shared HTTP MCP/);
  assert.match(observability, /openwiki_http_request_duration_seconds/);
  assert.match(observability, /deploy\/observability\/prometheus-rules\.yaml/);
  for (const heading of ["Auth Exposure", "Stuck Write Lock", "Stale Derived Store", "Failing Source Fetch", "Queue Backlog", "Restore Drill"]) {
    assert.match(runbooks, new RegExp(`## ${heading}`));
  }
  assert.equal(dashboard.title, "OpenWiki Operations");
  assert.ok((dashboard.panels?.length ?? 0) >= 6);
  assert.match(alerts, /OpenWikiNotReady/);
  assert.match(alerts, /OpenWikiSourceFetchFailures/);
});

async function configureSourceFetchBudget(root: string, sourceFetch: Record<string, number>): Promise<void> {
  const configPath = path.join(root, "openwiki.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { runtime?: { controls?: Record<string, unknown> } };
  config.runtime = {
    ...(config.runtime ?? {}),
    controls: {
      ...(config.runtime?.controls ?? {}),
      source_fetch: sourceFetch,
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function rateLimitErrorBucket(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = body.error;
  if (!error || typeof error !== "object" || !("bucket" in error)) {
    return undefined;
  }
  return typeof error.bucket === "string" ? error.bucket : undefined;
}

async function withOperationalEnv(values: Partial<Record<(typeof OPERATIONAL_ENV)[number], string>>, callback: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const name of OPERATIONAL_ENV) {
    previous.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetHttpOperationalStateForTests();
  resetWriteCoordinationMetricsForTests();
  resetSourceFetchMetricsForTests();
  try {
    await callback();
  } finally {
    resetHttpOperationalStateForTests();
    resetWriteCoordinationMetricsForTests();
    resetSourceFetchMetricsForTests();
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
