import path from "node:path";
import { resolveSourceFetchRequest, type SourceFetchConnectorKind } from "@openwiki/connectors";
import {
  type ProposalRecord,
  type SourceRecord,
  type ValidationIssue,
  type ValidationReport,
  assertOpenWikiId,
  idToUri,
  isoNow,
  writeOpenWikiLog,
} from "@openwiki/core";
import { appendEvent, loadRepository } from "@openwiki/repo";
import {
  contentBuffer,
  createContentStore,
  inlineMaxBytes,
  sha256Buffer,
} from "@openwiki/storage";
import { BASE_SOURCE_FETCH_HEADERS, detectPromptInjection, fetchSourceWithPinnedDns, readFetchBody, recordSourceFetchMetric, sourceFetchBudget, sourceFetchErrorStatus, validateSourceUrl } from "./source-fetch.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { currentGitCommit } from "./git.ts";
import { runPostEventAutomation } from "./sync.ts";
import {
  dateSequenceId,
  nextDailySequence,
  renderProposalYaml,
  unifiedDiff,
  yamlScalar,
} from "./format.ts";
import { writeText } from "./io.ts";
import type {
  FetchSourceInput,
  FetchSourceResult,
  IngestSourceInput,
  IngestSourceResult,
  ProposeSourceInput,
  ProposeSourceResult,
  SourceIngestReport,
} from "./types.ts";

