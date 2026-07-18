import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_OPENWIKI_SEARCH_CONFIG,
  OPENWIKI_PROTOCOL_VERSION,
  OPENWIKI_REPO_FORMAT,
  idToUri,
  isoNow,
  openWikiPathExists,
  openWikiRuntimeModeFromEnvOrProfile,
  openWikiRuntimeModeRequiresHostedStores,
  pageId,
  slugify,
  type ClaimRecord,
  type FactRecord,
  type OpenWikiConfig,
  type OpenWikiWorkspaceRegistry,
  type TakeRecord,
} from "@openwiki/core";
import { defaultPolicyBundle, pluralizePageType, renderTemplatePage, workspaceOptions, WORKSPACE_TEMPLATES, type CreateWorkspaceOptions } from "./templates.ts";
import { dateSequenceId, writeJson } from "./io.ts";
import {
  repositoryMutationToken,
  repositoryProcessReadCache,
  repositoryReadCache,
  type RepositoryReadCacheEntry,
} from "./cache.ts";
import {
  loadClaims,
  loadDecisions,
  loadEvents,
  loadFacts,
  loadInboxItems,
  loadPages,
  loadPolicy,
  loadProposalComments,
  loadProposals,
  loadRuns,
  loadSources,
  loadTakes,
  readConfig,
} from "./loaders.ts";
import type { LoadedOpenWikiRepo } from "./types.ts";

export { clearRepositoryProcessReadCache } from "./cache.ts";

