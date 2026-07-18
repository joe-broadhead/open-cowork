import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveSourceFetchRequest } from "@openwiki/connectors";
import type { OpenWikiConfig } from "@openwiki/core";

test("environment secret resolver maps credential refs without storing secrets in config", async () => {
  const docsEnvName = credentialEnvName("cred:docs-reader", "OW_SECRET_");
  assert.equal(docsEnvName, "OW_SECRET_CRED_DOCS_READER_90A74884");
  assert.notEqual(credentialEnvName("cred:hello-world", "OW_SECRET_"), credentialEnvName("cred:hello_world", "OW_SECRET_"));
  const oldSecret = process.env[docsEnvName];
  try {
    process.env[docsEnvName] = "header:X-Api-Key=super-secret";
    const resolved = await resolveSourceFetchRequest({
      config: {
        protocol_version: "0.1",
        workspace_id: "workspace:connectors",
        title: "Connector Wiki",
        repo_format: "openwiki-repo-v0",
        runtime: {
          connectors: {
            http: [
              {
                id: "docs",
                allowed_hosts: ["docs.example.com"],
                credential_refs: ["cred:docs-reader"],
              },
            ],
          },
          secrets: {
            backend: "env",
            env_prefix: "OW_SECRET_",
          },
        },
        created_at: "2026-05-21T00:00:00Z",
      },
      connectorKind: "http",
      connectorId: "docs",
      credentialRef: "cred:docs-reader",
      url: "https://docs.example.com/private",
    });
    assert.equal(resolved.headers["x-api-key"], "super-secret");
    assert.deepEqual(resolved.trust, {
      connector_kind: "http",
      connector_id: "docs",
      credential_ref: "cred:docs-reader",
      authenticated: true,
    });
  } finally {
    restoreEnv(docsEnvName, oldSecret);
  }
});

test("source connector base URLs reject local and metadata hosts", async () => {
  const config = {
    protocol_version: "0.1",
    workspace_id: "workspace:connectors",
    title: "Connector Wiki",
    repo_format: "openwiki-repo-v0",
    runtime: {
      connectors: {
        github: [
          {
            id: "internal-github",
            api_base_url: "http://127.0.0.1:8080",
            allowed_repositories: ["openwiki/docs"],
          },
        ],
        gitlab: [
          {
            id: "metadata-gitlab",
            web_base_url: "http://169.254.169.254",
            allowed_repositories: ["openwiki/docs"],
          },
        ],
      },
    },
    created_at: "2026-05-21T00:00:00Z",
  } satisfies OpenWikiConfig;

  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "github",
      connectorId: "internal-github",
      github: { owner: "openwiki", repo: "docs", path: "README.md" },
    }),
    /Blocked private or metadata connector base URL host/,
  );
  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "gitlab",
      connectorId: "metadata-gitlab",
      gitlab: { project: "openwiki/docs", path: "README.md", ref: "main" },
    }),
    /Blocked private or metadata connector base URL host/,
  );
});

test("HTTP connector resolution applies secret headers at runtime only", async () => {
  const config = {
    protocol_version: "0.1",
    workspace_id: "workspace:connectors",
    title: "Connector Wiki",
    repo_format: "openwiki-repo-v0",
    runtime: {
      connectors: {
        http: [
          {
            id: "docs",
            allowed_hosts: ["docs.example.com", "*.trusted.example.com"],
            credential_refs: ["cred:docs-reader"],
            default_headers: {
              accept: "text/markdown",
            },
          },
        ],
      },
      secrets: {
        backend: "env",
        env_prefix: "OW_SECRET_",
      },
    },
    created_at: "2026-05-21T00:00:00Z",
  } satisfies OpenWikiConfig;

  const resolved = await resolveSourceFetchRequest({
    config,
    connectorKind: "http",
    url: "https://docs.example.com/private",
    connectorId: "docs",
    credentialRef: "cred:docs-reader",
    baseHeaders: { "user-agent": "OpenWiki test" },
    secretResolver: {
      async resolveCredential() {
        return { kind: "bearer", token: "super-secret" };
      },
    },
  });

  assert.equal(resolved.headers.accept, "text/markdown");
  assert.equal(resolved.headers["user-agent"], "OpenWiki test");
  assert.equal(resolved.headers.authorization, "Bearer super-secret");
  assert.equal(resolved.connectorKind, "http");
  assert.equal(resolved.requestUrl, "https://docs.example.com/private");
  assert.equal(resolved.sourceUrl, "https://docs.example.com/private");
  assert.deepEqual(resolved.trust, {
    connector_kind: "http",
    connector_id: "docs",
    credential_ref: "cred:docs-reader",
    authenticated: true,
  });

  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "http",
      url: "https://outside.example/private",
      connectorId: "docs",
      credentialRef: "cred:docs-reader",
    }),
    /not allowed for connector/,
  );

  await assert.rejects(
    resolveSourceFetchRequest({
      config: {
        ...config,
        runtime: {
          connectors: {
            http: [{ id: "open-http" }],
          },
        },
      } as OpenWikiConfig,
      connectorKind: "http",
      url: "https://docs.example.com/private",
      connectorId: "open-http",
    }),
    /must define allowed_hosts/,
  );

  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "http",
      url: "https://docs.example.com/private",
      connectorId: "docs",
      credentialRef: "cred:missing",
    }),
    /not allowed for connector/,
  );
});

