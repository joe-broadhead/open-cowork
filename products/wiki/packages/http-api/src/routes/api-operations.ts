import { boundedNumberQuery, objectBody, optionalBooleanBody, optionalBooleanProperty, optionalNumberProperty, optionalObjectProperty, optionalPolicyActor, optionalRequestActor, optionalStringArrayProperty, optionalStringProperty, runStatusesQuery, stringBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import { OpenWikiPolicyDeniedError, filterRunsByStatuses, redactOpenWikiRunRecord } from "@openwiki/core";
import { configureGitRemote, gitPull, gitPush, gitRemoteStatus } from "@openwiki/git";
import { createRun, runLocalJob } from "@openwiki/jobs";
import { inboxProcessRunInputId, runJobAllowedFromHttp, runJobAuthorizationOperations, runJobAuthorizationSpec, runJobRequiresInboxItem } from "@openwiki/policy";
import { listCurrentPostgresOpenQuestions, listCurrentPostgresTopics } from "@openwiki/postgres-runtime";
import { listOpenQuestions, listTopics } from "@openwiki/repo";
import { publishStaticSite } from "@openwiki/static-export";
import { validateRepository } from "@openwiki/validation";
import { commitChanges, dreamRunStatus, syncWorkspaceNow, withWriteCoordination } from "@openwiki/workflows";
import { authorizeHttp, authorizeHttpPath, badRequest, httpCanSeeUnfilteredIndex, httpPolicyContext, httpRouteErrorMessage, policyDeniedHttpResult } from "../auth.ts";
import { HTTP_RUN_LIMIT_MAX } from "../constants.ts";
import { authorizeHttpInboxProcess, filterOpenQuestionsByPolicy, filterTopicsByPolicy, governanceDetectorReport, listVisibleRuns, runDetail, runMonitor } from "../data-access.ts";
import { auditExport, eventPage, eventStreamEvents, eventStreamHeaders, renderEventStream } from "../events.ts";
import { pathId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";
import { receiveWebhook, webhookProviderFromPath, webhookRunType } from "../webhooks.ts";

const SOURCE_FETCH_AUTH_PATHS = ["sources/manifests", "sources/raw"] as const;

export async function routeApiOperationsRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/api/v1/git/status") {
    const auth = authorizeHttp("wiki.git_status", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await gitRemoteStatus(root) };
  }

  if (method === "POST" && url.pathname === "/api/v1/git/configure") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    const params = body === undefined ? {} : objectBody(body);
    return {
      status: 200,
      body: await withWriteCoordination(
        {
          root,
          operation: "wiki.admin",
          ...optionalPolicyActor(policy),
          metadata: {
            action: "git.configure",
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
          },
        },
        () =>
          configureGitRemote(root, {
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
            ...optionalStringProperty(params, "remote_url", "remote_url"),
            ...optionalStringProperty(params, "credential_ref", "credential_ref"),
          }),
      ),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/git/pull") {
    const auth = authorizeHttp("wiki.git_pull", policy);
    if (auth) {
      return auth;
    }
    const params = body === undefined ? {} : objectBody(body);
    return {
      status: 200,
      body: await withWriteCoordination(
        {
          root,
          operation: "wiki.git_pull",
          ...optionalPolicyActor(policy),
          metadata: {
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
          },
        },
        () =>
          gitPull(root, {
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
          }),
      ),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/git/push") {
    const auth = authorizeHttp("wiki.git_push", policy);
    if (auth) {
      return auth;
    }
    const params = body === undefined ? {} : objectBody(body);
    return {
      status: 200,
      body: await withWriteCoordination(
        {
          root,
          operation: "wiki.git_push",
          ...optionalPolicyActor(policy),
          metadata: {
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
          },
        },
        () =>
          gitPush(root, {
            ...optionalStringProperty(params, "remote", "remote"),
            ...optionalStringProperty(params, "branch", "branch"),
          }),
      ),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/sync/now") {
    const auth = authorizeHttp("wiki.sync_now", policy);
    if (auth) {
      return auth;
    }
    const params = body === undefined ? {} : objectBody(body);
    return {
      status: 200,
      body: await syncWorkspaceNow({
        root,
        ...optionalPolicyActor(policy),
        pull: optionalBooleanBody(params, "pull") ?? true,
        push: optionalBooleanBody(params, "push") ?? true,
        ...optionalStringProperty(params, "remote", "remote"),
        ...optionalStringProperty(params, "branch", "branch"),
      }),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/events") {
    const auth = authorizeHttp("wiki.list_events", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await eventPage(root, url, policy) };
  }

  if (method === "GET" && url.pathname === "/api/v1/audit/export") {
    const auth = authorizeHttp("wiki.list_events", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await auditExport(root, url, policy) };
  }

  if (method === "GET" && url.pathname === "/api/v1/events/stream") {
    const auth = authorizeHttp("wiki.list_events", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: renderEventStream(await eventStreamEvents(root, url, policy)),
      contentType: "text/event-stream; charset=utf-8",
      headers: eventStreamHeaders(),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/runs") {
    const auth = authorizeHttp("wiki.list_runs", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 50, 1, HTTP_RUN_LIMIT_MAX);
    const statuses = runStatusesQuery(url);
    const result = await listVisibleRuns(root, policy, limit, {
      ...(statuses === undefined ? {} : { statuses }),
    });
    return { status: 200, body: { runs: filterRunsByStatuses(result.runs, statuses), source: result.source } };
  }

  if (method === "GET" && url.pathname === "/api/v1/runs/monitor") {
    const auth = authorizeHttp("wiki.list_runs", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await runMonitor(root, url, policy) };
  }

  if (method === "GET" && url.pathname === "/api/v1/dream/runs") {
    const auth = authorizeHttp("wiki.dream_status", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: await dreamRunStatus(root, {
        limit: boundedNumberQuery(url, "limit", HTTP_RUN_LIMIT_MAX, 1, HTTP_RUN_LIMIT_MAX),
        policyContext: httpPolicyContext(policy),
        includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy),
      }),
    };
  }

  const dreamRunId = pathId(url.pathname, "/api/v1/dream/runs/");
  if (method === "GET" && dreamRunId) {
    const auth = authorizeHttp("wiki.dream_status", policy);
    if (auth) {
      return auth;
    }
    const detail = await dreamRunStatus(root, {
      runId: dreamRunId,
      limit: 1,
      policyContext: httpPolicyContext(policy),
      includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy),
    });
    return detail.run === undefined ? { status: 404, body: { error: { message: `Dream run not found: ${dreamRunId}` } } } : { status: 200, body: detail };
  }

  if (method === "POST" && url.pathname === "/api/v1/dream/runs") {
    const auth = authorizeHttp("wiki.dream_run", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const createProposals = optionalBooleanBody(params, "create_proposals") === true;
    const wait = optionalBooleanBody(params, "wait") === true;
    if (createProposals) {
      const proposeAuth = authorizeHttp("wiki.propose_edit", policy);
      if (proposeAuth) {
        return proposeAuth;
      }
    }
    if (!wait) {
      return badRequest("OpenWiki dream runs require wait=true so caller visibility can be enforced before storing run output");
    }
    const runInput = {
      root,
      runType: "dream.run",
      ...optionalRequestActor(policy, params),
      input: dreamRunInputFromHttp(params),
      ...(wait ? { policyContext: httpPolicyContext(policy) } : {}),
    };
    if (wait) {
      const result = await runLocalJob(runInput);
      return {
        status: 201,
        body: { ...result, run: redactOpenWikiRunRecord(result.run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
      };
    }
    const result = await runLocalJob(runInput);
    return {
      status: 201,
      body: { ...result, run: redactOpenWikiRunRecord(result.run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
    };
  }

  const runId = pathId(url.pathname, "/api/v1/runs/");
  if (method === "GET" && runId) {
    const auth = authorizeHttp("wiki.list_runs", policy);
    if (auth) {
      return auth;
    }
    const detail = await runDetail(root, runId, policy);
    return detail === undefined ? { status: 404, body: { error: { message: `Run not found: ${runId}` } } } : { status: 200, body: detail };
  }

  if (method === "POST" && url.pathname === "/api/v1/runs") {
    const params = objectBody(body);
    const runInput = {
      root,
      runType: stringBody(params, "run_type"),
      ...optionalRequestActor(policy, params),
      ...optionalObjectProperty(params, "input", "input"),
    };
    if (runJobAuthorizationSpec(runInput.runType) === undefined) {
      return { status: 400, body: { error: { code: "bad_request", message: `Unsupported OpenWiki run type: ${runInput.runType}` } } };
    }
    if (!runJobAllowedFromHttp(runInput.runType)) {
      return { status: 403, body: { error: { code: "forbidden", message: `OpenWiki run type '${runInput.runType}' is not available through HTTP` } } };
    }
    for (const operation of runJobAuthorizationOperations(runInput.runType)) {
      const operationAuth = authorizeHttp(operation, policy);
      if (operationAuth) {
        return operationAuth;
      }
    }
    if (runInput.runType === "source.fetch") {
      for (const repoPath of SOURCE_FETCH_AUTH_PATHS) {
        const pathAuth = await authorizeHttpPath(root, "wiki.fetch_source", policy, repoPath);
        if (pathAuth) {
          return pathAuth;
        }
      }
    }
    if (runJobRequiresInboxItem(runInput.runType)) {
      const inboxItemId = inboxProcessRunInputId(runInput.input);
      if (inboxItemId === undefined) {
        return { status: 400, body: { error: { code: "bad_request", message: "inbox.process run input requires id or inbox_item_id" } } };
      }
      const inboxProcessAuth = await authorizeHttpInboxProcess(root, policy, inboxItemId);
      if (inboxProcessAuth) {
        return inboxProcessAuth;
      }
    }
    if (optionalBooleanBody(params, "wait") === true) {
      const result = await runLocalJob(runInput);
      return {
        status: 201,
        body: { ...result, run: redactOpenWikiRunRecord(result.run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
      };
    }
    const run = await createRun(runInput);
    return {
      status: 202,
      body: { run: redactOpenWikiRunRecord(run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/lint") {
    const auth = authorizeHttp("wiki.run_lint", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await validateRepository(root) };
  }

  if (method === "POST" && url.pathname === "/api/v1/publish") {
    const auth = authorizeHttp("wiki.publish", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await withWriteCoordination(
        {
          root,
          operation: "wiki.publish",
          ...optionalRequestActor(policy, params),
          metadata: {
            ...optionalStringProperty(params, "out_dir", "out_dir"),
            ...optionalStringProperty(params, "base_url", "base_url"),
          },
        },
        () =>
          publishStaticSite({
            root,
            ...optionalStringProperty(params, "out_dir", "outDir"),
            ...optionalStringProperty(params, "base_url", "baseUrl"),
            ...optionalRequestActor(policy, params),
          }),
      ),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/commit") {
    const auth = authorizeHttp("wiki.commit_changes", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    try {
      const result = await commitChanges({
        root,
        message: stringBody(params, "message"),
        ...optionalRequestActor(policy, params),
        ...optionalStringArrayProperty(params, "paths", "paths"),
        ...optionalBooleanProperty(params, "all", "all"),
        authorizePaths: async (paths) => {
          for (const repoPath of paths) {
            const pathAuth = await authorizeHttpPath(root, "wiki.commit_changes", policy, repoPath);
            if (pathAuth) {
              throw new OpenWikiPolicyDeniedError(httpRouteErrorMessage(pathAuth));
            }
          }
        },
      });
      return { status: result.committed ? 201 : 200, body: result };
    } catch (error) {
      return policyDeniedHttpResult(error);
    }
  }

  const webhookProvider = webhookProviderFromPath(url.pathname);
  if (method === "POST" && webhookProvider) {
    const params = objectBody(body);
    const enqueue = optionalBooleanBody(params, "enqueue") ?? true;
    if (enqueue) {
      let runType: string;
      try {
        runType = webhookRunType(params);
      } catch (error) {
        return { status: 400, body: { error: { code: "bad_request", message: error instanceof Error ? error.message : String(error) } } };
      }
      if (runJobAuthorizationSpec(runType) === undefined) {
        return { status: 400, body: { error: { code: "bad_request", message: `Unsupported OpenWiki run type: ${runType}` } } };
      }
      if (!runJobAllowedFromHttp(runType)) {
        return { status: 403, body: { error: { code: "forbidden", message: `OpenWiki run type '${runType}' is not available through HTTP` } } };
      }
      for (const operation of runJobAuthorizationOperations(runType)) {
        const operationAuth = authorizeHttp(operation, policy);
        if (operationAuth) {
          return operationAuth;
        }
      }
    } else {
      const auth = authorizeHttp("wiki.run_job", policy);
      if (auth) {
        return auth;
      }
    }
    return receiveWebhook(root, webhookProvider, params, policy, {
      ...(input.context.headers === undefined ? {} : { headers: input.context.headers }),
      ...(input.context.rawBody === undefined ? {} : { rawBody: input.context.rawBody }),
    });
  }

  if (method === "GET" && url.pathname === "/api/v1/topics") {
    const auth = authorizeHttp("wiki.list_topics", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await filterTopicsByPolicy(root, policy, (await listCurrentPostgresTopics(root)) ?? (await listTopics(root))) };
  }

  if (method === "GET" && url.pathname === "/api/v1/open-questions") {
    const auth = authorizeHttp("wiki.list_open_questions", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await filterOpenQuestionsByPolicy(root, policy, (await listCurrentPostgresOpenQuestions(root)) ?? (await listOpenQuestions(root))) };
  }

  if (method === "GET" && url.pathname === "/api/v1/governance/detectors") {
    const auth = authorizeHttp("wiki.detect_governance", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await governanceDetectorReport(root, url, policy) };
  }
  return undefined;
}

function dreamRunInputFromHttp(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...optionalStringArrayProperty(params, "phases", "phases"),
    ...optionalNumberProperty(params, "limit", "limit"),
    ...optionalNumberProperty(params, "timeout_ms", "timeout_ms"),
    ...optionalBooleanProperty(params, "dry_run", "dry_run"),
    ...optionalBooleanProperty(params, "create_proposals", "create_proposals"),
    ...optionalStringProperty(params, "provider", "provider"),
    ...optionalStringProperty(params, "schema_pack", "schema_pack"),
  };
}
