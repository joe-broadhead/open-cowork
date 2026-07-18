import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import type { HttpPolicyOptions } from "../src/types.ts";
import { routeApiGraphSourceRoutes } from "../src/routes/api-graph-sources.ts";
import { routeApiOperationsRoutes } from "../src/routes/api-operations.ts";
import { routeApiPolicySearchRoutes } from "../src/routes/api-policy-search.ts";
import { routeApiProposalMutationRoutes } from "../src/routes/api-proposals.ts";
import { routeApiRecordRoutes } from "../src/routes/api-records.ts";
import { routeApiWorkspaceRoutes } from "../src/routes/api-workspaces.ts";
import type { HttpRouteHandlerContext } from "../src/routes/router.ts";
import { routeProtectedSystemRoutes, routePublicSystemRoutes } from "../src/routes/system-http.ts";
import { routeWebCoreRoutes, routeWebRecordRoutes } from "../src/routes/web.ts";

test("HTTP route modules handle their owned route groups", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-routes-"));
  await t.test("public system routes", async () => {
    const response = await routePublicSystemRoutes(routeContext(root, "GET", "/livez"));
    assert.equal(response?.status, 200);
  });

  try {
    await createWorkspace(root, "HTTP Route Modules Wiki");

    await t.test("protected system routes", async () => {
      const response = await routeProtectedSystemRoutes(routeContext(root, "GET", "/api/v1/capabilities"));
      assert.equal(response?.status, 200);
    });

    await t.test("web core routes", async () => {
      const response = await routeWebCoreRoutes(routeContext(root, "GET", "/admin"));
      assert.equal(response?.status, 200);
      assert.match(String(response?.body), /Advanced/);
    });

    await t.test("web record routes", async () => {
      const response = await routeWebRecordRoutes(routeContext(root, "GET", "/proposals"));
      assert.equal(response?.status, 200);
      assert.match(String(response?.body), /Proposals/);
    });

    await t.test("policy and search API routes", async () => {
      const response = await routeApiPolicySearchRoutes(routeContext(root, "GET", "/api/v1/policy"));
      assert.equal(response?.status, 200);
      assert.ok((response?.body as { policy?: unknown }).policy);
    });

    await t.test("operational API routes", async () => {
      const response = await routeApiOperationsRoutes(routeContext(root, "GET", "/api/v1/runs"));
      assert.equal(response?.status, 200);
      assert.ok(Array.isArray((response?.body as { runs?: unknown[] }).runs));
    });

    await t.test("graph and source API routes", async () => {
      const response = await routeApiGraphSourceRoutes(routeContext(root, "GET", "/api/v1/sources"));
      assert.equal(response?.status, 200);
      assert.ok(Array.isArray((response?.body as { sources?: unknown[] }).sources));
    });

    await t.test("proposal API routes", async () => {
      const response = await routeApiProposalMutationRoutes(routeContext(root, "GET", "/api/v1/proposals"));
      assert.equal(response?.status, 200);
      assert.ok(Array.isArray((response?.body as { proposals?: unknown[] }).proposals));
    });

    await t.test("record API routes", async () => {
      const response = await routeApiRecordRoutes(
        routeContext(root, "GET", "/api/v1/pages/page%3Aconcept%3Aagent-memory"),
      );
      assert.equal(response?.status, 200);
      assert.equal((response?.body as { id?: string }).id, "page:concept:agent-memory");
    });

    await t.test("workspace API routes", async () => {
      const response = await routeApiWorkspaceRoutes(routeContext(root, "GET", "/api/v1/workspaces"));
      assert.equal(response?.status, 200);
      assert.ok((response?.body as { registry?: unknown }).registry);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function routeContext(
  root: string,
  method: string,
  rawUrl: string,
  body?: unknown,
  policy: HttpPolicyOptions = { role: "admin" },
): HttpRouteHandlerContext {
  return {
    root,
    method,
    rawUrl,
    url: new URL(rawUrl, "http://openwiki.local"),
    body,
    policy,
    context: {},
  };
}