export async function findWorkspaceRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, "openwiki.json");
    if (await openWikiPathExists(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find openwiki.json from ${start}`);
    }
    current = parent;
  }
}

export async function createWorkspace(
  root: string,
  titleOrOptions: string | CreateWorkspaceOptions = "OpenWiki",
): Promise<OpenWikiConfig> {
  const options = workspaceOptions(titleOrOptions);
  const template = WORKSPACE_TEMPLATES[options.template];
  const title = options.title ?? "OpenWiki";
  const resolved = path.resolve(root);
  await fs.mkdir(resolved, { recursive: true });
  await fs.mkdir(path.join(resolved, "wiki"), { recursive: true });
  await fs.mkdir(path.join(resolved, "sources", "manifests"), { recursive: true });
  await fs.mkdir(path.join(resolved, "claims"), { recursive: true });
  await fs.mkdir(path.join(resolved, "facts"), { recursive: true });
  await fs.mkdir(path.join(resolved, "takes"), { recursive: true });
  await fs.mkdir(path.join(resolved, "inbox", "payloads"), { recursive: true });
  await fs.mkdir(path.join(resolved, "proposals"), { recursive: true });
  await fs.mkdir(path.join(resolved, "decisions"), { recursive: true });
  await fs.mkdir(path.join(resolved, "events"), { recursive: true });
  await fs.mkdir(path.join(resolved, "runs"), { recursive: true });
  await fs.mkdir(path.join(resolved, "policy"), { recursive: true });
  await writeDefaultGitignore(resolved);

  const now = isoNow();
  const seedNow = "2026-05-21T10:00:00.000Z";
  const config: OpenWikiConfig = {
    protocol_version: OPENWIKI_PROTOCOL_VERSION,
    workspace_id: `workspace:${slugify(title)}`,
    title,
    default_language: "en",
    repo_format: OPENWIKI_REPO_FORMAT,
    runtime: {
      profile: template.runtimeProfile ?? "local",
      queue: {
        backend: "local",
        poll_ms: 1000,
        max_jobs_per_worker: 1,
      },
      storage: {
        backend: "local",
        local_path: ".openwiki/objects",
        inline_max_bytes: 65536,
      },
      connectors: {
        http: [],
        github: [],
        gitlab: [],
      },
      secrets: {
        backend: "env",
        env_prefix: "OPENWIKI_SECRET_",
      },
    },
    auth: {
      service_accounts: [],
    },
    search: DEFAULT_OPENWIKI_SEARCH_CONFIG,
    created_at: now,
  };

  await writeJson(path.join(resolved, "openwiki.json"), config);

  const policy = template.policy ?? defaultPolicyBundle();
  await writeJson(path.join(resolved, "policy", "sections.json"), policy.sections);
  await writeJson(path.join(resolved, "policy", "grants.json"), policy.grants);
  await writeJson(path.join(resolved, "policy", "approval-rules.json"), policy.approvalRules);

  const sourceId = dateSequenceId("source", seedNow, 1);

  const sourceManifest = `id: ${sourceId}\ntitle: ${template.source.title}\nsource_type: ${template.source.sourceType}\nretrieved_at: ${seedNow}\ncontent_hash: sha256:local-draft\ntrust:\n  reliability: ${template.source.reliability}\n  sensitivity: ${template.source.sensitivity}\n`;
  await fs.writeFile(
    path.join(resolved, "sources", "manifests", "source_0001.yaml"),
    sourceManifest,
  );

  const claims: ClaimRecord[] = [];
  for (const [index, page] of template.pages.entries()) {
    const claimId = dateSequenceId("claim", seedNow, index + 1);
    const pageRecordId = pageId(page.pageType, page.slug);
    const pageBody = renderTemplatePage(page, {
      now: seedNow,
      sourceId,
      claimId,
      pageId: pageRecordId,
    });
    const pagePath = path.join(resolved, "wiki", pluralizePageType(page.pageType), `${slugify(page.slug)}.md`);
    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(pagePath, pageBody);
    claims.push({
      id: claimId,
      uri: idToUri(claimId),
      type: "claim",
      text: page.claim,
      page_id: pageRecordId,
      source_ids: [sourceId],
      confidence: page.confidence ?? "medium",
      risk: page.risk ?? "low",
      last_verified_at: seedNow,
      status: "active",
    });
  }
  await fs.writeFile(path.join(resolved, "claims", "claim-index.jsonl"), `${claims.map((claim) => JSON.stringify(claim)).join("\n")}\n`);
  const facts: FactRecord[] = [];
  const takes: TakeRecord[] = [];
  await fs.writeFile(path.join(resolved, "facts", "facts.jsonl"), facts.map((fact) => JSON.stringify(fact)).join("\n"));
  await fs.writeFile(path.join(resolved, "takes", "takes.jsonl"), takes.map((take) => JSON.stringify(take)).join("\n"));

  return config;
}

async function writeDefaultGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore");
  try {
    await fs.access(gitignorePath);
    return;
  } catch {
    // Continue; the workspace does not have a .gitignore yet.
  }
  await fs.writeFile(
    gitignorePath,
    [
      "# OpenWiki derived runtime state",
      ".openwiki/index/",
      ".openwiki/index-store/",
      ".openwiki/agents/",
      ".openwiki/inbox/",
      ".openwiki/cache/",
      ".openwiki/objects/",
      ".openwiki/locks/",
      ".openwiki/sync/",
      ".openwiki/tmp/",
      ".openwiki/worktrees/",
      "",
    ].join("\n"),
  );
}

export async function loadRepository(root: string): Promise<LoadedOpenWikiRepo> {
  const resolved = path.resolve(root);
  const processFingerprint = await repositoryProcessCacheFingerprint(resolved);
  const mutationToken = repositoryMutationToken(resolved);
  const processCached = repositoryProcessReadCache.get(resolved);
  if (processCached !== undefined) {
    if (
      processCached.expiresAt > Date.now()
      && processCached.fingerprint === processFingerprint
      && processCached.mutationToken === mutationToken
    ) {
      return processCached.loaded;
    }
    repositoryProcessReadCache.delete(resolved);
  }
  const cache = repositoryReadCache.getStore();
  const cached = cache?.get(resolved);
  if (cached !== undefined) {
    if (cached.fingerprint === processFingerprint && cached.mutationToken === mutationToken) {
      return cached.loaded;
    }
    cache?.delete(resolved);
  }
  const loaded = loadRepositoryUncached(resolved);
  const cacheEntry: RepositoryReadCacheEntry = { loaded, fingerprint: processFingerprint, mutationToken };
  cache?.set(resolved, cacheEntry);
  try {
    const repo = await loaded;
    const ttlMs = repositoryProcessCacheTtlMs(repo);
    if (ttlMs > 0) {
      repositoryProcessReadCache.set(resolved, {
        loaded: Promise.resolve(repo),
        expiresAt: Date.now() + ttlMs,
        fingerprint: processFingerprint,
        mutationToken,
      });
    }
    return repo;
  } catch (error) {
    cache?.delete(resolved);
    repositoryProcessReadCache.delete(resolved);
    throw error;
  }
}

export async function withRepositoryReadCache<T>(callback: () => Promise<T>): Promise<T> {
  return repositoryReadCache.run(new Map(), callback);
}

async function loadRepositoryUncached(resolved: string): Promise<LoadedOpenWikiRepo> {
  const config = await readConfig(resolved);
  const [pages, sources, claims, facts, takes, inbox, proposals, comments, decisions, events, runs, policy] = await Promise.all([
    loadPages(resolved),
    loadSources(resolved),
    loadClaims(resolved),
    loadFacts(resolved),
    loadTakes(resolved),
    loadInboxItems(resolved),
    loadProposals(resolved),
    loadProposalComments(resolved),
    loadDecisions(resolved),
    loadEvents(resolved),
    loadRuns(resolved),
    loadPolicy(resolved),
  ]);

  return { root: resolved, config, pages, sources, claims, facts, takes, inbox, proposals, comments, decisions, events, runs, policy };
}

function repositoryProcessCacheTtlMs(repo: LoadedOpenWikiRepo): number {
  const configured = process.env.OPENWIKI_REPOSITORY_CACHE_TTL_MS;
  if (configured !== undefined) {
    return boundedRepositoryCacheTtlMs(configured);
  }
  try {
    const mode = openWikiRuntimeModeFromEnvOrProfile(process.env, repo.config.runtime?.profile);
    return openWikiRuntimeModeRequiresHostedStores(mode) ? 30_000 : 0;
  } catch {
    return 0;
  }
}

function boundedRepositoryCacheTtlMs(value: string): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(Math.max(parsed, 0), 5 * 60 * 1000);
}

async function repositoryProcessCacheFingerprint(root: string): Promise<string> {
  const files = [
    "openwiki.json",
    "policy/sections.json",
    "policy/grants.json",
    "policy/approval-rules.json",
    "claims/claim-index.jsonl",
    "facts/facts.jsonl",
    "takes/takes.jsonl",
    "inbox/items.jsonl",
    "proposals/comments.jsonl",
    "events/events.jsonl",
    "runs/runs.jsonl",
  ];
  const fileParts = await Promise.all(files.map(async (repoPath) => {
    try {
      const stats = await fs.stat(path.join(root, repoPath));
      return `${repoPath}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return `${repoPath}:missing`;
    }
  }));
  return fileParts.join("|");
}

