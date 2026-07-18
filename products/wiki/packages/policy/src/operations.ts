import type { OpenWikiRole, OpenWikiScope } from "@openwiki/core";
import type { OpenWikiMcpToolMode, OpenWikiOperation } from "./types.ts";

const OPERATION_SCOPES: Record<OpenWikiOperation, OpenWikiScope[]> = {
  "wiki.search": ["wiki:search"],
  "wiki.recall": ["wiki:search"],
  "wiki.ask": ["wiki:ask"],
  "wiki.think": ["wiki:ask"],
  "wiki.read_page": ["wiki:read"],
  "wiki.read_source": ["wiki:read"],
  "wiki.read_claim": ["wiki:read"],
  "wiki.list_facts": ["wiki:read"],
  "wiki.read_fact": ["wiki:read"],
  "wiki.list_takes": ["wiki:read"],
  "wiki.read_take": ["wiki:read"],
  "wiki.takes_scorecard": ["wiki:read"],
  "wiki.find_trajectory": ["wiki:read"],
  "wiki.list_proposals": ["wiki:read"],
  "wiki.read_proposal": ["wiki:read"],
  "wiki.read_proposal_detail": ["wiki:read"],
  "wiki.read_decision": ["wiki:read"],
  "wiki.trace_claim": ["wiki:read"],
  "wiki.get_history": ["wiki:read"],
  "wiki.diff_versions": ["wiki:read"],
  "wiki.list_recent_changes": ["wiki:read"],
  "wiki.git_status": ["wiki:read"],
  "wiki.git_pull": ["wiki:commit"],
  "wiki.git_push": ["wiki:publish"],
  "wiki.sync_now": ["wiki:publish"],
  "wiki.list_events": ["wiki:read"],
  "wiki.list_runs": ["wiki:read"],
  "wiki.dream_status": ["wiki:read"],
  "wiki.dream_run": ["wiki:read", "wiki:propose"],
  "wiki.list_topics": ["wiki:read"],
  "wiki.list_open_questions": ["wiki:read"],
  "wiki.inbox_list": ["wiki:inbox:read"],
  "wiki.inbox_read": ["wiki:inbox:read"],
  "wiki.inbox_submit": ["wiki:inbox:submit"],
  "wiki.inbox_process": ["wiki:inbox:process"],
  "wiki.inbox_ignore": ["wiki:inbox:process"],
  "wiki.inbox_retry": ["wiki:inbox:process"],
  "wiki.detect_governance": ["wiki:read"],
  "wiki.graph_neighbors": ["wiki:read"],
  "wiki.graph_backlinks": ["wiki:read"],
  "wiki.graph_related": ["wiki:read"],
  "wiki.graph_path": ["wiki:read"],
  "wiki.graph_orphans": ["wiki:read"],
  "wiki.graph_stale": ["wiki:read"],
  "wiki.graph_report": ["wiki:read"],
  "wiki.read_policy": ["wiki:admin"],
  "wiki.preview_permissions": ["wiki:admin"],
  "wiki.list_workspaces": ["wiki:admin"],
  "wiki.connect_workspace": ["wiki:admin"],
  "wiki.propose_policy": ["wiki:admin"],
  "wiki.propose_section_policy": ["wiki:admin"],
  "wiki.propose_edit": ["wiki:propose"],
  "wiki.propose_source": ["wiki:propose"],
  "wiki.propose_synthesis": ["wiki:propose"],
  "wiki.propose_fact": ["wiki:propose"],
  "wiki.propose_take": ["wiki:propose"],
  "wiki.resolve_take": ["wiki:propose"],
  "wiki.forget_fact": ["wiki:propose"],
  "wiki.comment_on_proposal": ["wiki:propose"],
  "wiki.ingest_source": ["wiki:ingest:draft"],
  "wiki.fetch_source": ["wiki:ingest:draft"],
  "wiki.review_proposal": ["wiki:review"],
  "wiki.close_proposal": ["wiki:review"],
  "wiki.apply_proposal": ["wiki:commit"],
  "wiki.create_synthesis": ["wiki:patch"],
  "wiki.run_lint": ["wiki:patch"],
  "wiki.run_job": ["wiki:patch"],
  "wiki.commit_changes": ["wiki:commit"],
  "wiki.publish": ["wiki:publish"],
  "wiki.admin": ["wiki:admin"],
};

