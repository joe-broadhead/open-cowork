import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createRun, runLocalJob } from "@openwiki/jobs";
import { checkIndexStoreIntegrity, listIndexStoreEdges, listIndexStoreRecords, readIndexStoreSummary, rebuildIndexStore } from "@openwiki/index-store";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { checkPostgresRuntimeIntegrity, listCurrentPostgresOpenQuestions, listCurrentPostgresSources, listCurrentPostgresTopics, migratePostgresRuntime, postgresRuntimeSchemaSql, readCurrentPostgresSource, readPostgresRuntimeSummary, readPostgresWriteLease, rebuildPostgresRuntimeIndex, recoverExpiredPostgresWriteLease, syncPostgresRuntimeIndex } from "@openwiki/postgres-runtime";
import { createWorkspace, listOpenQuestions, listTopics, loadRepository, readClaim, readDecision, readPage, readSource, readSourceContent, traceClaim } from "@openwiki/repo";
import { buildSearchIndex, searchWiki } from "@openwiki/search";
import { askWithCitations, ingestSource, proposeEdit, proposeSource, runGovernanceDetectors, thinkWithCitations } from "@openwiki/workflows";
import type { SearchRequest } from "@openwiki/core";
import { resolveRoot, searchFiltersFromOptions } from "../utils.ts";
import { diffCommand, historyCommand } from "./graph-audit.ts";

export async function initCommand(args: string[], options: CliOptions): Promise<void> {
  const target = path.resolve(args[0] ?? ".");
  const config = await createWorkspace(target, {
    title: options.title ?? "OpenWiki",
    template: options.template ?? "team-wiki",
  });
  if (options.json) {
    printJson({ root: target, template: options.template ?? "team-wiki", config });
    return;
  }
  console.log(`Initialized OpenWiki at ${target}`);
  console.log(`Template: ${options.template ?? "team-wiki"}`);
  console.log(`Workspace: ${config.workspace_id}`);
}