export async function readWorkspaceRegistry(root: string): Promise<OpenWikiWorkspaceRegistry> {
  const repo = await loadRepository(root);
  const organizationId = "organization:local";
  const tenantId = "tenant:local";
  const workspaceRepoId = "workspace_repo:default";
  const createdAt = repo.config.created_at;
  return {
    source: "git",
    organizations: [
      {
        id: organizationId,
        uri: idToUri(organizationId),
        type: "organization",
        title: "Local Organization",
        created_at: createdAt,
      },
    ],
    tenants: [
      {
        id: tenantId,
        uri: idToUri(tenantId),
        type: "tenant",
        organization_id: organizationId,
        title: "Local Tenant",
        created_at: createdAt,
      },
    ],
    workspaces: [
      {
        id: repo.config.workspace_id,
        uri: idToUri(repo.config.workspace_id),
        type: "workspace",
        tenant_id: tenantId,
        title: repo.config.title,
        repo_format: repo.config.repo_format,
        protocol_version: repo.config.protocol_version,
        created_at: repo.config.created_at,
        config: repo.config,
      },
    ],
    repos: [
      {
        id: workspaceRepoId,
        uri: idToUri(workspaceRepoId),
        type: "workspace_repo",
        workspace_id: repo.config.workspace_id,
        repo_id: "repo:default",
        root_path: repo.root,
        ...(repo.config.runtime?.git?.remote === undefined ? {} : { remote: repo.config.runtime.git.remote }),
        ...(repo.config.runtime?.git?.branch === undefined ? {} : { branch: repo.config.runtime.git.branch }),
        ...(repo.config.runtime?.git?.remote_url === undefined ? {} : { remote_url: repo.config.runtime.git.remote_url }),
        ...(repo.config.runtime?.git?.credential_ref === undefined ? {} : { credential_ref: repo.config.runtime.git.credential_ref }),
      },
    ],
  };
}
