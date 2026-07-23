import { configureGitRemote, diffVersions, getHistory, gitPull, gitPush, gitRemoteStatus } from "@openwiki/git";
import { createRun, runLocalJob } from "@openwiki/jobs";
import { readCurrentIndexStoreGraph, readCurrentIndexStoreWorkspaceRegistry } from "@openwiki/index-store";
import { readCurrentPostgresGraph, readCurrentPostgresRecord, readCurrentPostgresSource, readCurrentPostgresWorkspaceRegistry } from "@openwiki/postgres-runtime";
import { assertAuthorized, inboxProcessRunInputId, runJobAllowedFromMcp, runJobAuthorizationOperations, runJobAuthorizationSpec, runJobRequiresInboxItem } from "@openwiki/policy";
import { listGraphEdges, loadRepository, readClaim, readDecision, readPage, readProposal, readSource, readSourceContent, readWorkspaceRegistry, withRepositoryReadCache } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { publishStaticSite } from "@openwiki/static-export";
import { validateRepository } from "@openwiki/validation";
import { applyProposal, askWithCitations, commitChanges, dreamRunStatus, ignoreInboxItem, processInboxItem, readInboxWorkflow, redactThinkSearchExplainForPolicy, retryInboxItem, syncWorkspaceNow, thinkWithCitations, withWriteCoordination } from "@openwiki/workflows";
import { synthesisTargetPath, writeOpenWikiLog, type ClaimRecord, type DecisionRecord, type PageRecord, type ProposalRecord, type SearchRequest } from "@openwiki/core";
import {
  objectParams,
  stringParam,
  optionalNumberParam,
  boundedOptionalNumberParam,
  optionalBooleanParam,
  optionalStringParam,
  optionalStringArrayParam,
  optionalObjectParam,
  optionalSearchStringArrayParam,
  optionalSearchBooleanParam,
  optionalSearchPersonaParam,
  optionalSearchModeParam,
  optionalSearchFiltersParam,
  optionalStringObjectProperty,
} from "./params.ts";
import { toolResult } from "./tool-output.ts";
import {
  findTrajectoryFromMcp,
  forgetFactFromMcp,
  listFactsFromMcp,
  listTakesFromMcp,
  proposeFactFromMcp,
  proposeTakeFromMcp,
  readFactFromMcp,
  readTakeFromMcp,
  recallFromMcp,
  resolveTakeFromMcp,
  takesScorecardFromMcp,
} from "./memory-tool-handlers.ts";
import {
  toolAllowed,
  openWikiOperation,
  policyContextForMcp,
  filterSearchResponseForMcp,
  assertMcpVisibleRecord,
  assertMcpInboxActionAuthorized,
  assertMcpInboxProcessAuthorized,
  assertMcpInboxSubmitAuthorized,
  assertMcpPathAuthorized,
  assertMcpReviewAuthorized,
} from "./policy-adapter.ts";
import {
  proposeEditFromMcp,
  proposeSynthesisFromMcp,
  createSynthesisFromMcp,
  proposePolicyFromMcp,
  proposeSectionPolicyFromMcp,
  proposeSourceFromMcp,
  reviewProposalFromMcp,
  closeProposalFromMcp,
  commentOnProposalFromMcp,
  ingestSourceFromMcp,
  listProposalsFromMcp,
  listRecentChangesForMcp,
  listEventsForMcp,
  listRunsForMcp,
  listTopicsForMcp,
  listOpenQuestionsForMcp,
  listInboxForMcp,
  submitInboxFromMcp,
  governanceDetectorsForMcp,
  graphNeighborsForMcp,
  graphBacklinksForMcp,
  graphRelatedForMcp,
  graphPathForMcp,
  graphOrphansForMcp,
  graphStaleForMcp,
  graphReportForMcp,
  traceClaimForMcp,
  fetchSourceFromMcp,
} from "./tool-handlers.ts";
import {
  assertMcpPathsAuthorized,
  dreamRunInputFromMcp,
  mcpActorId,
  readProposalDetailForMcp,
  redactRunForMcp,
  redactRunJobResult,
  redactRunToolResponseForMcp,
} from "./tool-router-helpers.ts";
import { MCP_LIST_LIMIT_MAX, type McpServerOptions } from "./types.ts";

const SOURCE_FETCH_AUTH_PATHS = ["sources/manifests", "sources/raw"] as const;