export async function ingestSource(input: IngestSourceInput): Promise<IngestSourceResult> {
  const result = await withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.ingest_source",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        title: input.title,
      },
    },
    () => ingestSourceUnlocked(input),
  );
  if (input.postEventAutomation !== false) {
    await runPostEventAutomation({
      root: input.root,
      eventType: "source.ingested",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      recordId: result.source.id,
      recordType: "source",
      subjectIds: [result.source.id],
      subjectPaths: [result.manifest_path, ...(result.raw_path === undefined ? [] : [result.raw_path])],
    }).catch((error) => {
      writeOpenWikiLog({
        event: "post_event_automation_failed",
        level: "error",
        actor_id: input.actorId ?? "actor:user:local",
        metadata: { trigger_event: "source.ingested", source_id: result.source.id },
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return result;
}

async function ingestSourceUnlocked(input: IngestSourceInput): Promise<IngestSourceResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const retrievedAt = input.retrievedAt ?? now;
  const title = input.title.trim();
  if (!title) {
    throw new Error("Source title cannot be empty");
  }
  const sourceType = input.sourceType ?? inferSourceType(input.url);
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const sourceUrl = input.url === undefined ? undefined : validateSourceUrl(input.url);

  const sequence = nextDailySequence(repo.sources.map((source) => source.id), "source", now);
  const sourceId = dateSequenceId("source", now, sequence);
  const sourceStem = sourceId.replace(/:/g, "_").replace(/-/g, "_");
  const manifestPath = `sources/manifests/${sourceStem}.yaml`;
  const content = input.content?.trim();
  const contentPayload = content === undefined ? undefined : `${content}\n`;
  const contentBytes = contentPayload === undefined ? undefined : contentBuffer(contentPayload);
  const contentHash = contentBytes === undefined ? undefined : `sha256:${sha256Buffer(contentBytes)}`;
  const rawPath =
    contentBytes !== undefined && contentBytes.byteLength <= inlineMaxBytes(repo.config.runtime?.storage)
      ? `sources/raw/${sourceStem}.txt`
      : undefined;
  await input.authorizePaths?.({
    sourceId,
    manifestPath,
    ...(rawPath === undefined ? {} : { rawPath }),
  });
  const objectStore =
    contentBytes !== undefined && rawPath === undefined
      ? await createContentStore(repo.root, repo.config.runtime?.storage)
      : undefined;
  const objectStorage =
    objectStore === undefined || contentBytes === undefined
      ? undefined
      : await objectStore.put({
          data: contentBytes,
          namespace: "sources",
          extension: "txt",
          mediaType: "text/plain; charset=utf-8",
        });

  const source: SourceRecord = {
    id: sourceId,
    uri: idToUri(sourceId),
    type: "source",
    title,
    source_type: sourceType,
    retrieved_at: retrievedAt,
    path: manifestPath,
  };
  if (sourceUrl !== undefined) {
    source.url = sourceUrl;
  }
  if (contentHash !== undefined) {
    source.content_hash = contentHash;
  }
  const storage = {
    ...(input.storage ?? {}),
    ...(rawPath === undefined
      ? {}
      : {
          kind: "git",
          path: rawPath,
          content_hash: contentHash,
          bytes: contentBytes?.byteLength,
          content_addressed: false,
        }),
    ...(objectStorage === undefined ? {} : objectStorage),
  };
  if (Object.keys(storage).length > 0) {
    source.storage = storage;
  }
  source.trust = sourceTrustMetadata(input.trust, content, sourceUrl);

  const validation = validateSourceIngest(source, content, actorId, now);
  if (validation.status === "failed") {
    throw new Error(validation.issues.map((issue) => issue.message).join("; "));
  }

  if (rawPath && contentPayload) {
    await writeText(repo.root, rawPath, contentPayload);
  }
  await writeText(repo.root, manifestPath, renderSourceYaml(source, actorId));
  await appendEvent(repo.root, {
    type: "source.ingested",
    actor_id: actorId,
    operation: "wiki.ingest_source",
    record_id: source.id,
    record_type: "source",
    occurred_at: now,
    data: {
      manifest_path: manifestPath,
      ...(rawPath === undefined ? {} : { raw_path: rawPath }),
      ...(objectStorage === undefined ? {} : { object_path: objectStorage.path }),
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return {
    source,
    validation,
    manifest_path: manifestPath,
    ...(rawPath === undefined ? {} : { raw_path: rawPath }),
    ...(objectStorage === undefined ? {} : { object_path: objectStorage.path }),
  };
}

export async function fetchAndIngestSource(input: FetchSourceInput): Promise<FetchSourceResult> {
  const startedAt = Date.now();
  let connectorKind: SourceFetchConnectorKind | "unknown" = input.connectorKind ?? "http";
  let logMetadata: Record<string, unknown> = {
    connector_kind: connectorKind,
    actor_id: input.actorId ?? "actor:user:local",
    credential_ref: input.credentialRef,
    connector_id: input.connectorId,
  };
  try {
    const repo = await loadRepository(input.root);
    const url = input.url === undefined ? undefined : validateSourceUrl(input.url);
    const connector = await resolveSourceFetchRequest({
      config: repo.config,
      ...(url === undefined ? {} : { url }),
      ...(input.connectorKind === undefined ? {} : { connectorKind: input.connectorKind }),
      baseHeaders: BASE_SOURCE_FETCH_HEADERS,
      ...(input.connectorId === undefined ? {} : { connectorId: input.connectorId }),
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      ...(input.githubOwner === undefined || input.githubRepo === undefined || input.sourcePath === undefined
        ? {}
        : {
            github: {
              owner: input.githubOwner,
              repo: input.githubRepo,
              path: input.sourcePath,
              ...(input.ref === undefined ? {} : { ref: input.ref }),
            },
          }),
      ...(input.gitlabProject === undefined || input.sourcePath === undefined || input.ref === undefined
        ? {}
        : {
            gitlab: {
              project: input.gitlabProject,
              path: input.sourcePath,
              ref: input.ref,
            },
          }),
      ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
    });
    connectorKind = connector.connectorKind;
    logMetadata = {
      ...logMetadata,
      connector_kind: connector.connectorKind,
      connector_id: connector.trust.connector_id,
      credential_ref: connector.trust.credential_ref,
      repository: connector.trust.repository,
      source_path: connector.trust.source_path,
    };
    const budget = sourceFetchBudget(repo.config.runtime?.controls?.source_fetch, {
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const timeoutMs = budget.timeoutMs;
    const maxBytes = budget.maxBytes;
    writeOpenWikiLog({
      event: "source_fetch_started",
      actor_id: input.actorId ?? "actor:user:local",
      metadata: {
        ...logMetadata,
        timeout_ms: timeoutMs,
        max_bytes: maxBytes,
      },
    });
    const response =
      input.fetcher === undefined
        ? await fetchSourceWithPinnedDns(connector.requestUrl, connector.headers, timeoutMs, maxBytes)
        : await input.fetcher(connector.requestUrl, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
            headers: connector.headers,
          });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Source fetch redirects are not followed; ingest the final URL explicitly");
    }
    if (!response.ok) {
      throw new Error(`Source fetch failed with HTTP ${response.status}`);
    }
    const body = await readFetchBody(response, maxBytes);
    const contentType = response.headers.get("content-type") ?? undefined;
    const result = await ingestSource({
      root: input.root,
      title: input.title,
      url: connector.sourceUrl,
      content: body.text,
      ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.authorizePaths === undefined ? {} : { authorizePaths: input.authorizePaths }),
      trust: {
        retrieval: "fetched",
        fetch_status: response.status,
        ...connector.trust,
        ...(contentType === undefined ? {} : { content_type: contentType }),
      },
    });
    recordSourceFetchMetric(connectorKind, "success", Date.now() - startedAt);
    writeOpenWikiLog({
      event: "source_fetch_succeeded",
      actor_id: input.actorId ?? "actor:user:local",
      duration_ms: Date.now() - startedAt,
      metadata: {
        ...logMetadata,
        status: response.status,
        bytes: body.bytes,
        content_type: contentType,
        source_id: result.source.id,
      },
    });
    return {
      ...result,
      fetch: {
        url: connector.sourceUrl,
        ...(connector.requestUrl === connector.sourceUrl ? {} : { request_url: connector.requestUrl }),
        status: response.status,
        ...(contentType === undefined ? {} : { content_type: contentType }),
        bytes: body.bytes,
        ...connector.trust,
      },
    };
  } catch (error) {
    const status = sourceFetchErrorStatus(error);
    recordSourceFetchMetric(connectorKind, status, Date.now() - startedAt);
    writeOpenWikiLog({
      event: "source_fetch_failed",
      level: "error",
      actor_id: input.actorId ?? "actor:user:local",
      duration_ms: Date.now() - startedAt,
      metadata: logMetadata,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function assertSourceFetchBudgetForRoot(
  root: string,
  requested: { maxBytes?: number; timeoutMs?: number },
): Promise<void> {
  const repo = await loadRepository(root);
  sourceFetchBudget(repo.config.runtime?.controls?.source_fetch, requested);
}

export async function proposeSource(input: ProposeSourceInput): Promise<ProposeSourceResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_source",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        title: input.title,
      },
    },
    () => proposeSourceUnlocked(input),
  );
}

async function proposeSourceUnlocked(input: ProposeSourceInput): Promise<ProposeSourceResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const title = input.title.trim();
  if (!title) {
    throw new Error("Source title cannot be empty");
  }

  const sourceUrl = input.url === undefined ? undefined : validateSourceUrl(input.url);
  const knownSourceAndTargetIds = [
    ...repo.sources.map((source) => source.id),
    ...repo.proposals.flatMap((proposal) => proposal.target_ids.filter((targetId) => targetId.startsWith("source:"))),
  ];
  const sourceId = dateSequenceId("source", now, nextDailySequence(knownSourceAndTargetIds, "source", now));
  const sourceStem = sourceId.replace(/:/g, "_").replace(/-/g, "_");
  const manifestPath = `sources/manifests/${sourceStem}.yaml`;
  await input.authorizePaths?.({ sourceId, manifestPath });
  const source: SourceRecord = {
    id: sourceId,
    uri: idToUri(sourceId),
    type: "source",
    title,
    source_type: input.sourceType ?? inferSourceType(sourceUrl),
    retrieved_at: input.retrievedAt ?? now,
    path: manifestPath,
    trust: sourceTrustMetadata(input.trust, undefined, sourceUrl),
  };
  if (sourceUrl !== undefined) {
    source.url = sourceUrl;
  }
  if (input.contentHash !== undefined) {
    source.content_hash = input.contentHash;
  }

  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", now);
  const proposalId = dateSequenceId("proposal", now, sequence);
  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const snapshotPath = `proposals/snapshots/${proposalStem}/${path.basename(source.path)}`;
  const manifest = renderSourceYaml(source, actorId);
  const diff = unifiedDiff(source.path, "", manifest);
  const validation = validateProposedSource(proposalId, source, actorId, now);
  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: `Add source ${title}`,
    status: "open",
    actor_id: actorId,
    target_ids: [source.id],
    target_path: source.path,
    diff: {
      format: "unified",
      path: diffPath,
    },
    snapshot_path: snapshotPath,
    validation_report_path: reportPath,
    created_at: now,
    path: proposalPath,
  };
  const baseCommit = await currentGitCommit(repo.root);
  if (baseCommit) {
    proposal.base_commit = baseCommit;
  }
  if (input.rationale) {
    proposal.rationale = input.rationale;
  }

  await writeText(repo.root, diffPath, diff);
  await writeText(repo.root, snapshotPath, manifest);
  await writeText(repo.root, reportPath, `${JSON.stringify(validation, null, 2)}\n`);
  await writeText(repo.root, proposalPath, renderProposalYaml(proposal));
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: actorId,
    operation: "wiki.propose_source",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: now,
    data: {
      target_ids: proposal.target_ids,
      target_path: proposal.target_path,
      diff_path: proposal.diff.path,
      snapshot_path: proposal.snapshot_path,
      validation_report_path: proposal.validation_report_path,
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal, source, validation, diff };
}

function validateProposedSource(
  proposalId: string,
  source: SourceRecord,
  actorId: string,
  checkedAt: string,
): ValidationReport {
  const sourceValidation = validateSourceIngest(source, undefined, actorId, checkedAt);
  return {
    id: `${proposalId}:validation`,
    proposal_id: proposalId,
    status: sourceValidation.status,
    checked_at: checkedAt,
    issues: sourceValidation.issues,
  };
}

function validateSourceIngest(
  source: SourceRecord,
  content: string | undefined,
  actorId: string,
  checkedAt: string,
): SourceIngestReport {
  const issues: ValidationIssue[] = [];
  if (!source.title.trim()) {
    issues.push({
      severity: "error",
      code: "source.title.empty",
      message: "Source title cannot be empty.",
      path: source.path,
    });
  }
  if (!validSourceTypes.has(source.source_type)) {
    issues.push({
      severity: "error",
      code: "source.type.invalid",
      message: `Unsupported source_type '${source.source_type}'.`,
      path: source.path,
    });
  }
  if (!source.url && !content) {
    issues.push({
      severity: "warning",
      code: "source.evidence.thin",
      message: "Source has neither a URL nor raw captured content.",
      path: source.path,
    });
  }
  const promptInjection = detectPromptInjection(content);
  if (promptInjection.detected) {
    issues.push({
      severity: "warning",
      code: "source.prompt_injection.suspected",
      message: `Source content contains instruction-like text: ${promptInjection.patterns.join(", ")}.`,
      path: source.path,
    });
  }
  if (!actorId.startsWith("actor:")) {
    issues.push({
      severity: "error",
      code: "source.actor.invalid",
      message: "Source ingestion actor must be an actor ID.",
      path: source.path,
    });
  }

  return {
    id: `${source.id}:validation`,
    source_id: source.id,
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    checked_at: checkedAt,
    issues,
  };
}

function renderSourceYaml(source: SourceRecord, actorId: string): string {
  const lines = [
    `id: ${source.id}`,
    `title: ${yamlScalar(source.title)}`,
    `source_type: ${source.source_type}`,
    ...(source.url === undefined ? [] : [`url: ${yamlScalar(source.url)}`]),
    `retrieved_at: ${source.retrieved_at}`,
    ...(source.content_hash === undefined ? [] : [`content_hash: ${source.content_hash}`]),
    `ingested_by: ${actorId}`,
    ...(source.storage === undefined ? [] : ["storage:", ...renderYamlObject(source.storage)]),
    ...(source.trust === undefined ? [] : ["trust:", ...renderYamlObject(source.trust)]),
    "",
  ];
  return lines.join("\n");
}

function renderYamlObject(value: Record<string, unknown>): string[] {
  return Object.entries(value).map(([key, entry]) => `  ${key}: ${yamlScalar(String(entry))}`);
}

function inferSourceType(url: string | undefined): string {
  if (!url) {
    return "manual";
  }
  const pathname = new URL(validateSourceUrl(url)).pathname.toLowerCase();
  if (pathname.endsWith(".pdf")) {
    return "pdf";
  }
  return "webpage";
}

function sourceTrustMetadata(
  inputTrust: Record<string, unknown> | undefined,
  content: string | undefined,
  sourceUrl: string | undefined,
): Record<string, unknown> {
  const promptInjection = detectPromptInjection(content);
  return {
    ...(inputTrust ?? {}),
    reliability: inputTrust?.reliability ?? "unknown",
    sensitivity: inputTrust?.sensitivity ?? "unknown",
    evidence_treatment: "untrusted",
    instruction_policy: "never_execute_source_instructions",
    retrieval_mode: sourceUrl === undefined ? "manual" : "url_reference",
    prompt_injection: promptInjection.detected ? "suspected" : "not_detected",
    ...(promptInjection.detected ? { prompt_injection_patterns: promptInjection.patterns.join(",") } : {}),
  };
}

const validSourceTypes = new Set(["webpage", "pdf", "document", "transcript", "image", "dataset", "manual"]);
