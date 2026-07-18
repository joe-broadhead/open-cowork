import type { DecisionValue, ProposalStatus, SearchPersona } from "@openwiki/core";
import type { McpToolMode } from "@openwiki/mcp-server";
import { operationNames, type OpenWikiOperation, type OpenWikiRole } from "@openwiki/policy";
import type { WorkspaceTemplateName } from "@openwiki/repo";
import type { GovernanceDetectorKind, ServiceAccountTokenProfile } from "@openwiki/workflows";

export type AgentClient = "opencode" | "generic" | "none";
export type AgentTransport = "stdio" | "http";

export function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

export function parseDecision(value: string): DecisionValue {
  if (value === "accepted" || value === "rejected" || value === "needs_changes") {
    return value;
  }
  throw new Error(`Invalid decision '${value}'`);
}

export function parsePolicyFileName(value: string): "sections" | "grants" | "approval-rules" | "approval_rules" {
  if (value === "sections" || value === "grants" || value === "approval-rules" || value === "approval_rules") {
    return value;
  }
  throw new Error("Invalid policy file '" + value + "'");
}

export function parseVisibility(value: string): "public" | "internal" | "private" {
  if (value === "public" || value === "internal" || value === "private") {
    return value;
  }
  throw new Error(`Invalid visibility '${value}'`);
}

export function parseProposalStatus(value: string): ProposalStatus {
  if (value === "open" || value === "accepted" || value === "rejected" || value === "applied" || value === "closed") {
    return value;
  }
  throw new Error(`Invalid proposal status '${value}'`);
}

export function parseGovernanceDetector(value: string): GovernanceDetectorKind {
  if (value === "stale_claim" || value === "missing_source" || value === "broken_link" || value === "orphan_page") {
    return value;
  }
  throw new Error(`Invalid governance detector '${value}'`);
}

export function parseMcpToolMode(value: string): McpToolMode {
  if (value === "read" || value === "proposal" || value === "write") {
    return value;
  }
  throw new Error(`Invalid MCP tool mode '${value}'`);
}

export function parseServiceAccountTokenProfile(value: string): ServiceAccountTokenProfile {
  if (isServiceAccountTokenProfile(value)) {
    return value;
  }
  throw new Error(
    `Invalid service-account token profile '${value}'. Expected local-agent, ci-bot, hosted-readonly-agent, inbox-submitter, inbox-curator, proposal-agent, or maintainer-automation.`,
  );
}

export function isServiceAccountTokenProfile(value: string): value is ServiceAccountTokenProfile {
  return (
    value === "local-agent" ||
    value === "ci-bot" ||
    value === "hosted-readonly-agent" ||
    value === "inbox-submitter" ||
    value === "inbox-curator" ||
    value === "proposal-agent" ||
    value === "maintainer-automation"
  );
}

export function parseConnectorKind(value: string): "http" | "github" | "gitlab" {
  if (value === "http" || value === "github" || value === "gitlab") {
    return value;
  }
  throw new Error(`Invalid connector kind '${value}'. Expected http, github, or gitlab.`);
}

export function parseOpenWikiRole(value: string): OpenWikiRole {
  if (
    value === "viewer" ||
    value === "contributor" ||
    value === "researcher" ||
    value === "reviewer" ||
    value === "maintainer" ||
    value === "admin" ||
    value === "agent"
  ) {
    return value;
  }
  throw new Error(`Invalid OpenWiki role '${value}'`);
}

export function parseOpenWikiOperation(value: string): OpenWikiOperation {
  const operations = operationNames();
  if ((operations as string[]).includes(value)) {
    return value as OpenWikiOperation;
  }
  throw new Error(`Invalid OpenWiki operation '${value}'`);
}

export function parseSearchPersona(value: string): SearchPersona {
  if (
    value === "default" ||
    value === "researcher" ||
    value === "editor" ||
    value === "reviewer" ||
    value === "governance"
  ) {
    return value;
  }
  throw new Error(`Invalid search persona '${value}'. Expected default, researcher, editor, reviewer, or governance.`);
}

export function parseSearchMode(value: string): "lexical" | "hybrid" {
  if (value === "lexical" || value === "hybrid") {
    return value;
  }
  throw new Error(`Invalid search mode '${value}'. Expected lexical or hybrid.`);
}

export function parseWorkspaceTemplate(value: string): WorkspaceTemplateName {
  if (
    value === "team-wiki" ||
    value === "basic" ||
    value === "personal-wiki" ||
    value === "company-wiki" ||
    value === "public-encyclopedia" ||
    value === "github-pages"
  ) {
    return value;
  }
  throw new Error(
    `Invalid OpenWiki template '${value}'. Expected team-wiki, basic, personal-wiki, company-wiki, public-encyclopedia, or github-pages.`,
  );
}

export function parseAgentClient(value: string): AgentClient {
  if (value === "opencode" || value === "generic" || value === "none") {
    return value;
  }
  if (value === "generic-mcp") {
    return "generic";
  }
  throw new Error(`Invalid agent client '${value}'. Expected opencode, generic, generic-mcp, or none.`);
}

export function parseAgentTransport(value: string): AgentTransport {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new Error(`Invalid agent transport '${value}'. Expected stdio or http.`);
}
