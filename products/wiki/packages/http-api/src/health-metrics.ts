import {
  openWikiRuntimeModeFromEnvOrProfile,
  openWikiRuntimeModeRequiresHostedStores,
  openWikiGitArgs,
  openWikiGitEnv,
  type EventRecord,
  type OpenWikiConfig,
  type OpenWikiQueueBackend,
  type OpenWikiRuntimeMode,
  type RunRecord,
  type SearchResponse,
} from "@openwiki/core";
import { gitRemoteStatus } from "@openwiki/git";
import { checkIndexStoreIntegrity } from "@openwiki/index-store";
import { checkPostgresRuntimeServingHealth, checkPostgresRuntimeServingHealthForWorkspace, postgresRuntimeConfigured, postgresRuntimeHealthEnabled, postgresRuntimeReadEnabled, postgresRuntimeSearchEnabled, readPostgresRuntimeQueueHealth, readPostgresRuntimeQueueHealthForWorkspace, readPostgresWriteLease, readPostgresWriteLeaseForWorkspace } from "@openwiki/postgres-runtime";
import { loadRepository, readConfig } from "@openwiki/repo";
import { checkContentStoreHealth } from "@openwiki/storage";
import { inboxMetricsSnapshot, sourceFetchMetricsSnapshot, writeCoordinationMetricsSnapshot } from "@openwiki/workflows";
import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunStatus } from "./misc.ts";
import { httpRequestCounters, httpRequestDurationMetrics, LATENCY_BUCKET_SECONDS, mcpToolCounters, mcpToolDurationMetrics, operationalStateBackendFromEnvOrConfig, rateLimitRejectionCounters, rateLimitSettings, searchLatencyMetrics, type HistogramMetric } from "./operational.ts";
import { isObject } from "./route-utils.ts";

const execFile = promisify(execFileCallback);