export async function callTool(
  root: string,
  params: Record<string, unknown>,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<unknown> {
  const startedAt = Date.now();
  const toolMode = options.toolMode ?? "read";
  const name = typeof params.name === "string" ? params.name : "unknown";
  writeOpenWikiLog({
    event: "mcp_tool_started",
    actor_id: options.actorId ?? "anonymous",
    metadata: {
      tool: name,
      mode: toolMode,
    },
  });
  try {
    const invokeTool = () => callToolInner(root, params, options);
    const result = toolMode === "read" ? await withRepositoryReadCache(invokeTool) : await invokeTool();
    writeOpenWikiLog({
      event: "mcp_tool_succeeded",
      actor_id: options.actorId ?? "anonymous",
      duration_ms: Date.now() - startedAt,
      metadata: {
        tool: name,
        mode: toolMode,
      },
    });
    return result;
  } catch (error) {
    writeOpenWikiLog({
      event: "mcp_tool_failed",
      level: "error",
      actor_id: options.actorId ?? "anonymous",
      duration_ms: Date.now() - startedAt,
      metadata: {
        tool: name,
        mode: toolMode,
      },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function callToolInner(
  root: string,
  params: Record<string, unknown>,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<unknown> {
  const toolMode = options.toolMode ?? "read";
  const name = stringParam(params, "name");
  if (!toolAllowed(name, toolMode)) {
    throw new Error(`OpenWiki tool '${name}' is not enabled in MCP ${toolMode} mode`);
  }
  const operation = openWikiOperation(name);
  const policyContext = await policyContextForMcp(root, options);
  assertAuthorized(operation, policyContext);
  const args = objectParams(params.arguments);

  switch (name) {
    case "wiki.search": {
      const searchRequest: SearchRequest = {
        query: stringParam(args, "query"),
        include_explain: optionalBooleanParam(args, "include_explain") ?? false,
        include_highlights: optionalBooleanParam(args, "include_highlights") ?? false,
        ...optionalSearchPersonaParam(args),
        ...optionalSearchModeParam(args),
        ...optionalSearchStringArrayParam(args, "types", "types"),
        ...optionalSearchBooleanParam(args, "fuzzy", "fuzzy"),
        ...optionalSearchFiltersParam(args),
      };
      const limit = boundedOptionalNumberParam(args, "limit", 50);
      const offset = boundedOptionalNumberParam(args, "offset", 10000);
      const response = await searchWiki(
        root,
        {
          ...searchRequest,
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        },
        { policyContext },
      );
      return toolResult(await filterSearchResponseForMcp(root, policyContext, response));
    }
    case "wiki.recall":
      return toolResult(await recallFromMcp(root, args, policyContext));
    case "wiki.ask": {
      const askRequest = {
        root,
        question: stringParam(args, "question"),
        includeExplain: optionalBooleanParam(args, "include_explain") ?? false,
      };
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      return toolResult(await askWithCitations(limit === undefined ? { ...askRequest, policyContext } : { ...askRequest, limit, policyContext }));
    }
    case "wiki.think": {
      const thinkRequest = {
        root,
        question: stringParam(args, "question"),
        includeExplain: optionalBooleanParam(args, "include_explain") ?? false,
      };
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      const response = await thinkWithCitations(limit === undefined ? { ...thinkRequest, policyContext } : { ...thinkRequest, limit, policyContext });
      return toolResult(redactThinkSearchExplainForPolicy(response));
    }
    case "wiki.read_page": {
      const id = stringParam(args, "id");
      const page = (await readCurrentPostgresRecord<PageRecord>(root, id, "page")) ?? (await readPage(root, id));
      await assertMcpPathAuthorized(root, "wiki.read_page", policyContext, page.path);
      return toolResult(page);
    }
    case "wiki.read_source": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      if (optionalBooleanParam(args, "include_content") === true) {
        const maxBytes = optionalNumberParam(args, "max_bytes");
        return toolResult(await readSourceContent(root, id, {
          ...(maxBytes === undefined ? {} : { maxBytes }),
          authorizePath: async (repoPath) => {
            await assertMcpPathAuthorized(root, "wiki.read_source", policyContext, repoPath);
          },
        }));
      }
      return toolResult((await readCurrentPostgresSource(root, id)) ?? (await readSource(root, id)));
    }
    case "wiki.read_claim": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      return toolResult((await readCurrentPostgresRecord<ClaimRecord>(root, id, "claim")) ?? (await readClaim(root, id)));
    }
    case "wiki.list_facts":
      return toolResult(await listFactsFromMcp(root, args, policyContext));
    case "wiki.read_fact":
      return toolResult(await readFactFromMcp(root, args, policyContext));
    case "wiki.list_takes":
      return toolResult(await listTakesFromMcp(root, args, policyContext));
    case "wiki.read_take":
      return toolResult(await readTakeFromMcp(root, args, policyContext));
    case "wiki.takes_scorecard":
      return toolResult(await takesScorecardFromMcp(root, policyContext));
    case "wiki.find_trajectory":
      return toolResult(await findTrajectoryFromMcp(root, args, policyContext));
    case "wiki.list_proposals":
      return toolResult(await listProposalsFromMcp(root, args, policyContext));
    case "wiki.read_proposal": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      return toolResult((await readCurrentPostgresRecord<ProposalRecord>(root, id, "proposal")) ?? (await readProposal(root, id)));
    }
    case "wiki.read_proposal_detail": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      return toolResult(await readProposalDetailForMcp(root, id, policyContext));
    }
    case "wiki.read_decision": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      return toolResult((await readCurrentPostgresRecord<DecisionRecord>(root, id, "decision")) ?? (await readDecision(root, id)));
    }
    case "wiki.trace_claim": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      return toolResult(await traceClaimForMcp(root, id, policyContext));
    }
    case "wiki.get_history": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      return toolResult(await getHistory(root, id, limit));
    }
    case "wiki.diff_versions": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      const from = optionalStringParam(args, "from");
      const to = optionalStringParam(args, "to");
      return toolResult(
        await diffVersions({
          root,
          id,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
      );
    }
    case "wiki.list_recent_changes": {
      const limit = boundedOptionalNumberParam(args, "limit", 100);
      return toolResult(await listRecentChangesForMcp(root, limit, policyContext));
    }
    case "wiki.git_status":
      return toolResult(await gitRemoteStatus(root));
    case "wiki.list_events": {
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      return toolResult(await listEventsForMcp(root, limit, policyContext));
    }
    case "wiki.list_runs": {
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      return toolResult(await listRunsForMcp(root, limit, policyContext));
    }
    case "wiki.dream_status": {
      const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
      return toolResult(await dreamRunStatus(root, {
        ...optionalStringObjectProperty(args, "run_id", "runId"),
        ...(limit === undefined ? {} : { limit }),
        policyContext,
        includeSensitiveOperationalMetadata: policyContext.role === "admin" || policyContext.scopes.includes("wiki:admin"),
      }));
    }
    case "wiki.list_topics":
      return toolResult(await listTopicsForMcp(root, policyContext));
    case "wiki.list_open_questions":
      return toolResult(await listOpenQuestionsForMcp(root, policyContext));
    case "wiki.inbox_list":
      return toolResult(await listInboxForMcp(root, args, policyContext));
    case "wiki.inbox_read": {
      const id = stringParam(args, "id");
      await assertMcpVisibleRecord(root, policyContext, id);
      const maxBytes = optionalNumberParam(args, "max_bytes");
      return toolResult(
        await readInboxWorkflow({
          root,
          id,
          includeContent: optionalBooleanParam(args, "include_content") === true,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      );
    }
    case "wiki.detect_governance":
      return toolResult(await governanceDetectorsForMcp(root, args, policyContext));
    case "wiki.graph_neighbors":
      return toolResult(await graphNeighborsForMcp(root, args, policyContext));
    case "wiki.graph_backlinks":
      return toolResult(await graphBacklinksForMcp(root, args, policyContext));
    case "wiki.graph_related":
      return toolResult(await graphRelatedForMcp(root, args, policyContext));
    case "wiki.graph_path":
      return toolResult(await graphPathForMcp(root, args, policyContext));
    case "wiki.graph_orphans":
      return toolResult(await graphOrphansForMcp(root, args, policyContext));
    case "wiki.graph_stale":
      return toolResult(await graphStaleForMcp(root, args, policyContext));
    case "wiki.graph_report": {
      const graph = (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root));
      return toolResult(await graphReportForMcp(root, args, policyContext, graph));
    }
    case "wiki.read_policy": {
      const repo = await loadRepository(root);
      return toolResult({ policy: repo.policy });
    }
    case "wiki.list_workspaces":
      return toolResult({
        registry:
          (await readCurrentPostgresWorkspaceRegistry(root)) ??
          (await readCurrentIndexStoreWorkspaceRegistry(root)) ??
          (await readWorkspaceRegistry(root)),
      });
    case "wiki.connect_workspace": {
      const actorId = mcpActorId(policyContext, args);
      return toolResult({
        connection: await withWriteCoordination(
          {
            root,
            operation: "wiki.connect_workspace",
            ...(actorId === undefined ? {} : { actorId }),
            metadata: {
              ...optionalStringObjectProperty(args, "remote", "remote"),
              ...optionalStringObjectProperty(args, "branch", "branch"),
            },
          },
          () =>
            configureGitRemote(root, {
              ...optionalStringObjectProperty(args, "remote", "remote"),
              ...optionalStringObjectProperty(args, "branch", "branch"),
              ...optionalStringObjectProperty(args, "remote_url", "remote_url"),
              ...optionalStringObjectProperty(args, "credential_ref", "credential_ref"),
            }),
        ),
        registry: await readWorkspaceRegistry(root),
      });
    }
    case "wiki.propose_edit": {
      const page = await readPage(root, stringParam(args, "page_id"));
      await assertMcpPathAuthorized(root, "wiki.propose_edit", policyContext, page.path);
      return toolResult(await proposeEditFromMcp(root, args, mcpActorId(policyContext, args)));
    }
    case "wiki.propose_synthesis":
      await assertMcpPathAuthorized(root, "wiki.propose_synthesis", policyContext, synthesisTargetPath(stringParam(args, "title"), optionalStringParam(args, "page_type") ?? "concept"));
      return toolResult(await proposeSynthesisFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.propose_policy":
      return toolResult(await proposePolicyFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.propose_section_policy":
      return toolResult(await proposeSectionPolicyFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.propose_source":
      await assertMcpPathsAuthorized(root, "wiki.propose_source", policyContext, ["sources/manifests"]);
      return toolResult(await proposeSourceFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.propose_fact": {
      await assertMcpPathAuthorized(root, "wiki.propose_fact", policyContext, "facts/facts.jsonl");
      return toolResult(await proposeFactFromMcp(root, args, policyContext, mcpActorId(policyContext, args)));
    }
    case "wiki.propose_take": {
      await assertMcpPathAuthorized(root, "wiki.propose_take", policyContext, "takes/takes.jsonl");
      return toolResult(await proposeTakeFromMcp(root, args, policyContext, mcpActorId(policyContext, args)));
    }
    case "wiki.resolve_take": {
      await assertMcpPathAuthorized(root, "wiki.resolve_take", policyContext, "takes/takes.jsonl");
      return toolResult(await resolveTakeFromMcp(root, args, policyContext, mcpActorId(policyContext, args)));
    }
    case "wiki.forget_fact": {
      await assertMcpPathAuthorized(root, "wiki.forget_fact", policyContext, "facts/facts.jsonl");
      return toolResult(await forgetFactFromMcp(root, args, policyContext, mcpActorId(policyContext, args)));
    }
    case "wiki.comment_on_proposal": {
      const proposal = await readProposal(root, stringParam(args, "proposal_id"));
      await assertMcpPathAuthorized(root, "wiki.comment_on_proposal", policyContext, proposal.target_path ?? proposal.path);
      return toolResult(await commentOnProposalFromMcp(root, args, mcpActorId(policyContext, args)));
    }
    case "wiki.inbox_submit": {
      const ownerActorId = optionalStringParam(args, "owner_actor_id") ?? policyContext.actorId;
      const targetSpaceId = optionalStringParam(args, "target_space_id");
      const targetPath = optionalStringParam(args, "target_path");
      await assertMcpInboxSubmitAuthorized(root, policyContext, {
        ...(ownerActorId === undefined ? {} : { ownerActorId }),
        ...(targetSpaceId === undefined ? {} : { targetSpaceId }),
        ...(targetPath === undefined ? {} : { targetPath }),
      });
      return toolResult(await submitInboxFromMcp(root, args, policyContext.actorId));
    }
    case "wiki.ingest_source":
      await assertMcpPathsAuthorized(root, "wiki.ingest_source", policyContext, SOURCE_FETCH_AUTH_PATHS);
      return toolResult(await ingestSourceFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.fetch_source":
      await assertMcpPathsAuthorized(root, "wiki.fetch_source", policyContext, SOURCE_FETCH_AUTH_PATHS);
      return toolResult(redactRunToolResponseForMcp(await fetchSourceFromMcp(root, args, mcpActorId(policyContext, args)), policyContext));
    case "wiki.inbox_process": {
      const id = stringParam(args, "id");
      await assertMcpInboxProcessAuthorized(root, policyContext, id);
      const actorId = mcpActorId(policyContext, args);
      return toolResult(
        await processInboxItem({
          root,
          id,
          ...(actorId === undefined ? {} : { actorId }),
          policyContext,
          dryRun: optionalBooleanParam(args, "dry_run") === true,
        }),
      );
    }
    case "wiki.inbox_ignore": {
      const id = stringParam(args, "id");
      await assertMcpInboxActionAuthorized(root, "wiki.inbox_ignore", policyContext, id);
      const actorId = mcpActorId(policyContext, args);
      const reason = optionalStringParam(args, "reason");
      return toolResult(await ignoreInboxItem({ root, id, ...(actorId === undefined ? {} : { actorId }), ...(reason === undefined ? {} : { reason }) }));
    }
    case "wiki.inbox_retry": {
      const id = stringParam(args, "id");
      await assertMcpInboxActionAuthorized(root, "wiki.inbox_retry", policyContext, id);
      const actorId = mcpActorId(policyContext, args);
      const reason = optionalStringParam(args, "reason");
      return toolResult(await retryInboxItem({ root, id, ...(actorId === undefined ? {} : { actorId }), ...(reason === undefined ? {} : { reason }) }));
    }
    case "wiki.review_proposal": {
      const proposal = await readProposal(root, stringParam(args, "proposal_id"));
      await assertMcpReviewAuthorized(root, policyContext, proposal);
      return toolResult(await reviewProposalFromMcp(root, args, mcpActorId(policyContext, args)));
    }
    case "wiki.close_proposal": {
      const proposal = await readProposal(root, stringParam(args, "proposal_id"));
      await assertMcpReviewAuthorized(root, policyContext, proposal);
      return toolResult(await closeProposalFromMcp(root, args, mcpActorId(policyContext, args)));
    }
    case "wiki.apply_proposal": {
      const proposal = await readProposal(root, stringParam(args, "proposal_id"));
      await assertMcpPathAuthorized(root, "wiki.apply_proposal", policyContext, proposal.target_path ?? proposal.path);
      const actorId = mcpActorId(policyContext, args);
      return toolResult(
        await applyProposal({
          root,
          proposalId: stringParam(args, "proposal_id"),
          ...(actorId === undefined ? {} : { actorId }),
        }),
      );
    }
    case "wiki.create_synthesis":
      await assertMcpPathAuthorized(root, "wiki.create_synthesis", policyContext, synthesisTargetPath(stringParam(args, "title"), optionalStringParam(args, "page_type") ?? "concept"));
      return toolResult(await createSynthesisFromMcp(root, args, mcpActorId(policyContext, args)));
    case "wiki.dream_run": {
      const actorId = mcpActorId(policyContext, args);
      const createProposals = optionalBooleanParam(args, "create_proposals") === true;
      const wait = optionalBooleanParam(args, "wait") === true;
      if (createProposals) {
        assertAuthorized("wiki.propose_edit", policyContext);
      }
      if (!wait) {
        throw new Error("wiki.dream_run requires wait=true so OpenWiki can enforce caller visibility before storing run output");
      }
      const runInput = {
        root,
        runType: "dream.run",
        ...(actorId === undefined ? {} : { actorId }),
        input: dreamRunInputFromMcp(args),
        ...(wait ? { policyContext } : {}),
      };
      return toolResult(redactRunJobResult(await runLocalJob(runInput), policyContext));
    }
    case "wiki.run_job": {
      const actorId = mcpActorId(policyContext, args);
      const input = optionalObjectParam(args, "input");
      const runType = stringParam(args, "run_type");
      if (runJobAuthorizationSpec(runType) === undefined) {
        throw new Error(`Unsupported OpenWiki run type: ${runType}`);
      }
      if (!runJobAllowedFromMcp(runType)) {
        throw new Error(`OpenWiki run type '${runType}' is not available through MCP`);
      }
      for (const operation of runJobAuthorizationOperations(runType)) {
        assertAuthorized(operation, policyContext);
      }
      if (runType === "source.fetch") {
        await assertMcpPathsAuthorized(root, "wiki.fetch_source", policyContext, SOURCE_FETCH_AUTH_PATHS);
      }
      if (runJobRequiresInboxItem(runType)) {
        const inboxItemId = inboxProcessRunInputId(input);
        if (inboxItemId === undefined) {
          throw new Error("inbox.process run input requires id or inbox_item_id");
        }
        await assertMcpInboxProcessAuthorized(root, policyContext, inboxItemId);
      }
      const runInput = {
        root,
        runType,
        ...(actorId === undefined ? {} : { actorId }),
        ...(input === undefined ? {} : { input }),
      };
      if (optionalBooleanParam(args, "wait") === true) {
        return toolResult(redactRunJobResult(await runLocalJob(runInput), policyContext));
      }
      return toolResult({
        run: redactRunForMcp(await createRun(runInput), policyContext),
      });
    }
    case "wiki.run_lint":
      return toolResult(await validateRepository(root));
    case "wiki.commit_changes": {
      const actorId = mcpActorId(policyContext, args);
      const paths = optionalStringArrayParam(args, "paths");
      const all = optionalBooleanParam(args, "all");
      return toolResult(
        await commitChanges({
          root,
          message: stringParam(args, "message"),
          ...(actorId === undefined ? {} : { actorId }),
          ...(paths === undefined ? {} : { paths }),
          ...(all === undefined ? {} : { all }),
          authorizePaths: async (candidatePaths) => {
            for (const repoPath of candidatePaths) {
              await assertMcpPathAuthorized(root, "wiki.commit_changes", policyContext, repoPath);
            }
          },
        }),
      );
    }
    case "wiki.git_pull": {
      const remote = optionalStringParam(args, "remote");
      const branch = optionalStringParam(args, "branch");
      return toolResult(
        await withWriteCoordination(
          {
            root,
            operation: "wiki.git_pull",
            metadata: {
              ...(remote === undefined ? {} : { remote }),
              ...(branch === undefined ? {} : { branch }),
            },
          },
          () =>
            gitPull(root, {
              ...(remote === undefined ? {} : { remote }),
              ...(branch === undefined ? {} : { branch }),
            }),
        ),
      );
    }
    case "wiki.git_push": {
      const remote = optionalStringParam(args, "remote");
      const branch = optionalStringParam(args, "branch");
      return toolResult(
        await withWriteCoordination(
          {
            root,
            operation: "wiki.git_push",
            metadata: {
              ...(remote === undefined ? {} : { remote }),
              ...(branch === undefined ? {} : { branch }),
            },
          },
          () =>
            gitPush(root, {
              ...(remote === undefined ? {} : { remote }),
              ...(branch === undefined ? {} : { branch }),
            }),
        ),
      );
    }
    case "wiki.sync_now": {
      const actorId = mcpActorId(policyContext, args);
      return toolResult(
        await syncWorkspaceNow({
          root,
          ...(actorId === undefined ? {} : { actorId }),
          pull: optionalBooleanParam(args, "pull") ?? true,
          push: optionalBooleanParam(args, "push") ?? true,
          ...optionalStringObjectProperty(args, "remote", "remote"),
          ...optionalStringObjectProperty(args, "branch", "branch"),
        }),
      );
    }
    case "wiki.publish": {
      const outDir = optionalStringParam(args, "out_dir");
      const baseUrl = optionalStringParam(args, "base_url");
      const actorId = mcpActorId(policyContext, args);
      return toolResult(
        await withWriteCoordination(
          {
            root,
            operation: "wiki.publish",
            ...(actorId === undefined ? {} : { actorId }),
            metadata: {
              ...(outDir === undefined ? {} : { out_dir: outDir }),
              ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
            },
          },
          () =>
            publishStaticSite({
              root,
              ...(outDir === undefined ? {} : { outDir }),
              ...(baseUrl === undefined ? {} : { baseUrl }),
              ...(actorId === undefined ? {} : { actorId }),
            }),
        ),
      );
    }
    default:
      throw new Error(`Unsupported OpenWiki tool: ${name}`);
  }
}