const MCP_TOOL_MODE_OPERATIONS: Record<OpenWikiMcpToolMode, OpenWikiOperation[]> = {
  read: [
    "wiki.search",
    "wiki.recall",
    "wiki.ask",
    "wiki.think",
    "wiki.read_page",
    "wiki.read_source",
    "wiki.read_claim",
    "wiki.list_facts",
    "wiki.read_fact",
    "wiki.list_takes",
    "wiki.read_take",
    "wiki.takes_scorecard",
    "wiki.find_trajectory",
    "wiki.list_proposals",
    "wiki.read_proposal",
    "wiki.read_proposal_detail",
    "wiki.read_decision",
    "wiki.trace_claim",
    "wiki.get_history",
    "wiki.diff_versions",
    "wiki.list_recent_changes",
    "wiki.git_status",
    "wiki.list_events",
    "wiki.list_runs",
    "wiki.dream_status",
    "wiki.list_topics",
    "wiki.list_open_questions",
    "wiki.inbox_list",
    "wiki.inbox_read",
    "wiki.detect_governance",
    "wiki.graph_neighbors",
    "wiki.graph_backlinks",
    "wiki.graph_related",
    "wiki.graph_path",
    "wiki.graph_orphans",
    "wiki.graph_stale",
    "wiki.graph_report",
  ],
  proposal: [
    "wiki.propose_edit",
    "wiki.propose_synthesis",
    "wiki.propose_fact",
    "wiki.propose_take",
    "wiki.resolve_take",
    "wiki.forget_fact",
    "wiki.propose_source",
    "wiki.comment_on_proposal",
    "wiki.dream_run",
    "wiki.inbox_submit",
  ],
  write: [
    "wiki.read_policy",
    "wiki.list_workspaces",
    "wiki.connect_workspace",
    "wiki.propose_policy",
    "wiki.propose_section_policy",
    "wiki.ingest_source",
    "wiki.fetch_source",
    "wiki.inbox_process",
    "wiki.inbox_ignore",
    "wiki.inbox_retry",
    "wiki.review_proposal",
    "wiki.close_proposal",
    "wiki.apply_proposal",
    "wiki.create_synthesis",
    "wiki.run_job",
    "wiki.run_lint",
    "wiki.commit_changes",
    "wiki.git_pull",
    "wiki.git_push",
    "wiki.sync_now",
    "wiki.publish",
  ],
};

const ROLE_SCOPES: Record<OpenWikiRole, OpenWikiScope[]> = {
  viewer: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read"],
  contributor: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read", "wiki:inbox:submit", "wiki:propose"],
  researcher: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read", "wiki:inbox:submit", "wiki:propose", "wiki:ingest:draft"],
  reviewer: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read", "wiki:propose", "wiki:review"],
  maintainer: [
    "wiki:read",
    "wiki:search",
    "wiki:ask",
    "wiki:inbox:read",
    "wiki:inbox:submit",
    "wiki:inbox:process",
    "wiki:propose",
    "wiki:ingest:draft",
    "wiki:review",
    "wiki:patch",
    "wiki:commit",
    "wiki:publish",
  ],
  admin: [
    "wiki:read",
    "wiki:search",
    "wiki:ask",
    "wiki:inbox:read",
    "wiki:inbox:submit",
    "wiki:inbox:process",
    "wiki:inbox:admin",
    "wiki:propose",
    "wiki:ingest:draft",
    "wiki:review",
    "wiki:patch",
    "wiki:commit",
    "wiki:publish",
    "wiki:admin",
  ],
  agent: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read", "wiki:inbox:submit", "wiki:propose"],
};