export async function health(root: string): Promise<unknown> {
  try {
    const config = await readConfig(root);
    const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(process.env, config.runtime?.profile);
    const hostedStoresRequired = openWikiRuntimeModeRequiresHostedStores(runtimeMode);
    if (hostedStoresRequired) {
      return await hostedHealth(root, config, runtimeMode);
    }
    const repo = await loadRepository(root);
    const postgresHealthEnabled = postgresRuntimeHealthEnabled();
    const usePostgresRead = postgresRuntimeReadEnabled();
    const usePostgresSearch = postgresRuntimeSearchEnabled();
    const checkLocalIndexStore = !usePostgresRead;
    const checkLocalSearch = !usePostgresSearch;
    const [gitWorkspace, indexStore, postgresRuntime, postgresQueue, postgresWriteLease, objectStorage, searchIndex, configSafety] = await Promise.all([
      gitWorkspaceHealth(root, repo.config.workspace_id),
      checkLocalIndexStore
        ? checkIndexStoreIntegrity(root).catch((error: unknown) => ({
            ok: false,
            issues: [error instanceof Error ? error.message : String(error)],
          }))
        : Promise.resolve({ ok: true, status: "skipped", backend: "postgres", issues: [] }),
      postgresHealthEnabled
        ? checkPostgresRuntimeServingHealth(root).catch((error: unknown) => ({
            enabled: true,
            ok: false,
            issues: [error instanceof Error ? error.message : String(error)],
          }))
        : Promise.resolve({ enabled: false, ok: true, issues: [] }),
      postgresHealthEnabled
        ? readPostgresRuntimeQueueHealth(root, { pooled: true }).catch((error: unknown) => ({
            source: "postgres-runtime",
            backend: "postgres",
            enabled: true,
            ok: false,
            issues: [error instanceof Error ? error.message : String(error)],
          }))
        : Promise.resolve({ enabled: false, backend: "local" }),
      postgresHealthEnabled
        ? readPostgresWriteLease(root, { pooled: true }).catch((error: unknown) => ({
            source: "postgres-runtime",
            enabled: true,
            ok: false,
            issues: [error instanceof Error ? error.message : String(error)],
          }))
        : Promise.resolve({ enabled: false }),
      checkContentStoreHealth(root, repo.config.runtime?.storage),
      checkLocalSearch ? localSearchIndexHealth(root) : Promise.resolve({ status: "skipped", backend: "postgres", issues: [] }),
      configSafetyHealth(root, repo.config.runtime?.profile),
    ]);
    const indexStoreComponent = indexStore as { ok?: boolean };
    const postgresComponent = postgresRuntime as { enabled?: boolean; ok?: boolean };
    const objectStorageComponent = objectStorage as { status?: string };
    const searchIndexComponent = searchIndex as { status?: string };
    const configSafetyComponent = configSafety as { status?: string };
    const runtimeModeComponent = runtimeModeHealth(repo.config, runtimeMode, postgresComponent);
    return {
      status:
        componentHealthMetric(gitWorkspace) !== 1 ||
        !indexStoreComponent.ok ||
        (postgresComponent.enabled && !postgresComponent.ok) ||
        objectStorageComponent.status === "degraded" ||
        objectStorageComponent.status === "unsupported" ||
        (searchIndexComponent.status !== "ok" && searchIndexComponent.status !== "skipped") ||
        configSafetyComponent.status === "degraded" ||
        runtimeModeComponent.status === "degraded"
          ? "degraded"
          : "ok",
      protocol_version: repo.config.protocol_version,
      workspace_id: repo.config.workspace_id,
      counts: {
        pages: repo.pages.length,
        sources: repo.sources.length,
        claims: repo.claims.length,
        proposals: repo.proposals.length,
        decisions: repo.decisions.length,
        events: repo.events.length,
        runs: repo.runs.length,
      },
      components: {
        git: gitWorkspace,
        index_store: indexStore,
        postgres_runtime: postgresRuntime,
        queue: postgresQueue,
        write_lease: postgresWriteLease ?? { source: "postgres-runtime", enabled: true, active: false },
        object_storage: objectStorage,
        search_index: searchIndex,
        config_safety: configSafety,
        runtime_mode: runtimeModeComponent,
      },
    };
  } catch (error) {
    return {
      status: "degraded",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function warmHostedHealth(root: string): Promise<void> {
  try {
    const config = await readConfig(root);
    const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(process.env, config.runtime?.profile);
    if (!openWikiRuntimeModeRequiresHostedStores(runtimeMode) || !postgresRuntimeConfigured()) {
      return;
    }
    await hostedHealth(root, config, runtimeMode);
  } catch {
    // Readiness reports the actionable failure; startup warming should not fail the server.
  }
}

async function hostedHealth(root: string, config: OpenWikiConfig, runtimeMode: OpenWikiRuntimeMode): Promise<unknown> {
  const [gitWorkspace, indexStore, postgresRuntime, postgresQueue, postgresWriteLease, objectStorage, searchIndex, configSafety] = await Promise.all([
    gitWorkspaceServingHealth(root, config.workspace_id),
    Promise.resolve({ ok: true, status: "skipped", backend: "postgres", issues: [] }),
    checkPostgresRuntimeServingHealthForWorkspace(root, config.workspace_id, { pooled: true }).catch((error: unknown) => ({
      enabled: true,
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    })),
    readPostgresRuntimeQueueHealthForWorkspace(config.workspace_id, { pooled: true }).catch((error: unknown) => ({
      source: "postgres-runtime",
      backend: "postgres",
      enabled: true,
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    })),
    readPostgresWriteLeaseForWorkspace(config.workspace_id, { pooled: true }).catch((error: unknown) => ({
      source: "postgres-runtime",
      enabled: true,
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    })),
    checkContentStoreHealth(root, config.runtime?.storage),
    Promise.resolve({ status: "skipped", backend: "postgres", issues: [] }),
    configSafetyHealth(root, config.runtime?.profile),
  ]);
  const indexStoreComponent = indexStore as { ok?: boolean };
  const postgresComponent = postgresRuntime as { enabled?: boolean; ok?: boolean };
  const objectStorageComponent = objectStorage as { status?: string };
  const searchIndexComponent = searchIndex as { status?: string };
  const configSafetyComponent = configSafety as { status?: string };
  const runtimeModeComponent = runtimeModeHealth(config, runtimeMode, postgresComponent);
  const writeLeaseComponent = postgresWriteLease ?? { source: "postgres-runtime", enabled: true, active: false };
  return {
    status:
      componentHealthMetric(gitWorkspace) !== 1 ||
      !indexStoreComponent.ok ||
      (postgresComponent.enabled && !postgresComponent.ok) ||
      componentHealthMetric(postgresQueue) !== 1 ||
      componentHealthMetric(writeLeaseComponent) !== 1 ||
      objectStorageComponent.status === "degraded" ||
      objectStorageComponent.status === "unsupported" ||
      (searchIndexComponent.status !== "ok" && searchIndexComponent.status !== "skipped") ||
      configSafetyComponent.status === "degraded" ||
      runtimeModeComponent.status === "degraded"
        ? "degraded"
        : "ok",
    protocol_version: config.protocol_version,
    workspace_id: config.workspace_id,
    counts: hostedCounts(postgresRuntime),
    components: {
      git: gitWorkspace,
      index_store: indexStore,
      postgres_runtime: postgresRuntime,
      queue: postgresQueue,
      write_lease: writeLeaseComponent,
      object_storage: objectStorage,
      search_index: searchIndex,
      config_safety: configSafety,
      runtime_mode: runtimeModeComponent,
    },
  };
}

function hostedCounts(postgresRuntime: unknown): Record<string, number> {
  const recordCount = isObject(postgresRuntime) ? metricNumber(postgresRuntime.record_count) : 0;
  return {
    pages: 0,
    sources: 0,
    claims: 0,
    proposals: 0,
    decisions: 0,
    events: 0,
    runs: 0,
    records: recordCount,
  };
}

function runtimeModeHealth(
  config: OpenWikiConfig,
  mode: OpenWikiRuntimeMode,
  postgresRuntime: { enabled?: boolean; ok?: boolean },
): Record<string, unknown> {
  const queueBackend = runtimeQueueBackend(config);
  const operationalBackend = operationalStateBackendFromEnvOrConfig(config.runtime?.controls?.operational_state?.backend);
  const issues: string[] = [];
  const hostedStoresRequired = openWikiRuntimeModeRequiresHostedStores(mode);
  if (hostedStoresRequired) {
    if (!postgresRuntimeConfigured()) {
      issues.push("hosted runtime mode requires OPENWIKI_DATABASE_URL or DATABASE_URL");
    }
    if (!postgresRuntimeReadEnabled()) {
      issues.push("hosted runtime mode requires OPENWIKI_READ_BACKEND=postgres or OPENWIKI_RUNTIME_BACKEND=postgres");
    }
    if (!postgresRuntimeSearchEnabled()) {
      issues.push("hosted runtime mode requires OPENWIKI_SEARCH_BACKEND=postgres or OPENWIKI_RUNTIME_BACKEND=postgres");
    }
    if (queueBackend !== "postgres") {
      issues.push("hosted runtime mode requires OPENWIKI_QUEUE_BACKEND=postgres or runtime.queue.backend=postgres");
    }
    if (operationalBackend !== "postgres") {
      issues.push("hosted runtime mode requires OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres or runtime.controls.operational_state.backend=postgres");
    }
    if (postgresRuntime.enabled === true && postgresRuntime.ok !== true) {
      issues.push("hosted runtime mode requires a current Postgres runtime sync");
    }
  }
  return {
    status: issues.length === 0 ? "ok" : "degraded",
    mode,
    profile: config.runtime?.profile ?? "local",
    postgres_configured: postgresRuntimeConfigured(),
    read_backend: postgresRuntimeReadEnabled() ? "postgres" : "local",
    search_backend: postgresRuntimeSearchEnabled() ? "postgres" : "sqlite",
    queue_backend: queueBackend,
    operational_state_backend: operationalBackend,
    issues,
  };
}

function runtimeQueueBackend(config: OpenWikiConfig): OpenWikiQueueBackend {
  const value = process.env.OPENWIKI_QUEUE_BACKEND?.trim() || config.runtime?.queue?.backend || "local";
  if (value === "local" || value === "postgres") {
    return value;
  }
  return "local";
}

interface HealthSnapshot {
  status?: string;
  workspace_id?: string;
  protocol_version?: string;
  counts?: Record<string, number>;
  components?: Record<string, unknown>;
  error?: string;
}

export async function readiness(root: string): Promise<{ status: "ready" | "not_ready"; checked_at: string; health: HealthSnapshot }> {
  const snapshot = (await health(root)) as HealthSnapshot;
  return {
    status: snapshot.status === "ok" ? "ready" : "not_ready",
    checked_at: new Date().toISOString(),
    health: snapshot,
  };
}

export async function metricsText(root: string): Promise<string> {
  const snapshot = (await health(root)) as HealthSnapshot;
  const workspaceId = snapshot.workspace_id ?? "unknown";
  const labels = `workspace_id="${metricLabel(workspaceId)}"`;
  const lines = [
    "# HELP openwiki_up Whether the OpenWiki process can answer the metrics request.",
    "# TYPE openwiki_up gauge",
    "openwiki_up 1",
    "# HELP openwiki_ready Whether OpenWiki reports all readiness dependencies as healthy.",
    "# TYPE openwiki_ready gauge",
    `openwiki_ready{${labels}} ${snapshot.status === "ok" ? 1 : 0}`,
    "# HELP openwiki_workspace_records Number of canonical records currently loaded from the workspace.",
    "# TYPE openwiki_workspace_records gauge",
  ];

  for (const [recordType, count] of Object.entries(snapshot.counts ?? {})) {
    lines.push(`openwiki_workspace_records{${labels},record_type="${metricLabel(recordType)}"} ${metricNumber(count)}`);
  }

  lines.push(
    "# HELP openwiki_component_ok Whether a runtime dependency reports healthy.",
    "# TYPE openwiki_component_ok gauge",
  );
  for (const [componentName, component] of Object.entries(snapshot.components ?? {})) {
    lines.push(
      `openwiki_component_ok{${labels},component="${metricLabel(componentName)}"} ${componentHealthMetric(component)}`,
    );
  }

  const queue = snapshot.components?.queue;
  const needsRunScan = !(isObject(queue) && isObject(queue.runs) && isObject(queue.jobs));
  const repo = needsRunScan || !isObject(queue) ? await loadRepository(root).catch(() => undefined) : undefined;
  const repoRuns = repo?.runs ?? [];
  const queueRuns = isObject(queue) && isObject(queue.runs) ? queue.runs : queueStatusCounts(repoRuns);
  lines.push("# HELP openwiki_queue_runs Number of runs by queue status.");
  lines.push("# TYPE openwiki_queue_runs gauge");
  for (const [status, count] of Object.entries(queueRuns)) {
    lines.push(`openwiki_queue_runs{${labels},status="${metricLabel(status)}"} ${metricNumber(count)}`);
  }
  const queueJobs = isObject(queue) && isObject(queue.jobs) ? queue.jobs : queueStatusCounts(repoRuns);
  lines.push("# HELP openwiki_queue_jobs Number of jobs by queue status.");
  lines.push("# TYPE openwiki_queue_jobs gauge");
  for (const [status, count] of Object.entries(queueJobs)) {
    lines.push(`openwiki_queue_jobs{${labels},status="${metricLabel(status)}"} ${metricNumber(count)}`);
  }
  if (isObject(queue) && "stale_running_jobs" in queue) {
    lines.push("# HELP openwiki_queue_stale_running_jobs Number of Postgres jobs running longer than the stale runtime threshold.");
    lines.push("# TYPE openwiki_queue_stale_running_jobs gauge");
    lines.push(`openwiki_queue_stale_running_jobs{${labels}} ${metricNumber(queue.stale_running_jobs)}`);
  }
  const writeLease = snapshot.components?.write_lease;
  lines.push("# HELP openwiki_write_lease_active Whether a Postgres write lease is currently active.");
  lines.push("# TYPE openwiki_write_lease_active gauge");
  lines.push(`openwiki_write_lease_active{${labels}} ${isObject(writeLease) && typeof writeLease.lock_name === "string" ? 1 : 0}`);

  appendOperationalMetrics(lines, labels, repo);

  if (snapshot.error) {
    lines.push("# HELP openwiki_health_error_present Whether the last health check returned an error.");
    lines.push("# TYPE openwiki_health_error_present gauge");
    lines.push(`openwiki_health_error_present{${labels}} 1`);
  }

  return `${lines.join("\n")}\n`;
}

function appendOperationalMetrics(lines: string[], labels: string, repo: Awaited<ReturnType<typeof loadRepository>> | undefined): void {
  lines.push("# HELP openwiki_http_requests_total HTTP requests by normalized route, operation, and status.");
  lines.push("# TYPE openwiki_http_requests_total counter");
  for (const [key, count] of httpRequestCounters) {
    const [route = "unknown", operation = "unknown", status = "0"] = key.split("|");
    lines.push(`openwiki_http_requests_total{${labels},route="${metricLabel(route)}",operation="${metricLabel(operation)}",status="${metricLabel(status)}"} ${metricNumber(count)}`);
  }
  appendHistogramMetrics(lines, {
    name: "openwiki_http_request_duration_seconds",
    help: "HTTP request latency by normalized route, operation, and status.",
    labels,
    map: httpRequestDurationMetrics,
    labelNames: ["route", "operation", "status"],
  });

  lines.push("# HELP openwiki_mcp_tool_calls_total HTTP MCP tool calls by tool, mode, and status.");
  lines.push("# TYPE openwiki_mcp_tool_calls_total counter");
  for (const [key, count] of mcpToolCounters) {
    const [tool = "unknown", mode = "unknown", status = "unknown"] = key.split("|");
    lines.push(`openwiki_mcp_tool_calls_total{${labels},tool="${metricLabel(tool)}",mode="${metricLabel(mode)}",status="${metricLabel(status)}"} ${metricNumber(count)}`);
  }
  appendHistogramMetrics(lines, {
    name: "openwiki_mcp_tool_duration_seconds",
    help: "MCP tool-call latency by tool, mode, and result status.",
    labels,
    map: mcpToolDurationMetrics,
    labelNames: ["tool", "mode", "status"],
  });

  lines.push("# HELP openwiki_rate_limit_rejections_total Rate-limit rejections by normalized route, operation, and dimension.");
  lines.push("# TYPE openwiki_rate_limit_rejections_total counter");
  for (const [key, count] of rateLimitRejectionCounters) {
    const [route = "unknown", operation = "unknown", dimension = "unknown"] = key.split("|");
    lines.push(`openwiki_rate_limit_rejections_total{${labels},route="${metricLabel(route)}",operation="${metricLabel(operation)}",dimension="${metricLabel(dimension)}"} ${metricNumber(count)}`);
  }

  lines.push("# HELP openwiki_proposal_lifecycle_events_total Proposal lifecycle events recorded in the canonical event log.");
  lines.push("# TYPE openwiki_proposal_lifecycle_events_total counter");
  const lifecycleCounts = proposalLifecycleCounts(repo?.events ?? []);
  for (const [eventType, count] of lifecycleCounts) {
    lines.push(`openwiki_proposal_lifecycle_events_total{${labels},event_type="${metricLabel(eventType)}"} ${metricNumber(count)}`);
  }

  lines.push("# HELP openwiki_write_lock_acquisitions_total Write lock acquisitions by backend, operation, and status.");
  lines.push("# TYPE openwiki_write_lock_acquisitions_total counter");
  const writeMetrics = writeCoordinationMetricsSnapshot();
  for (const metric of writeMetrics.acquisitions) {
    lines.push(`openwiki_write_lock_acquisitions_total{${labels},backend="${metricLabel(metric.backend)}",operation="${metricLabel(metric.operation)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_write_lock_wait_seconds_total Total time spent waiting for write locks.");
  lines.push("# TYPE openwiki_write_lock_wait_seconds_total counter");
  for (const metric of writeMetrics.wait_seconds_total) {
    lines.push(`openwiki_write_lock_wait_seconds_total{${labels},backend="${metricLabel(metric.backend)}",operation="${metricLabel(metric.operation)}"} ${metricNumber(metric.seconds)}`);
  }
  lines.push("# HELP openwiki_write_lock_hold_seconds_total Total time spent holding write locks.");
  lines.push("# TYPE openwiki_write_lock_hold_seconds_total counter");
  for (const metric of writeMetrics.hold_seconds_total) {
    lines.push(`openwiki_write_lock_hold_seconds_total{${labels},backend="${metricLabel(metric.backend)}",operation="${metricLabel(metric.operation)}"} ${metricNumber(metric.seconds)}`);
  }

  lines.push("# HELP openwiki_job_duration_seconds_total Total completed job duration by run type and status.");
  lines.push("# TYPE openwiki_job_duration_seconds_total counter");
  lines.push("# HELP openwiki_job_duration_seconds_count Number of completed jobs contributing to duration totals.");
  lines.push("# TYPE openwiki_job_duration_seconds_count counter");
  for (const metric of jobDurationMetrics(repo?.runs ?? [])) {
    lines.push(`openwiki_job_duration_seconds_total{${labels},run_type="${metricLabel(metric.runType)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.seconds)}`);
    lines.push(`openwiki_job_duration_seconds_count{${labels},run_type="${metricLabel(metric.runType)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }

  appendHistogramMetrics(lines, {
    name: "openwiki_search_duration_seconds",
    help: "Search latency by serving backend, requested mode, and status.",
    labels,
    map: searchLatencyMetrics,
    labelNames: ["backend", "mode", "status"],
  });

  const sourceMetrics = sourceFetchMetricsSnapshot();
  lines.push("# HELP openwiki_source_fetch_attempts_total Source fetch attempts by connector kind and status.");
  lines.push("# TYPE openwiki_source_fetch_attempts_total counter");
  for (const metric of sourceMetrics.attempts) {
    lines.push(`openwiki_source_fetch_attempts_total{${labels},connector_kind="${metricLabel(metric.connector_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_source_fetch_duration_seconds_total Total source fetch duration by connector kind and status.");
  lines.push("# TYPE openwiki_source_fetch_duration_seconds_total counter");
  lines.push("# HELP openwiki_source_fetch_duration_seconds_count Number of source fetch attempts contributing to duration totals.");
  lines.push("# TYPE openwiki_source_fetch_duration_seconds_count counter");
  for (const metric of sourceMetrics.duration_seconds) {
    lines.push(`openwiki_source_fetch_duration_seconds_total{${labels},connector_kind="${metricLabel(metric.connector_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.seconds)}`);
    lines.push(`openwiki_source_fetch_duration_seconds_count{${labels},connector_kind="${metricLabel(metric.connector_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }

  const inboxMetrics = inboxMetricsSnapshot();
  lines.push("# HELP openwiki_inbox_received_total Inbox items received by provider, kind, and status.");
  lines.push("# TYPE openwiki_inbox_received_total counter");
  for (const metric of inboxMetrics.received) {
    lines.push(`openwiki_inbox_received_total{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_inbox_processing_duration_seconds_total Total inbox processing duration by provider, kind, and status.");
  lines.push("# TYPE openwiki_inbox_processing_duration_seconds_total counter");
  lines.push("# HELP openwiki_inbox_processing_duration_seconds_count Number of inbox processing attempts contributing to duration totals.");
  lines.push("# TYPE openwiki_inbox_processing_duration_seconds_count counter");
  for (const metric of inboxMetrics.processing_duration_seconds) {
    lines.push(`openwiki_inbox_processing_duration_seconds_total{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.seconds)}`);
    lines.push(`openwiki_inbox_processing_duration_seconds_count{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_inbox_processing_failures_total Inbox processing failures by provider, kind, and category.");
  lines.push("# TYPE openwiki_inbox_processing_failures_total counter");
  for (const metric of inboxMetrics.failures) {
    lines.push(`openwiki_inbox_processing_failures_total{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",category="${metricLabel(metric.category)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_inbox_duplicates_total Inbox duplicate observations by provider, kind, and stage.");
  lines.push("# TYPE openwiki_inbox_duplicates_total counter");
  for (const metric of inboxMetrics.duplicates) {
    lines.push(`openwiki_inbox_duplicates_total{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",stage="${metricLabel(metric.stage)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_inbox_provider_task_attempts_total Inbox agent/provider task attempts by provider, processor, and status.");
  lines.push("# TYPE openwiki_inbox_provider_task_attempts_total counter");
  for (const metric of inboxMetrics.provider_attempts) {
    lines.push(`openwiki_inbox_provider_task_attempts_total{${labels},provider="${metricLabel(metric.provider)}",processor="${metricLabel(metric.processor)}",status="${metricLabel(metric.status)}"} ${metricNumber(metric.count)}`);
  }
  lines.push("# HELP openwiki_inbox_proposals_per_item_total Inbox processed item counts by resulting proposal count.");
  lines.push("# TYPE openwiki_inbox_proposals_per_item_total counter");
  for (const metric of inboxMetrics.proposal_counts) {
    lines.push(`openwiki_inbox_proposals_per_item_total{${labels},provider="${metricLabel(metric.provider)}",kind="${metricLabel(metric.inbox_kind)}",proposals="${metricLabel(String(metric.proposals))}"} ${metricNumber(metric.count)}`);
  }
}

function appendHistogramMetrics(
  lines: string[],
  input: {
    name: string;
    help: string;
    labels: string;
    map: Map<string, HistogramMetric>;
    labelNames: string[];
  },
): void {
  lines.push(`# HELP ${input.name} ${input.help}`);
  lines.push(`# TYPE ${input.name} histogram`);
  for (const [key, metric] of input.map) {
    const values = key.split("|");
    const variableLabels = input.labelNames
      .map((labelName, index) => `${labelName}="${metricLabel(values[index] ?? "unknown")}"`)
      .join(",");
    const baseLabels = variableLabels ? `${input.labels},${variableLabels}` : input.labels;
    for (const bucket of LATENCY_BUCKET_SECONDS) {
      lines.push(`${input.name}_bucket{${baseLabels},le="${bucket}"} ${metricNumber(metric.buckets.get(bucket) ?? 0)}`);
    }
    lines.push(`${input.name}_bucket{${baseLabels},le="+Inf"} ${metricNumber(metric.count)}`);
    lines.push(`${input.name}_sum{${baseLabels}} ${metricNumber(metric.sumSeconds)}`);
    lines.push(`${input.name}_count{${baseLabels}} ${metricNumber(metric.count)}`);
  }
}

function proposalLifecycleCounts(events: EventRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type.startsWith("proposal.") || event.type === "decision.created") {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    }
  }
  return counts;
}

function jobDurationMetrics(runs: RunRecord[]): Array<{ runType: string; status: string; seconds: number; count: number }> {
  const metrics = new Map<string, { runType: string; status: string; seconds: number; count: number }>();
  for (const run of runs) {
    if (run.started_at === undefined || run.completed_at === undefined) {
      continue;
    }
    const started = Date.parse(run.started_at);
    const completed = Date.parse(run.completed_at);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      continue;
    }
    const key = `${run.run_type}|${run.status}`;
    const current = metrics.get(key) ?? { runType: run.run_type, status: run.status, seconds: 0, count: 0 };
    current.seconds += (completed - started) / 1000;
    current.count += 1;
    metrics.set(key, current);
  }
  return [...metrics.values()];
}

export function searchBackendForMetrics(response: SearchResponse): string {
  if (response.serving_layer !== undefined) {
    return response.serving_layer;
  }
  const diagnostics = response.explain?.diagnostics;
  if (diagnostics !== undefined && typeof diagnostics.backend === "string") {
    return diagnostics.backend;
  }
  return "unknown";
}

function queueStatusCounts(runs: RunRecord[]): Record<RunStatus, number> {
  return {
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
  };
}

async function gitWorkspaceHealth(root: string, workspaceId: string): Promise<Record<string, unknown>> {
  try {
    const status = await gitRemoteStatus(root);
    return {
      status: status.is_git_repo && !status.clean ? "degraded" : "ok",
      workspace_id: workspaceId,
      is_git_repo: status.is_git_repo,
      clean: status.clean,
      branch: status.branch ?? "",
      upstream: status.upstream ?? "",
      ahead: status.ahead,
      behind: status.behind,
      issues: status.is_git_repo && !status.clean ? ["Git workspace has uncommitted changes"] : [],
    };
  } catch (error) {
    return {
      status: "degraded",
      workspace_id: workspaceId,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function gitWorkspaceServingHealth(root: string, workspaceId: string): Promise<Record<string, unknown>> {
  try {
    const insideWorkTree = await gitText(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
    if (insideWorkTree !== "true") {
      return {
        status: "ok",
        workspace_id: workspaceId,
        is_git_repo: false,
        clean: true,
        remote_status: "skipped",
        issues: [],
      };
    }
    const [branch, statusOutput] = await Promise.all([
      gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      gitText(root, ["status", "--porcelain=v1"]),
    ]);
    const changes = statusOutput.split("\n").filter(Boolean);
    return {
      status: changes.length === 0 ? "ok" : "degraded",
      workspace_id: workspaceId,
      is_git_repo: true,
      clean: changes.length === 0,
      branch,
      upstream: "",
      ahead: 0,
      behind: 0,
      remote_status: "skipped",
      issues: changes.length === 0 ? [] : ["Git workspace has uncommitted changes"],
    };
  } catch (error) {
    return {
      status: "degraded",
      workspace_id: workspaceId,
      remote_status: "skipped",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function gitText(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", openWikiGitArgs(undefined, args), {
    cwd: root,
    env: openWikiGitEnv(),
    timeout: 5000,
  });
  return stdout.trim();
}

async function localSearchIndexHealth(root: string): Promise<{ status: "ok" | "missing"; path: string; issues: string[] }> {
  const dbPath = path.join(root, ".openwiki", "index", "openwiki.sqlite");
  try {
    await stat(dbPath);
    return { status: "ok", path: ".openwiki/index/openwiki.sqlite", issues: [] };
  } catch {
    return { status: "missing", path: ".openwiki/index/openwiki.sqlite", issues: ["local search index does not exist; run openwiki index"] };
  }
}

async function configSafetyHealth(root: string, profile: string | undefined): Promise<Record<string, unknown>> {
  const issues: string[] = [];
  const publicOrigin = process.env.OPENWIKI_PUBLIC_ORIGIN?.trim();
  const trustedHeadersEnabled = process.env.OPENWIKI_TRUST_AUTH_HEADERS === "1";
  const trustedProxyEnabled = process.env.OPENWIKI_TRUST_PROXY_ORIGIN === "1";
  const rateLimits = await rateLimitSettings(root);
  if (publicOrigin && !rateLimits.enabled) {
    issues.push("OPENWIKI_PUBLIC_ORIGIN is set but HTTP rate limits are disabled");
  }
  if (trustedHeadersEnabled && !process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET?.trim()) {
    issues.push("trusted auth headers are enabled without OPENWIKI_TRUST_AUTH_HEADERS_SECRET");
  }
  if (trustedProxyEnabled && !process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET?.trim() && !process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET?.trim()) {
    issues.push("trusted proxy origin is enabled without a proxy or auth header secret");
  }
  return {
    status: issues.length === 0 ? "ok" : "degraded",
    profile: profile ?? "local",
    public_origin_configured: Boolean(publicOrigin),
    trusted_auth_headers_enabled: trustedHeadersEnabled,
    trusted_proxy_origin_enabled: trustedProxyEnabled,
    rate_limits_enabled: rateLimits.enabled,
    rate_limit_window_ms: rateLimits.windowMs,
    issues,
  };
}

function metricLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metricNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function componentHealthMetric(component: unknown): 0 | 1 {
  if (!isObject(component)) {
    return 0;
  }
  if (component.enabled === false) {
    return 1;
  }
  if (typeof component.ok === "boolean") {
    return component.ok ? 1 : 0;
  }
  if (typeof component.status === "string") {
    return component.status === "ok" || component.status === "skipped" ? 1 : 0;
  }
  if (Array.isArray(component.issues)) {
    return component.issues.length === 0 ? 1 : 0;
  }
  return 1;
}
