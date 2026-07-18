import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedOpenWikiHost } from "@openwiki/core";
import { diffVersions, InvalidGitRevisionError, readCommit } from "@openwiki/git";
import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { appendInboxItem, appendRun, createWorkspace } from "@openwiki/repo";
import { createContentStore } from "@openwiki/storage";
import { publishStaticSite } from "@openwiki/static-export";
import { applyProposal, createServiceAccountToken, fetchAndIngestSource, listServiceAccountTokens } from "@openwiki/workflows";
import { parseOpenWikiYaml } from "@openwiki/skills";
import { resolvePinnedSourceFetchTarget } from "../packages/workflows/src/source-fetch.ts";

const execFileAsync = promisify(execFile);

test("security boundaries block filesystem traversal and Git option injection", async () => {
  await withWorkspace("openwiki-security-paths-", async (root) => {
    await assert.rejects(
      publishStaticSite({ root, outDir: "../outside" }),
      /outDir must resolve to a child directory/,
    );
    await assert.rejects(
      publishStaticSite({ root, outDir: "wiki" }),
      /reserved workspace directory/,
    );

    await git(root, ["init", "--initial-branch", "master"]);
    await git(root, ["config", "user.name", "OpenWiki Security Test"]);
    await git(root, ["config", "user.email", "security@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    const output = path.join(os.tmpdir(), `openwiki-security-git-${Date.now()}.txt`);
    const injectedRevision = `--output=${output}`;
    try {
      await assert.rejects(
        diffVersions({ root, id: "page:concept:agent-memory", from: injectedRevision }),
        InvalidGitRevisionError,
      );
      await assert.rejects(readCommit(root, injectedRevision), InvalidGitRevisionError);
      await assert.rejects(readFile(output, "utf8"), /ENOENT/);
    } finally {
      await rm(output, { force: true });
    }
  });
});

test("security boundaries reject SSRF targets and connector redirects", async () => {
  await withWorkspace("openwiki-security-ssrf-", async (root) => {
    assert.equal(isBlockedOpenWikiHost("[100::1]"), true);
    assert.equal(isBlockedOpenWikiHost("[100:1::1]"), false);

    for (const url of [
      "http://127.0.0.1/private",
      "http://localhost/private",
      "http://[::ffff:127.0.0.1]/private",
      "http://[ff02::1]/private",
      "http://[64:ff9b::7f00:1]/private",
      "http://[2002:7f00:1::]/private",
      "http://[2001:db8::1]/private",
      "http://169.254.169.254/latest/meta-data",
      "http://2130706433/private",
      "http://0x7f000001/private",
    ]) {
      await assert.rejects(
        fetchAndIngestSource({
          root,
          title: "Blocked Source",
          url,
          actorId: "actor:user:security",
          fetcher: async () => {
            throw new Error("blocked URL should not reach fetcher");
          },
        }),
        /Blocked private or metadata source URL host/,
      );
    }

    await assert.rejects(
      fetchAndIngestSource({
        root,
        title: "Redirect Source",
        url: "https://example.com/redirect",
        actorId: "actor:user:security",
        fetcher: async () => new Response("", { status: 302, headers: { location: "https://example.com/final" } }),
      }),
      /redirects are not followed/,
    );
  });
});

test("source fetch DNS pinning validates resolved addresses and preserves origin host", async () => {
  await assert.rejects(
    resolvePinnedSourceFetchTarget("https://docs.example.test/private", {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    /Blocked private or metadata source URL resolved address/,
  );

  const target = await resolvePinnedSourceFetchTarget("https://docs.example.test:8443/path?q=1", {
    lookup: async (hostname) => {
      assert.equal(hostname, "docs.example.test");
      return [{ address: "203.0.113.42", family: 4 }];
    },
  });
  assert.equal(target.hostname, "docs.example.test");
  assert.equal(target.address, "203.0.113.42");
  assert.equal(target.hostHeader, "docs.example.test:8443");
});

test("security boundaries reject proposal apply through symlinked managed directories", async () => {
  await withWorkspace("openwiki-security-apply-symlink-", async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "openwiki-security-outside-"));
    try {
      await symlink(outside, path.join(root, "wiki", "escape"), "dir");
      await mkdir(path.join(root, "proposals", "snapshots"), { recursive: true });
      await writeFile(
        path.join(root, "proposals", "snapshots", "symlink-escape.md"),
        "# Symlink Escape\n\nThis must not be written outside the wiki root.\n",
      );
      await writeFile(
        path.join(root, "proposals", "symlink-escape.yaml"),
        [
          "id: proposal:2026-05-31-999",
          "uri: openwiki://proposal/2026-05-31-999",
          "type: proposal",
          "title: Symlink Escape",
          "status: accepted",
          "actor_id: actor:user:security",
          "target_ids:",
          "  - page:concept:symlink-escape",
          "target_path: wiki/escape/pwned.md",
          "diff:",
          "  format: unified",
          "  path: proposals/diffs/symlink-escape.diff",
          "snapshot_path: proposals/snapshots/symlink-escape.md",
          "created_at: 2026-05-31T00:00:00.000Z",
          "",
        ].join("\n"),
      );

      await assert.rejects(
        applyProposal({ root, proposalId: "proposal:2026-05-31-999", actorId: "actor:user:security" }),
        /symlink inside OpenWiki root/,
      );
      await assert.rejects(readFile(path.join(outside, "pwned.md"), "utf8"), /ENOENT/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("security boundaries reject unsafe YAML keys and symlinked managed write directories", async () => {
  assert.throws(
    () => parseOpenWikiYaml("__proto__: polluted\n", "security.yaml"),
    /not supported/,
  );
  assert.throws(
    () => parseOpenWikiYaml("items:\n  - constructor: polluted\n", "security.yaml"),
    /not supported/,
  );

  await withWorkspace("openwiki-security-managed-writes-", async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "openwiki-managed-outside-"));
    try {
      await rm(path.join(root, "runs"), { recursive: true, force: true });
      await symlink(outside, path.join(root, "runs"), "dir");
      await assert.rejects(
        appendRun(root, { run_type: "lint", actor_id: "actor:user:security" }),
        /symbolic links/,
      );

      await rm(path.join(root, "runs"), { recursive: true, force: true });
      await rm(path.join(root, "inbox"), { recursive: true, force: true });
      await symlink(outside, path.join(root, "inbox"), "dir");
      await assert.rejects(
        appendInboxItem(root, {
          id: "inbox:2026-07-05-security",
          uri: "openwiki://inbox/2026-07-05-security",
          type: "inbox",
          title: "Symlinked inbox",
          inbox_kind: "document",
          provider: "security-test",
          status: "received",
          received_at: "2026-07-05T00:00:00.000Z",
          updated_at: "2026-07-05T00:00:00.000Z",
          idempotency_key: "security-symlink",
          path: "inbox/items.jsonl",
        }),
        /symbolic links/,
      );

      await rm(path.join(root, "inbox"), { recursive: true, force: true });
      await mkdir(path.join(root, ".openwiki"), { recursive: true });
      await rm(path.join(root, ".openwiki", "objects"), { recursive: true, force: true });
      await symlink(outside, path.join(root, ".openwiki", "objects"), "dir");
      const store = await createContentStore(root);
      await assert.rejects(
        store.put({ data: "must not escape", namespace: "sources", extension: "txt" }),
        /symbolic links/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("security boundaries reject trusted-header spoofing and cross-origin writes", async () => {
  await withWorkspace("openwiki-security-http-", async (root) => {
    await assert.rejects(
      startHttpApi({ root, port: 0, defaultPolicy: { trustHeaders: true } }),
      /Trusted auth headers require/,
    );

    const server = await startHttpApi({
      root,
      port: 0,
      defaultPolicy: { trustHeaders: true, trustedHeaderSecret: "security-proxy-secret" },
    });
    try {
      const spoofed = await fetch(`${server.url}/api/v1/auth/service-accounts`, {
        headers: {
          "x-openwiki-role": "admin",
          "x-openwiki-actor": "actor:user:spoofed-admin",
        },
      });
      assert.equal(spoofed.status, 403);

      const wrongSecret = await fetch(`${server.url}/api/v1/auth/service-accounts`, {
        headers: {
          "x-openwiki-role": "admin",
          "x-openwiki-actor": "actor:user:spoofed-admin",
          "x-openwiki-proxy-secret": "wrong-security-proxy-secret",
        },
      });
      assert.equal(wrongSecret.status, 403);

      const crossOriginWrite = await fetch(`${server.url}/pages/page%3Aconcept%3Aagent-memory/propose`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
        },
        body: new URLSearchParams({
          body: "# Agent Memory\n\nCross-origin write attempt.",
          rationale: "This should fail before workflow execution.",
        }),
        redirect: "manual",
      });
      assert.equal(crossOriginWrite.status, 403);

      const crossSiteJsonWithoutOrigin = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
          "x-openwiki-proxy-secret": "security-proxy-secret",
          "x-openwiki-role": "admin",
          "x-openwiki-actor": "actor:user:admin",
        },
        body: "{}",
      });
      assert.equal(crossSiteJsonWithoutOrigin.status, 403);

      const trustedHeaderJsonWithoutBrowserMetadata = await fetch(`${server.url}/api/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openwiki-proxy-secret": "security-proxy-secret",
          "x-openwiki-role": "admin",
          "x-openwiki-actor": "actor:user:admin",
        },
        body: "{}",
      });
      assert.equal(trustedHeaderJsonWithoutBrowserMetadata.status, 403);
    } finally {
      await closeServer(server.server);
    }
  });
});

test("security boundaries enforce request body size and JSON depth limits", async () => {
  await withWorkspace("openwiki-security-bodies-", async (root) => {
    const server = await startHttpApi({ root, port: 0 });
    try {
      const emptySearch = await fetch(`${server.url}/api/v1/search?q=`);
      assert.equal(emptySearch.status, 400);
      assert.doesNotMatch(await emptySearch.text(), /internal/i);

      const invalidCursor = await fetch(`${server.url}/api/v1/search?q=agent&cursor=offset%3Anope`);
      assert.equal(invalidCursor.status, 400);
      assert.match(await invalidCursor.text(), /Invalid search cursor/);

      const invalidGraphDirection = await fetch(`${server.url}/api/v1/graph/page%3Aconcept%3Aagent-memory/neighbors?direction=sideways`);
      assert.equal(invalidGraphDirection.status, 400);
      assert.match(await invalidGraphDirection.text(), /Expected direction/);

      const home = await fetch(`${server.url}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.match(home.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.match(home.headers.get("content-security-policy") ?? "", /worker-src 'self' blob:/);
      assert.match(home.headers.get("content-security-policy") ?? "", /object-src 'none'/);
      assert.doesNotMatch(home.headers.get("content-security-policy") ?? "", /script-src[^;]*'unsafe-inline'/);
      assert.equal(home.headers.get("x-frame-options"), "DENY");
      assert.equal(home.headers.get("x-content-type-options"), "nosniff");
      assert.equal(home.headers.get("referrer-policy"), "no-referrer");

      const oversized = await fetch(`${server.url}/api/v1/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "x".repeat(1024 * 1024), limit: 1 }),
      });
      assert.equal(oversized.status, 413);

      let deeplyNested: unknown = "leaf";
      for (let index = 0; index < 105; index += 1) {
        deeplyNested = { child: deeplyNested };
      }
      const tooDeep = await fetch(`${server.url}/api/v1/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deeplyNested),
      });
      assert.equal(tooDeep.status, 400);
      assert.match(await tooDeep.text(), /maximum depth/);
    } finally {
      await closeServer(server.server);
    }
  });
});

test("security boundaries keep metrics private by default unless explicitly opted in", async () => {
  await withWorkspace("openwiki-security-metrics-", async (root) => {
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const previous = process.env.OPENWIKI_PUBLIC_METRICS;
    try {
      delete process.env.OPENWIKI_PUBLIC_METRICS;
      const deniedMetrics = await routeHttpRequest(root, "GET", "/metrics");
      assert.equal(deniedMetrics.status, 403);
      const deniedMetricsAlias = await routeHttpRequest(root, "GET", "/api/v1/metrics");
      assert.equal(deniedMetricsAlias.status, 403);

      const adminMetrics = await routeHttpRequest(root, "GET", "/metrics", undefined, {
        actorId: "actor:user:metrics-admin",
        role: "admin",
      });
      assert.equal(adminMetrics.status, 200);

      process.env.OPENWIKI_PUBLIC_METRICS = "1";
      const publicMetrics = await routeHttpRequest(root, "GET", "/metrics");
      assert.equal(publicMetrics.status, 200);
      const publicMetricsAlias = await routeHttpRequest(root, "GET", "/api/v1/metrics");
      assert.equal(publicMetricsAlias.status, 200);

      await writeFile(configPath, `${JSON.stringify({ ...config, runtime: { profile: "hosted" } }, null, 2)}\n`);
      const hostedMetrics = await routeHttpRequest(root, "GET", "/metrics");
      assert.equal(hostedMetrics.status, 401);
      const hostedAdminMetrics = await routeHttpRequest(root, "GET", "/metrics", undefined, {
        actorId: "actor:user:metrics-admin",
        role: "admin",
      });
      assert.equal(hostedAdminMetrics.status, 200);
    } finally {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      if (previous === undefined) {
        delete process.env.OPENWIKI_PUBLIC_METRICS;
      } else {
        process.env.OPENWIKI_PUBLIC_METRICS = previous;
      }
    }
  });
});

test("security boundaries enforce webhook enqueue authorization by run type", async () => {
  await withWorkspace("openwiki-security-webhook-auth-", async (root) => {
    const patchOnly = { scopes: ["wiki:patch" as const], actorId: "actor:service:patch-only" };
    const maintainer = { role: "maintainer" as const, actorId: "actor:user:maintainer" };
    const admin = { role: "admin" as const, actorId: "actor:user:admin" };

    const deniedIndex = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push" }, maintainer);
    assert.equal(deniedIndex.status, 403);
    assert.match(JSON.stringify(deniedIndex.body), /wiki:admin/);

    const allowedIndex = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push" }, admin);
    assert.equal(allowedIndex.status, 202);
    assert.equal((allowedIndex.body as { run: { run_type: string } }).run.run_type, "index.rebuild");

    const allowedLint = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push", run_type: "lint" }, patchOnly);
    assert.equal(allowedLint.status, 202);
    assert.equal((allowedLint.body as { run: { run_type: string } }).run.run_type, "lint");

    const deniedExport = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push", run_type: "static.export" }, patchOnly);
    assert.equal(deniedExport.status, 403);
    assert.match(JSON.stringify(deniedExport.body), /wiki:publish/);

    const unsupported = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push", run_type: "source.fetch" }, admin);
    assert.equal(unsupported.status, 400);

    const eventOnly = await routeHttpRequest(root, "POST", "/api/v1/webhooks/github", { event: "push", enqueue: false }, patchOnly);
    assert.equal(eventOnly.status, 202);
    assert.equal((eventOnly.body as { run: unknown }).run, null);
  });
});

test("security boundaries verify webhook provider secrets when configured", async () => {
  await withWorkspace("openwiki-security-webhook-", async (root) => {
    const previousGitHubSecret = process.env.OPENWIKI_WEBHOOK_GITHUB_SECRET;
    const previousGitLabSecret = process.env.OPENWIKI_WEBHOOK_GITLAB_SECRET;
    process.env.OPENWIKI_WEBHOOK_GITHUB_SECRET = "github-webhook-secret";
    process.env.OPENWIKI_WEBHOOK_GITLAB_SECRET = "gitlab-webhook-secret";
    const server = await startHttpApi({
      root,
      port: 0,
      defaultPolicy: { trustHeaders: true, trustedHeaderSecret: "security-proxy-secret" },
    });
    try {
      const body = `${JSON.stringify({ ref: "refs/heads/main", run_type: "lint", enqueue: false })}\n`;
      const commonHeaders = {
        "content-type": "application/json",
        "x-openwiki-proxy-secret": "security-proxy-secret",
        "x-openwiki-role": "admin",
        "x-openwiki-actor": "actor:user:webhook-admin",
      };
      const missingSignature = await fetch(`${server.url}/api/v1/webhooks/github`, {
        method: "POST",
        headers: commonHeaders,
        body,
      });
      assert.equal(missingSignature.status, 400);

      const signature = `sha256=${createHmac("sha256", "github-webhook-secret").update(body).digest("hex")}`;
      const signedGitHub = await fetch(`${server.url}/api/v1/webhooks/github`, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "x-hub-signature-256": signature,
        },
        body,
      });
      assert.equal(signedGitHub.status, 202);

      const wrongGitLabToken = await fetch(`${server.url}/api/v1/webhooks/gitlab`, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "x-gitlab-token": "wrong-secret",
        },
        body,
      });
      assert.equal(wrongGitLabToken.status, 400);

      const signedGitLab = await fetch(`${server.url}/api/v1/webhooks/gitlab`, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "x-gitlab-token": "gitlab-webhook-secret",
        },
        body,
      });
      assert.equal(signedGitLab.status, 202);
    } finally {
      if (previousGitHubSecret === undefined) {
        delete process.env.OPENWIKI_WEBHOOK_GITHUB_SECRET;
      } else {
        process.env.OPENWIKI_WEBHOOK_GITHUB_SECRET = previousGitHubSecret;
      }
      if (previousGitLabSecret === undefined) {
        delete process.env.OPENWIKI_WEBHOOK_GITLAB_SECRET;
      } else {
        process.env.OPENWIKI_WEBHOOK_GITLAB_SECRET = previousGitLabSecret;
      }
      await closeServer(server.server);
    }
  });
});

