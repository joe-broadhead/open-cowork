import { assertOpenWikiRunType } from "@openwiki/core";
import { rebuildIndexStore } from "@openwiki/index-store";
import { rebuildPostgresRuntimeIndex } from "@openwiki/postgres-runtime";
import { buildSearchIndex } from "@openwiki/search";
import { exportStaticSite } from "@openwiki/static-export";
import { validateRepository } from "@openwiki/validation";
import { createWorkspaceBackup, dreamRunInputFromRecord, fetchAndIngestSource, listInboxWorkflow, processInboxItem, runDreamCycle, syncWorkspaceNow, watchInboxOnce, withWriteCoordination } from "@openwiki/workflows";
import { inboxStatusesInput, optionalBoolean, optionalConnectorKindProperty, optionalInboxFailureProperty, optionalInboxWatchAdapterProperty, optionalNumberProperty, optionalString, optionalStringProperty, requiredString, syncRunOutput } from "./inputs.ts";
import type { PolicyContext } from "@openwiki/policy";

function rebuildPostgresRuntimeIfConfigured(root: string) {
  if (!process.env.OPENWIKI_DATABASE_URL?.trim() && !process.env.DATABASE_URL?.trim()) {
    return undefined;
  }
  return rebuildPostgresRuntimeIndex(root);
}