export function requiredScopesForOperation(operation: OpenWikiOperation): OpenWikiScope[] {
  return [...OPERATION_SCOPES[operation]];
}

export function scopesForRole(role: OpenWikiRole): OpenWikiScope[] {
  return [...ROLE_SCOPES[role]];
}

export function scopesForMcpToolMode(mode: OpenWikiMcpToolMode): OpenWikiScope[] {
  if (mode === "read") {
    return scopesForRole("viewer");
  }
  if (mode === "proposal") {
    return scopesForRole("contributor");
  }
  return scopesForRole("maintainer");
}

export function mcpToolModeOperations(mode: OpenWikiMcpToolMode): OpenWikiOperation[] {
  return [...MCP_TOOL_MODE_OPERATIONS[mode]];
}

export function mcpToolOperationsForMode(mode: OpenWikiMcpToolMode): OpenWikiOperation[] {
  if (mode === "read") {
    return mcpToolModeOperations("read");
  }
  if (mode === "proposal") {
    return [...mcpToolModeOperations("read"), ...mcpToolModeOperations("proposal")];
  }
  return [...mcpToolModeOperations("read"), ...mcpToolModeOperations("proposal"), ...mcpToolModeOperations("write")];
}

export function uniqueOperations(values: OpenWikiOperation[]): OpenWikiOperation[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

export function requiredSectionRoleForOperation(operation: OpenWikiOperation): OpenWikiRole {
  if (operation === "wiki.review_proposal" || operation === "wiki.close_proposal") {
    return "reviewer";
  }
  if (
    operation === "wiki.apply_proposal" ||
    operation === "wiki.commit_changes" ||
    operation === "wiki.git_pull" ||
    operation === "wiki.git_push" ||
    operation === "wiki.sync_now" ||
    operation === "wiki.publish" ||
    operation === "wiki.create_synthesis" ||
    operation === "wiki.run_job" ||
    operation === "wiki.run_lint" ||
    operation === "wiki.inbox_process" ||
    operation === "wiki.inbox_ignore" ||
    operation === "wiki.inbox_retry"
  ) {
    return "maintainer";
  }
  if (
    operation === "wiki.propose_policy" ||
    operation === "wiki.propose_section_policy" ||
    operation === "wiki.propose_edit" ||
    operation === "wiki.propose_source" ||
    operation === "wiki.propose_synthesis" ||
    operation === "wiki.propose_fact" ||
    operation === "wiki.propose_take" ||
    operation === "wiki.resolve_take" ||
    operation === "wiki.forget_fact" ||
    operation === "wiki.comment_on_proposal" ||
    operation === "wiki.dream_run" ||
    operation === "wiki.ingest_source" ||
    operation === "wiki.fetch_source" ||
    operation === "wiki.inbox_submit"
  ) {
    return "contributor";
  }
  return "viewer";
}

export function highestRole(roles: OpenWikiRole[]): OpenWikiRole | undefined {
  return roles.reduce<OpenWikiRole | undefined>((best, role) => {
    if (best === undefined || roleLevel(role) > roleLevel(best)) {
      return role;
    }
    return best;
  }, undefined);
}

export function roleAtLeast(actual: OpenWikiRole, required: OpenWikiRole): boolean {
  return roleLevel(actual) >= roleLevel(required);
}

export function roleLevel(role: OpenWikiRole): number {
  switch (role) {
    case "admin":
      return 6;
    case "maintainer":
      return 5;
    case "reviewer":
      return 4;
    case "researcher":
    case "contributor":
    case "agent":
      return 3;
    case "viewer":
      return 1;
  }
}

export function operationNames(): OpenWikiOperation[] {
  return Object.keys(OPERATION_SCOPES) as OpenWikiOperation[];
}

export function uniqueScopes(scopes: OpenWikiScope[]): OpenWikiScope[] {
  return scopes.filter((scope, index) => scopes.indexOf(scope) === index);
}