test("security boundaries deny unauthorized MCP writes and keep bearer tokens out of persisted metadata", async () => {
  await withWorkspace("openwiki-security-mcp-token-", async (root) => {
    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: "denied-write",
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: "page:concept:agent-memory",
            body: "# Agent Memory\n\nRead-mode MCP must not write.",
          },
        },
      }),
      /not enabled in MCP read mode/,
    );

    const created = await createServiceAccountToken({
      root,
      id: "service:security-agent",
      profile: "proposal-agent",
      actorId: "actor:agent:security-agent",
    });
    const rawToken = created.token.value;
    const config = await readFile(path.join(root, "openwiki.json"), "utf8");
    assert.doesNotMatch(config, new RegExp(escapeRegExp(rawToken)));
    assert.match(config, /token_hash/);
    const persistedTokenHash = persistedServiceAccountTokenHash(config, "service:security-agent");

    const listed = await listServiceAccountTokens({ root, id: "service:security-agent" });
    const listedJson = JSON.stringify(listed);
    assert.doesNotMatch(listedJson, new RegExp(escapeRegExp(rawToken)));
    assert.match(listedJson, /token_hash/);

    const deniedHashAsBearer = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/auth/service-accounts",
      undefined,
      { token: persistedTokenHash },
    );
    assert.equal(deniedHashAsBearer.status, 403);
  });
});