export async function executeLocalRun(
  root: string,
  runType: string,
  input: Record<string, unknown>,
  actorId?: string,
  runId?: string,
  policyContext?: PolicyContext,
): Promise<Record<string, unknown>> {
  assertOpenWikiRunType(runType);
  if (runType === "index.rebuild") {
    const [search, indexStore] = await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);
    const postgresRuntime = await rebuildPostgresRuntimeIfConfigured(root);
    return {
      db_path: search.dbPath,
      record_count: search.recordCount,
      index_store_db_path: indexStore.dbPath,
      index_store_record_count: indexStore.recordCount,
      index_store_edge_count: indexStore.edgeCount,
      ...(postgresRuntime === undefined
        ? {}
        : {
            postgres_runtime_record_count: postgresRuntime.record_count,
            postgres_runtime_edge_count: postgresRuntime.edge_count,
            postgres_runtime_search_document_count: postgresRuntime.search_document_count,
          }),
    };
  }

  if (runType === "static.export") {
    const outDir = optionalString(input, "out_dir") ?? optionalString(input, "outDir");
    const baseUrl = optionalString(input, "base_url") ?? optionalString(input, "baseUrl");
    const result = await withWriteCoordination(
      {
        root,
        operation: "job.static_export",
        ...(actorId === undefined ? {} : { actorId }),
        metadata: {
          ...(outDir === undefined ? {} : { out_dir: outDir }),
          ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
        },
      },
      () =>
        exportStaticSite({
          root,
          ...(outDir === undefined ? {} : { outDir }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
        }),
    );
    return {
      out_dir: result.outDir,
      file_count: result.files.length,
      files: result.files,
    };
  }

  if (runType === "lint") {
    return validateRepository(root);
  }

  if (runType === "source.fetch") {
    const result = await fetchAndIngestSource({
      root,
      title: requiredString(input, "title"),
      ...(actorId === undefined ? {} : { actorId }),
      ...optionalStringProperty(input, "url", "url"),
      ...optionalStringProperty(input, "source_type", "sourceType"),
      ...optionalNumberProperty(input, "max_bytes", "maxBytes"),
      ...optionalNumberProperty(input, "timeout_ms", "timeoutMs"),
      ...optionalConnectorKindProperty(input, "connector_kind", "connectorKind"),
      ...optionalStringProperty(input, "connector_id", "connectorId"),
      ...optionalStringProperty(input, "credential_ref", "credentialRef"),
      ...optionalStringProperty(input, "github_owner", "githubOwner"),
      ...optionalStringProperty(input, "github_repo", "githubRepo"),
      ...optionalStringProperty(input, "gitlab_project", "gitlabProject"),
      ...optionalStringProperty(input, "source_path", "sourcePath"),
      ...optionalStringProperty(input, "ref", "ref"),
    });
    return {
      source_id: result.source.id,
      manifest_path: result.manifest_path,
      ...(result.raw_path === undefined ? {} : { raw_path: result.raw_path }),
      ...(result.object_path === undefined ? {} : { object_path: result.object_path }),
      fetch: result.fetch,
    };
  }

  if (runType === "git.sync") {
    const result = await syncWorkspaceNow({
      root,
      ...(actorId === undefined ? {} : { actorId }),
      pull: optionalBoolean(input, "pull") ?? true,
      push: optionalBoolean(input, "push") ?? true,
      ...optionalStringProperty(input, "remote", "remote"),
      ...optionalStringProperty(input, "branch", "branch"),
      ...optionalStringProperty(input, "trigger_event", "triggerEvent"),
      ...optionalStringProperty(input, "trigger_record_id", "triggerRecordId"),
    });
    if (result.status === "failed") {
      throw new Error(result.error ?? "git.sync failed");
    }
    return syncRunOutput(result);
  }

  if (runType === "backup.create") {
    const outDir = optionalString(input, "out_dir") ?? optionalString(input, "outDir");
    const destinationId = optionalString(input, "destination_id") ?? optionalString(input, "destinationId");
    const includeGit = optionalBoolean(input, "include_git") ?? optionalBoolean(input, "includeGit");
    const backup = await withWriteCoordination(
      {
        root,
        operation: "job.backup_create",
        ...(actorId === undefined ? {} : { actorId }),
        metadata: {
          ...(outDir === undefined ? {} : { out_dir: outDir }),
          ...(destinationId === undefined ? {} : { destination_id: destinationId }),
          ...(includeGit === undefined ? {} : { include_git: includeGit }),
        },
      },
      () =>
        createWorkspaceBackup({
          root,
          ...(actorId === undefined ? {} : { actorId }),
          ...(outDir === undefined ? {} : { outDir }),
          ...(destinationId === undefined ? {} : { destinationId }),
          ...(includeGit === undefined ? {} : { includeGit }),
        }),
    );
    return {
      backup_id: backup.backup_id,
      backup_dir: backup.backup_dir,
      manifest_path: backup.manifest_path,
      checksums_path: backup.checksums_path,
      restore_readme_path: backup.restore_readme_path,
      file_count: backup.manifest.file_count,
      byte_count: backup.manifest.byte_count,
      warnings: backup.manifest.warnings,
    };
  }

  if (runType === "inbox.process") {
    const id = optionalString(input, "id") ?? optionalString(input, "inbox_item_id");
    if (id === undefined || !id.trim()) {
      throw new Error("Expected inbox.process job input field 'id' or 'inbox_item_id'");
    }
    const result = await processInboxItem({
      root,
      id,
      ...(actorId === undefined ? {} : { actorId }),
      ...(runId === undefined ? {} : { runId }),
      dryRun: optionalBoolean(input, "dry_run") === true,
      force: optionalBoolean(input, "force") === true,
      ...optionalInboxFailureProperty(input, "fake_provider_failure", "fakeProviderFailure"),
    });
    if (result.failure !== undefined) {
      throw new Error(`${result.failure.category}: ${result.failure.message}`);
    }
    return {
      inbox_item_id: result.item.id,
      status: result.item.status,
      idempotent: result.idempotent === true,
      source_ids: result.item.source_ids ?? [],
      proposal_ids: result.item.proposal_ids ?? [],
      page_ids: result.item.page_ids ?? [],
    };
  }

  if (runType === "inbox.watch") {
    const result = await watchInboxOnce({
      root,
      dir: requiredString(input, "dir"),
      ...optionalInboxWatchAdapterProperty(input, "adapter", "adapter"),
      ...optionalStringProperty(input, "provider", "provider"),
      ...optionalStringProperty(input, "inbox_kind", "inboxKind"),
      ...optionalStringProperty(input, "owner_actor_id", "ownerActorId"),
      ...optionalStringProperty(input, "target_space_id", "targetSpaceId"),
      ...optionalNumberProperty(input, "max_bytes", "maxBytes"),
      ...optionalStringProperty(input, "archive_dir", "archiveDir"),
      ...optionalStringProperty(input, "quarantine_dir", "quarantineDir"),
    });
    return {
      scanned: result.scanned,
      submitted: result.submitted,
      duplicates: result.duplicates,
      skipped: result.skipped,
      failed: result.failed,
      inbox_item_ids: result.items.map((item) => item.id),
      errors: result.errors,
    };
  }

  if (runType === "inbox.reconcile") {
    const statuses = inboxStatusesInput(input.statuses);
    const result = await listInboxWorkflow({
      root,
      ...(statuses === undefined ? {} : { statuses }),
      ...optionalStringProperty(input, "owner_actor_id", "ownerActorId"),
      ...optionalStringProperty(input, "provider", "provider"),
      ...optionalStringProperty(input, "inbox_kind", "inboxKind"),
      ...optionalStringProperty(input, "target_space_id", "targetSpaceId"),
      ...optionalNumberProperty(input, "limit", "limit"),
    });
    const retryable = result.items.filter((item) => item.status === "failed" && item.processing?.retryable === true).length;
    return {
      total: result.total,
      returned: result.items.length,
      retryable,
      received: result.items.filter((item) => item.status === "received").length,
      failed: result.items.filter((item) => item.status === "failed").length,
      inbox_item_ids: result.items.map((item) => item.id),
    };
  }

  if (runType === "inbox.sync_after_process") {
    const result = await syncWorkspaceNow({
      root,
      ...(actorId === undefined ? {} : { actorId }),
      pull: true,
      push: true,
      triggerEvent: "inbox.processed",
    });
    if (result.status === "failed") {
      throw new Error(result.error ?? "inbox.sync_after_process failed");
    }
    return syncRunOutput(result);
  }

  if (runType === "dream.run") {
    return runDreamCycle({
      root,
      ...(actorId === undefined ? {} : { actorId }),
      ...(runId === undefined ? {} : { runId }),
      ...dreamRunInputFromRecord(input),
      ...(policyContext === undefined ? {} : { policyContext }),
    });
  }

  throw new Error(`Unsupported OpenWiki run type: ${runType}`);
}