export async function indexCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await buildSearchIndex(root);
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Indexed ${result.recordCount} records`);
  console.log(result.dbPath);
}

export async function dbCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "schema" && args[1] === "postgres") {
    const result = { sql: postgresRuntimeSchemaSql() };
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(result.sql);
    return;
  }
  if (subcommand === "migrate") {
    const result = await migratePostgresRuntime();
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Postgres runtime migrations applied=${result.applied.length} skipped=${result.skipped.length}`);
    console.log(`database_url_env=${result.database_url_env}`);
    return;
  }
  const root = await resolveRoot(options);
  if (subcommand === "rebuild") {
    const result = await rebuildIndexStore(root);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Rebuilt index-store: records=${result.recordCount} edges=${result.edgeCount} permissions=${result.effectivePermissionCount}`);
    console.log(result.dbPath);
    return;
  }
  if (subcommand === "sync-postgres") {
    const full = args.includes("--full");
    const result = full ? { ...(await rebuildPostgresRuntimeIndex(root)), mode: "rebuild" as const, changed_paths: [], upserted_record_count: 0 } : await syncPostgresRuntimeIndex(root);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Synced Postgres runtime (${result.mode}): records=${result.record_count} edges=${result.edge_count} search_documents=${result.search_document_count}`);
    if (result.changed_paths.length > 0) {
      console.log(`changed_paths=${result.changed_paths.length} upserted_records=${result.upserted_record_count}`);
    }
    return;
  }
  if (subcommand === "postgres-summary") {
    const result = await readPostgresRuntimeSummary(root);
    if (options.json) {
      printJson(result ?? { source: "postgres-runtime", status: "missing" });
      return;
    }
    if (!result) {
      console.log("Postgres runtime has not been synced for this workspace");
      return;
    }
    console.log(`Postgres runtime records=${result.record_count} edges=${result.edge_count} search_documents=${result.search_document_count}`);
    console.log(`source_commit=${result.source_commit ?? "unknown"}`);
    return;
  }
  if (subcommand === "write-lease") {
    const result = await readPostgresWriteLease(root, { ...(options.lockName === undefined ? {} : { lockName: options.lockName }) });
    if (options.json) {
      printJson(result ?? { source: "postgres-runtime", status: "missing", lock_name: options.lockName ?? "git-writes" });
      return;
    }
    if (!result) {
      console.log(`No active Postgres write lease for ${options.lockName ?? "git-writes"}`);
      return;
    }
    console.log(`Postgres write lease ${result.lock_name}: ${result.operation} by ${result.actor_id}`);
    console.log(`started=${result.started_at} heartbeat=${result.heartbeat_at} expires=${result.expires_at}`);
    return;
  }
  if (subcommand === "recover-write-lease") {
    const result = await recoverExpiredPostgresWriteLease(root, { ...(options.lockName === undefined ? {} : { lockName: options.lockName }) });
    if (options.json) {
      printJson(result);
      return;
    }
    if (result.recovered) {
      console.log(`Recovered expired Postgres write lease ${result.lock_name}`);
    } else if (result.active) {
      console.log(`Postgres write lease ${result.lock_name} is still active until ${result.active.expires_at}; no recovery performed`);
    } else {
      console.log(`No Postgres write lease found for ${result.lock_name}`);
    }
    return;
  }
  if (subcommand === "check") {
    const result = await checkIndexStoreIntegrity(root);
    const postgres = await checkPostgresRuntimeIntegrity(root).catch(() => undefined);
    if (options.json) {
      printJson({
        ...result,
        ...(postgres === undefined ? {} : { postgres_runtime: postgres }),
      });
    } else if (result.ok) {
      console.log(`Index-store is current: records=${result.recordCount} edges=${result.edgeCount}`);
    } else {
      console.log("Index-store is stale or missing");
      for (const issue of result.issues) {
        console.log("- " + issue);
      }
    }
    if (!options.json && postgres !== undefined) {
      if (postgres.ok) {
        console.log(`Postgres runtime is current: records=${postgres.record_count} source_commit=${postgres.source_commit ?? "unknown"}`);
      } else {
        console.log("Postgres runtime is stale or missing");
        for (const issue of postgres.issues) {
          console.log("- " + issue);
        }
      }
    }
    if (!result.ok || postgres?.ok === false) {
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "summary") {
    const result = await readIndexStoreSummary(root);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Index-store records=${result.recordCount} edges=${result.edgeCount} permissions=${result.effectivePermissionCount}`);
    console.log(`source_commit=${result.sourceCommit ?? "unknown"}`);
    console.log(result.dbPath);
    return;
  }
  if (subcommand === "records") {
    const result = await listIndexStoreRecords(root, {
      ...(options.types[0] === undefined ? {} : { type: options.types[0] }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    for (const record of result.records) {
      console.log(record.record_type + "  " + record.record_id + "  " + record.title);
    }
    return;
  }
  if (subcommand === "edges") {
    const result = await listIndexStoreEdges(root, {
      ...(options.types[0] === undefined ? {} : { type: options.types[0] }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    for (const edge of result.edges) {
      console.log(edge.edge_type + "  " + edge.from_id + " -> " + edge.to_id);
    }
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] db rebuild|sync-postgres [--full]|migrate|schema postgres|check|summary|postgres-summary|write-lease|recover-write-lease|records|edges [--type page|page_source] [--limit N] [--lock-name name] [--json]");
}

export async function searchCommand(args: string[], options: CliOptions): Promise<void> {
  const resolved = await splitOptionalPositionalRoot(args, options);
  const query = resolved.args.join(" ").trim();
  if (!query) {
    throw new Error(
      "Usage: openwiki [--root <path>] search <query> [--json] [--limit N] or openwiki search <wiki-root> <query>",
    );
  }
  const root = await resolveRoot(resolved.options);
  const searchRequest: SearchRequest = {
    query,
    include_explain: options.explain,
    include_highlights: options.highlights,
    ...(options.persona === undefined ? {} : { persona: options.persona }),
    ...(options.types.length === 0 ? {} : { types: options.types }),
    ...(options.searchMode === undefined ? {} : { mode: options.searchMode }),
    ...(options.fuzzy ? { fuzzy: true } : {}),
    ...searchFiltersFromOptions(options),
  };
  const response = await searchWiki(root, {
    ...searchRequest,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
  });

  if (options.json) {
    printJson(response);
    return;
  }

  for (const result of response.results) {
    console.log(`${result.score.toFixed(4)}  ${result.id}  ${result.title}`);
    if (result.summary) {
      console.log(`        ${result.summary}`);
    }
  }
}

export async function askCommand(args: string[], options: CliOptions): Promise<void> {
  const resolved = await splitOptionalPositionalRoot(args, options);
  const question = resolved.args.join(" ").trim();
  if (!question) {
    throw new Error("Usage: openwiki [--root <path>] ask <question> [--citations] [--json] [--limit N] or openwiki ask <wiki-root> <question>");
  }
  const result = await askWithCitations({
    root: await resolveRoot(resolved.options),
    question,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    includeExplain: options.explain,
  });
  if (options.json) {
    printJson(result);
    return;
  }

  console.log(result.answer);
  if (options.citations) {
    console.log("");
    for (const [index, citation] of result.citations.entries()) {
      console.log(`[${index + 1}] ${citation.id}  ${citation.title}`);
    }
  }
}

export async function thinkCommand(args: string[], options: CliOptions): Promise<void> {
  const resolved = await splitOptionalPositionalRoot(args, options);
  const question = resolved.args.join(" ").trim();
  if (!question) {
    throw new Error("Usage: openwiki [--root <path>] think <question> [--citations] [--json] [--limit N] or openwiki think <wiki-root> <question>");
  }
  const result = await thinkWithCitations({
    root: await resolveRoot(resolved.options),
    question,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    includeExplain: true,
  });
  if (options.json) {
    printJson(result);
    return;
  }

  console.log(result.answer);
  if (result.gaps.length > 0) {
    console.log("");
    console.log("Gaps:");
    for (const gap of result.gaps) {
      console.log(`- ${gap.reason}`);
    }
  }
  if (options.citations) {
    console.log("");
    for (const [index, citation] of result.citations.entries()) {
      console.log(`[${index + 1}] ${citation.id}  ${citation.title}`);
    }
  }
}

async function splitOptionalPositionalRoot(args: string[], options: CliOptions): Promise<{ args: string[]; options: CliOptions }> {
  if (options.root !== undefined || args.length < 2) {
    return { args, options };
  }
  const [candidate, ...rest] = args;
  if (candidate === undefined) {
    return { args, options };
  }
  const root = path.resolve(candidate);
  try {
    await access(path.join(root, "openwiki.json"));
    return { args: rest, options: { ...options, root } };
  } catch {
    return { args, options };
  }
}

export async function pageCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  if (subcommand !== "read" || !id) {
    throw new Error("Usage: openwiki page read <id> [--json]");
  }
  const page = await readPage(await resolveRoot(options), id);
  if (options.json) {
    printJson(page);
    return;
  }
  console.log(`# ${page.title}\n`);
  console.log(page.body);
}

export async function pagesCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id, ...rest] = args;
  if (subcommand === "list") {
    const root = await resolveRoot(options);
    const repo = await loadRepository(root);
    const limit = Math.max(options.limit ?? 100, 0);
    const pages = [...repo.pages]
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
      .slice(0, limit);
    const result = {
      pages: pages.map((page) => ({
        id: page.id,
        title: page.title,
        path: page.path,
        summary: page.summary,
        topics: page.topics,
        updated_at: page.updated_at,
      })),
      total: repo.pages.length,
      limit,
    };
    if (options.json) {
      printJson(result);
      return;
    }
    for (const page of result.pages) {
      console.log(`${page.id}\t${page.title}\t${page.path}`);
    }
    return;
  }
  if (subcommand === "read" && id) {
    await pageCommand(["read", id], options);
    return;
  }
  if (subcommand === "search") {
    await searchCommand([id, ...rest].filter((value): value is string => value !== undefined), { ...options, types: ["page"] });
    return;
  }
  if (subcommand === "history" && id) {
    await historyCommand([id], options);
    return;
  }
  if (subcommand === "diff" && id) {
    await diffCommand([id], options);
    return;
  }
  if (subcommand === "propose" && id) {
    if (!options.bodyFile) {
      throw new Error("Usage: openwiki [--root <path>] pages propose <page-id> --body-file <path> [--actor actor:user:local] [--rationale text] [--summary text] [--title text] [--json]");
    }
    const result = await proposeEdit({
      root: await resolveRoot(options),
      pageId: id,
      body: await readFile(path.resolve(options.bodyFile), "utf8"),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created proposal ${result.proposal.id}`);
    console.log(result.proposal.diff.path);
    console.log(result.validation.status);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] pages list|read <id>|search <query>|history <id>|diff <id>|propose <id> [--json]");
}

export async function sourceCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  const root = await resolveRoot(options);
  if (subcommand === "list") {
    const postgresResult = await listCurrentPostgresSources(root, options.limit);
    const result = postgresResult ?? (() => undefined)();
    if (result !== undefined) {
      if (options.json) {
        printJson(result);
        return;
      }
      for (const source of result.sources) {
        console.log(`${source.id}  ${source.title}`);
      }
      return;
    }
    {
      const repo = await loadRepository(root);
      const fallback = {
        sources: repo.sources.slice(0, Math.max(options.limit ?? 100, 0)),
        total: repo.sources.length,
      };
      if (options.json) {
        printJson(fallback);
        return;
      }
      for (const source of fallback.sources) {
        console.log(`${source.id}  ${source.title}`);
      }
      return;
    }
  }
  if (subcommand === "read" && id) {
    const source = (await readCurrentPostgresSource(root, id)) ?? (await readSource(root, id));
    printJson(source);
    return;
  }
  if (subcommand === "content" && id) {
    const content = await readSourceContent(
      root,
      id,
      options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes },
    );
    if (options.json) {
      printJson(content);
      return;
    }
    if (content.content === null) {
      console.log(content.unavailable_reason ?? "unavailable");
      return;
    }
    console.log(content.content.body);
    return;
  }
  if (subcommand === "fetch") {
    const connectorKind = options.connectorKind ?? "http";
    if (!options.title || (connectorKind === "http" && !options.url)) {
      throw new Error(
        "Usage: openwiki [--root <path>] source fetch --title text --url URL [--source-type type] [--connector-kind http|github|gitlab] [--connector id] [--credential-ref ref] [--github-owner owner --github-repo repo --source-path path] [--gitlab-project group/project --source-path path --ref ref] [--actor actor:user:local] [--max-bytes N] [--timeout-ms N] [--enqueue] [--json]",
      );
    }
    const input = {
      title: options.title,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.sourceType === undefined ? {} : { source_type: options.sourceType }),
      ...(options.connectorKind === undefined ? {} : { connector_kind: options.connectorKind }),
      ...(options.connectorId === undefined ? {} : { connector_id: options.connectorId }),
      ...(options.credentialRef === undefined ? {} : { credential_ref: options.credentialRef }),
      ...(options.githubOwner === undefined ? {} : { github_owner: options.githubOwner }),
      ...(options.githubRepo === undefined ? {} : { github_repo: options.githubRepo }),
      ...(options.gitlabProject === undefined ? {} : { gitlab_project: options.gitlabProject }),
      ...(options.sourcePath === undefined ? {} : { source_path: options.sourcePath }),
      ...(options.sourceRef === undefined ? {} : { ref: options.sourceRef }),
      ...(options.maxBytes === undefined ? {} : { max_bytes: options.maxBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    };
    if (options.enqueue) {
      const run = await createRun({
        root,
        runType: "source.fetch",
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        input,
      });
      if (options.json) {
        printJson({ run });
        return;
      }
      console.log(`queued ${run.id} ${run.run_type}`);
      return;
    }
    const result = await runLocalJob({
      root,
      runType: "source.fetch",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      input,
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`${result.run.status} ${result.run.id} ${result.run.run_type}`);
    if (result.run.output?.source_id) {
      console.log(String(result.run.output.source_id));
    }
    return;
  }
  if (subcommand === "ingest") {
    if (!options.title) {
      throw new Error(
        "Usage: openwiki [--root <path>] source ingest --title text [--url URL] [--source-type type] [--content-file path] [--actor actor:user:local] [--json]",
      );
    }
    const content = options.contentFile ? await readFile(path.resolve(options.contentFile), "utf8") : undefined;
    const result = await ingestSource({
      root,
      title: options.title,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.sourceType === undefined ? {} : { sourceType: options.sourceType }),
      ...(content === undefined ? {} : { content }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Ingested source ${result.source.id}`);
    console.log(result.manifest_path);
    if (result.raw_path) {
      console.log(result.raw_path);
    }
    return;
  }
  if (subcommand === "propose") {
    if (!options.title) {
      throw new Error(
        "Usage: openwiki [--root <path>] source propose --title text [--url URL] [--source-type type] [--content-hash sha256:...] [--actor actor:user:local] [--rationale text] [--json]",
      );
    }
    const result = await proposeSource({
      root,
      title: options.title,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.sourceType === undefined ? {} : { sourceType: options.sourceType }),
      ...(options.contentHash === undefined ? {} : { contentHash: options.contentHash }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created source proposal ${result.proposal.id}`);
    console.log(result.source.id);
    console.log(result.proposal.target_path);
    return;
  }
  throw new Error(
    "Usage: openwiki source list | source read|content <id> | source ingest --title text | source propose --title text | source fetch --title text --url URL [--connector-kind http|github|gitlab] [--connector id] [--credential-ref ref] [--json]",
  );
}

export async function claimCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  const root = await resolveRoot(options);
  if (subcommand === "read" && id) {
    const claim = await readClaim(root, id);
    printJson(claim);
    return;
  }
  if (subcommand === "trace" && id) {
    printJson(await traceClaim(root, id));
    return;
  }
  throw new Error("Usage: openwiki claim read|trace <id> [--json]");
}

export async function decisionCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  if (subcommand !== "read" || !id) {
    throw new Error("Usage: openwiki decision read <id> [--json]");
  }
  const decision = await readDecision(await resolveRoot(options), id);
  if (options.json) {
    printJson(decision);
    return;
  }
  console.log(`${decision.decision}  ${decision.id}`);
  console.log(decision.rationale);
}

export async function topicsCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = (await listCurrentPostgresTopics(root)) ?? (await listTopics(root));
  if (options.json) {
    printJson(result);
    return;
  }
  for (const topic of result.topics) {
    console.log(`${topic.topic}  pages=${topic.page_count} claims=${topic.claim_count} sources=${topic.source_count}`);
  }
}

export async function questionsCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = (await listCurrentPostgresOpenQuestions(root)) ?? (await listOpenQuestions(root));
  if (options.json) {
    printJson(result);
    return;
  }
  for (const question of result.open_questions) {
    console.log(`${question.page_id}  ${question.question}`);
  }
}

export async function governanceCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand] = args;
  if (subcommand !== "detectors" && subcommand !== "detect" && subcommand !== "report") {
    throw new Error("Usage: openwiki [--root <path>] governance detectors [--detector stale_claim|missing_source|broken_link|orphan_page] [--stale-after-days N] [--json]");
  }
  const root = await resolveRoot(options);
  const result = await runGovernanceDetectors({
    root,
    ...(options.governanceDetectors.length === 0 ? {} : { detectors: options.governanceDetectors }),
    ...(options.staleAfterDays === undefined ? {} : { staleAfterDays: options.staleAfterDays }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`${result.status}  findings=${result.finding_count}`);
  for (const finding of result.findings) {
    console.log(`${finding.detector}  ${finding.severity}  ${finding.record_id}  ${finding.message}`);
  }
}