test("credentialed connectors require HTTPS transport by default", async () => {
  const config = {
    protocol_version: "0.1",
    workspace_id: "workspace:connectors",
    title: "Connector Wiki",
    repo_format: "openwiki-repo-v0",
    runtime: {
      connectors: {
        http: [
          {
            id: "docs",
            allowed_hosts: ["docs.example.com"],
            credential_refs: ["cred:docs-reader"],
          },
        ],
      },
    },
    created_at: "2026-05-21T00:00:00Z",
  } satisfies OpenWikiConfig;

  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "http",
      url: "http://docs.example.com/private",
      connectorId: "docs",
      credentialRef: "cred:docs-reader",
      secretResolver: {
        async resolveCredential() {
          return { kind: "bearer", token: "super-secret" };
        },
      },
    }),
    /requires an HTTPS request URL/,
  );

  const oldValue = process.env.OPENWIKI_ALLOW_INSECURE_CONNECTOR_CREDENTIALS;
  try {
    process.env.OPENWIKI_ALLOW_INSECURE_CONNECTOR_CREDENTIALS = "1";
    const resolved = await resolveSourceFetchRequest({
      config,
      connectorKind: "http",
      url: "http://docs.example.com/private",
      connectorId: "docs",
      credentialRef: "cred:docs-reader",
      secretResolver: {
        async resolveCredential() {
          return { kind: "bearer", token: "super-secret" };
        },
      },
    });
    assert.equal(resolved.headers.authorization, "Bearer super-secret");
  } finally {
    restoreEnv("OPENWIKI_ALLOW_INSECURE_CONNECTOR_CREDENTIALS", oldValue);
  }
});

function credentialEnvName(credentialRef: string, envPrefix: string): string {
  const trimmed = credentialRef.trim();
  const suffix = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8).toUpperCase();
  return `${envPrefix}${suffix}_${digest}`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("GitHub and GitLab source connectors build authenticated raw-content requests", async () => {
  const config = {
    protocol_version: "0.1",
    workspace_id: "workspace:connectors",
    title: "Connector Wiki",
    repo_format: "openwiki-repo-v0",
    runtime: {
      connectors: {
        github: [
          {
            id: "github-docs",
            allowed_repositories: ["openwiki/*"],
            credential_refs: ["cred:github-reader"],
          },
        ],
        gitlab: [
          {
            id: "gitlab-docs",
            web_base_url: "https://gitlab.example.com",
            api_base_url: "https://gitlab.example.com/api/v4",
            allowed_repositories: ["platform/wiki"],
            credential_refs: ["cred:gitlab-reader"],
          },
        ],
      },
      secrets: {
        backend: "env",
        env_prefix: "OW_SECRET_",
      },
    },
    created_at: "2026-05-21T00:00:00Z",
  } satisfies OpenWikiConfig;

  const github = await resolveSourceFetchRequest({
    config,
    connectorKind: "github",
    connectorId: "github-docs",
    credentialRef: "cred:github-reader",
    github: {
      owner: "openwiki",
      repo: "docs",
      path: "spec/openwiki.md",
      ref: "abc123",
    },
    secretResolver: {
      async resolveCredential(credentialRef, context) {
        assert.equal(credentialRef, "cred:github-reader");
        assert.match(context.url, /^https:\/\/api\.github\.com\/repos\/openwiki\/docs\/contents\/spec\/openwiki\.md/);
        return { kind: "bearer", token: "github-secret" };
      },
    },
  });
  assert.equal(github.requestUrl, "https://api.github.com/repos/openwiki/docs/contents/spec/openwiki.md?ref=abc123");
  assert.equal(github.sourceUrl, "https://github.com/openwiki/docs/blob/abc123/spec/openwiki.md");
  assert.equal(github.headers.accept, "application/vnd.github.raw");
  assert.equal(github.headers.authorization, "Bearer github-secret");
  assert.deepEqual(github.trust, {
    connector_kind: "github",
    connector_id: "github-docs",
    repository: "openwiki/docs",
    source_path: "spec/openwiki.md",
    ref: "abc123",
    credential_ref: "cred:github-reader",
    authenticated: true,
  });

  const gitlab = await resolveSourceFetchRequest({
    config,
    connectorKind: "gitlab",
    connectorId: "gitlab-docs",
    credentialRef: "cred:gitlab-reader",
    gitlab: {
      project: "platform/wiki",
      path: "docs/openwiki.md",
      ref: "main",
    },
    secretResolver: {
      async resolveCredential() {
        return { kind: "header", name: "PRIVATE-TOKEN", value: "gitlab-secret" };
      },
    },
  });
  assert.equal(
    gitlab.requestUrl,
    "https://gitlab.example.com/api/v4/projects/platform%2Fwiki/repository/files/docs%2Fopenwiki.md/raw?ref=main",
  );
  assert.equal(gitlab.sourceUrl, "https://gitlab.example.com/platform/wiki/-/blob/main/docs/openwiki.md");
  assert.equal(gitlab.headers["private-token"], "gitlab-secret");
  assert.equal(gitlab.trust.connector_kind, "gitlab");
  assert.equal(gitlab.trust.repository, "platform/wiki");

  await assert.rejects(
    resolveSourceFetchRequest({
      config,
      connectorKind: "github",
      connectorId: "github-docs",
      github: {
        owner: "outside",
        repo: "docs",
        path: "README.md",
      },
    }),
    /not allowed for connector/,
  );

  await assert.rejects(
    resolveSourceFetchRequest({
      config: {
        ...config,
        runtime: {
          connectors: {
            github: [{ id: "open-github" }],
          },
        },
      } as OpenWikiConfig,
      connectorKind: "github",
      connectorId: "open-github",
      github: {
        owner: "openwiki",
        repo: "docs",
        path: "README.md",
      },
    }),
    /must define allowed_repositories/,
  );
});