test("security boundaries return reader-safe workspace index metadata", async () => {
  await withWorkspace("openwiki-security-index-", async (root) => {
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.runtime = {
      git: {
        remote_url: "https://github.com/example/private-wiki.git",
        credential_ref: "cred:git-sync",
      },
      connectors: {
        http: [
          {
            id: "private-docs",
            allowed_hosts: ["docs.example.com"],
            credential_refs: ["cred:private-docs"],
          },
        ],
      },
      storage: {
        backend: "s3",
        bucket: "private-wiki",
        secret_access_key_env: "OPENWIKI_PRIVATE_S3_SECRET",
      },
    };
    config.auth = {
      service_accounts: [
        {
          id: "service:index-reader",
          actor_id: "actor:agent:index-reader",
          token_hashes: ["sha256:reader-token-hash"],
          tokens: [
            {
              id: "token:reader",
              token_hash: "sha256:reader-token-hash",
              created_at: "2026-05-31T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const readerIndex = await routeHttpRequest(root, "GET", "/api/v1/index");
    assert.equal(readerIndex.status, 200);
    const readerText = JSON.stringify(readerIndex.body);
    assert.match(readerText, /workspace_id/);
    assert.doesNotMatch(readerText, /runtime|auth|remote_url|credential_ref|token_hash|secret_access_key_env|service:index-reader/);

    const adminIndex = await routeHttpRequest(root, "GET", "/api/v1/index", undefined, { role: "admin" });
    assert.equal(adminIndex.status, 200);
    const adminText = JSON.stringify(adminIndex.body);
    assert.match(adminText, /remote_url|credential_ref|token_hash|service:index-reader/);
  });
});

async function withWorkspace(prefix: string, callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await createWorkspace(root, "Security Boundary Wiki");
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args]);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function persistedServiceAccountTokenHash(configJson: string, id: string): string {
  const config = JSON.parse(configJson) as {
    auth?: {
      service_accounts?: Array<{
        id?: string;
        tokens?: Array<{ token_hash?: string }>;
      }>;
    };
  };
  const tokenHash = config.auth?.service_accounts
    ?.find((account) => account.id === id)
    ?.tokens?.[0]
    ?.token_hash;
  if (typeof tokenHash !== "string") {
    throw new Error(`Missing persisted token hash for ${id}`);
  }
  return tokenHash;
}
