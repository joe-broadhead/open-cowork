import { listRecentChanges, readCommit } from "@openwiki/git";
import { readCurrentIndexStoreGraph } from "@openwiki/index-store";
import { readCurrentPostgresGraph } from "@openwiki/postgres-runtime";
import { assertAuthorized, canReadPathExpression, canReadRecordId, visibleRepositoryView } from "@openwiki/policy";
import { listGraphEdges, loadRepository } from "@openwiki/repo";
import { openWikiWorkspaceSummary } from "@openwiki/core";
import {
  listRecentChangesForMcp,
  listEventsForMcp,
  listRunsForMcp,
  listTopicsForMcp,
  listOpenQuestionsForMcp,
  filterGraphIndexForMcp,
} from "./tool-handlers.ts";
import { stringParam } from "./params.ts";
import { resourceContents } from "./tool-output.ts";
import { policyContextForMcp } from "./policy-adapter.ts";
import type { McpServerOptions } from "./types.ts";

export async function listResources(
  root: string,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<unknown> {
  const repo = await loadRepository(root);
  const context = await policyContextForMcp(root, options);
  assertAuthorized("wiki.read_page", context);
  const visible = visibleRepositoryView(repo, context);
  const recentChanges = (await listRecentChangesForMcp(root, 20, context)) as Awaited<ReturnType<typeof listRecentChanges>>;
  return {
    resources: [
      {
        uri: "openwiki://index",
        name: "OpenWiki Index",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://recent-changes",
        name: "Recent Changes",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://events",
        name: "OpenWiki Events",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://runs",
        name: "OpenWiki Runs",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://topics",
        name: "OpenWiki Topics",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://open-questions",
        name: "OpenWiki Open Questions",
        mimeType: "application/json",
      },
      {
        uri: "openwiki://graph",
        name: "OpenWiki Graph",
        mimeType: "application/json",
      },
      ...visible.pages.map((page) => ({
        uri: page.uri,
        name: page.title,
        description: page.summary,
        mimeType: "text/markdown",
      })),
      ...visible.sources.map((source) => ({
        uri: source.uri,
        name: source.title,
        mimeType: "application/json",
      })),
      ...visible.claims.map((claim) => ({
        uri: claim.uri,
        name: claim.text,
        mimeType: "application/json",
      })),
      ...visible.facts.map((fact) => ({
        uri: fact.uri,
        name: fact.text,
        mimeType: "application/json",
      })),
      ...visible.takes.map((take) => ({
        uri: take.uri,
        name: take.statement,
        mimeType: "application/json",
      })),
      ...visible.proposals.map((proposal) => ({
        uri: proposal.uri,
        name: proposal.title,
        mimeType: "application/json",
      })),
      ...visible.comments.map((comment) => ({
        uri: comment.uri,
        name: `Comment on ${comment.proposal_id}`,
        mimeType: "application/json",
      })),
      ...visible.decisions.map((decision) => ({
        uri: decision.uri,
        name: `${decision.decision}: ${decision.proposal_id}`,
        mimeType: "application/json",
      })),
      ...visible.runs.map((run) => ({
        uri: run.uri,
        name: `${run.status}: ${run.run_type}`,
        mimeType: "application/json",
      })),
      ...recentChanges.changes.map((change) => ({
        uri: `openwiki://commit/${change.sha}`,
        name: change.subject,
        description: `${change.short_sha} ${change.date}`,
        mimeType: "application/json",
      })),
    ],
  };
}

export async function readResource(
  root: string,
  params: Record<string, unknown>,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<unknown> {
  const uri = stringParam(params, "uri");
  const repo = await loadRepository(root);
  const context = await policyContextForMcp(root, options);

  if (uri === "openwiki://index") {
    assertAuthorized("wiki.read_page", context);
    const visible = visibleRepositoryView(repo, context);
    return resourceContents(uri, {
      workspace: openWikiWorkspaceSummary(repo.config),
      counts: {
        pages: visible.pages.length,
        sources: visible.sources.length,
        claims: visible.claims.length,
        facts: visible.facts.length,
        takes: visible.takes.length,
        proposals: visible.proposals.length,
        comments: visible.comments.length,
        decisions: visible.decisions.length,
        events: visible.events.length,
        runs: visible.runs.length,
      },
    });
  }

  if (uri === "openwiki://recent-changes") {
    assertAuthorized("wiki.list_recent_changes", context);
    return resourceContents(uri, await listRecentChangesForMcp(root, undefined, context));
  }

  if (uri === "openwiki://events") {
    assertAuthorized("wiki.list_events", context);
    return resourceContents(uri, await listEventsForMcp(root, undefined, context));
  }

  if (uri === "openwiki://runs") {
    assertAuthorized("wiki.list_runs", context);
    return resourceContents(uri, await listRunsForMcp(root, undefined, context));
  }

  if (uri === "openwiki://topics") {
    assertAuthorized("wiki.list_topics", context);
    return resourceContents(uri, await listTopicsForMcp(root, context));
  }

  if (uri === "openwiki://open-questions") {
    assertAuthorized("wiki.list_open_questions", context);
    return resourceContents(uri, await listOpenQuestionsForMcp(root, context));
  }

  if (uri === "openwiki://graph") {
    assertAuthorized("wiki.graph_neighbors", context);
    return resourceContents(uri, await filterGraphIndexForMcp(root, context, (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root))));
  }

  const commitSha = commitShaFromResourceUri(uri);
  if (commitSha) {
    assertAuthorized("wiki.get_history", context);
    const commit = await readCommit(root, commitSha);
    if (commit.commit && commit.commit.files.every((file) => canReadPathExpression(repo.policy, context, file.path))) {
      return resourceContents(`openwiki://commit/${commit.commit.sha}`, commit);
    }
    throw new Error(`Resource not found: ${uri}`);
  }

  const page = repo.pages.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (page) {
    assertAuthorized("wiki.read_page", context);
    if (!canReadRecordId(repo, context, page.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri: page.uri,
          mimeType: "text/markdown",
          text: page.body,
        },
      ],
    };
  }

  const source = repo.sources.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (source) {
    assertAuthorized("wiki.read_source", context);
    if (!canReadRecordId(repo, context, source.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(source.uri, source);
  }

  const claim = repo.claims.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (claim) {
    assertAuthorized("wiki.read_claim", context);
    if (!canReadRecordId(repo, context, claim.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(claim.uri, claim);
  }

  const fact = repo.facts.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (fact) {
    assertAuthorized("wiki.read_fact", context);
    if (!canReadRecordId(repo, context, fact.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(fact.uri, fact);
  }

  const take = repo.takes.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (take) {
    assertAuthorized("wiki.read_take", context);
    if (!canReadRecordId(repo, context, take.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(take.uri, take);
  }

  const proposal = repo.proposals.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (proposal) {
    assertAuthorized("wiki.read_proposal", context);
    if (!canReadRecordId(repo, context, proposal.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(proposal.uri, proposal);
  }

  const comment = repo.comments.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (comment) {
    assertAuthorized("wiki.read_proposal_detail", context);
    if (!canReadRecordId(repo, context, comment.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(comment.uri, comment);
  }

  const decision = repo.decisions.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (decision) {
    assertAuthorized("wiki.read_decision", context);
    if (!canReadRecordId(repo, context, decision.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(decision.uri, decision);
  }

  const run = repo.runs.find((candidate) => candidate.uri === uri || candidate.id === uri);
  if (run) {
    assertAuthorized("wiki.list_runs", context);
    if (!canReadRecordId(repo, context, run.id)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resourceContents(run.uri, run);
  }

  throw new Error(`Resource not found: ${uri}`);
}

function commitShaFromResourceUri(uri: string): string | undefined {
  if (uri.startsWith("openwiki://commit/")) {
    return uri.slice("openwiki://commit/".length);
  }
  if (uri.startsWith("commit:")) {
    return uri.slice("commit:".length);
  }
  return undefined;
}
