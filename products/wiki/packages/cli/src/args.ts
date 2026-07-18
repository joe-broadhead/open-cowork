import type { DecisionValue, SearchPersona } from "@openwiki/core";
import type { McpToolMode } from "@openwiki/mcp-server";
import { parseScopes, type OpenWikiRole, type OpenWikiScope } from "@openwiki/policy";
import type { WorkspaceTemplateName } from "@openwiki/repo";
import { isServiceAccountTokenProfile, parseAgentClient, parseAgentTransport, parseConnectorKind, parseDecision, parseGovernanceDetector, parseMcpToolMode, parseOpenWikiRole, parseSearchMode, parseSearchPersona, parseServiceAccountTokenProfile, parseVisibility, parseWorkspaceTemplate, requireValue } from "./arg-values.ts";
import type { GovernanceDetectorKind, ServiceAccountTokenProfile } from "@openwiki/workflows";
import type { AgentClient, AgentTransport } from "./arg-values.ts";

/** Normalized option bag shared by all CLI command handlers. */
export interface CliOptions {
  root?: string;
  json: boolean;
  limit?: number;
  explain: boolean;
  highlights: boolean;
  offset?: number;
  persona?: SearchPersona;
  types: string[];
  searchMode?: "lexical" | "hybrid";
  fuzzy: boolean;
  title?: string;
  template?: WorkspaceTemplateName;
  port?: number;
  host?: string;
  outDir?: string;
  htmlPageCeiling?: number;
  sitemapShardSize?: number;
  llmsFullMaxBytes?: number;
  targetRoot?: string;
  wikiRoot?: string;
  baseUrl?: string;
  bodyFile?: string;
  contentFile?: string;
  inboxDir?: string;
  inboxAdapter?: "file";
  provider?: string;
  externalId?: string;
  idempotencyKey?: string;
  archiveDir?: string;
  quarantineDir?: string;
  sourceType?: string;
  contentHash?: string;
  url?: string;
  connectorKind?: "http" | "github" | "gitlab";
  connectorId?: string;
  credentialRef?: string;
  githubOwner?: string;
  githubRepo?: string;
  gitlabProject?: string;
  gitRemote?: string;
  gitBranch?: string;
  gitRemoteUrl?: string;
  syncPull: boolean;
  syncPush: boolean;
  pullOnStart: boolean;
  pushAfterCommit: boolean;
  every?: string;
  sourcePath?: string;
  sourceRef?: string;
  actor?: string;
  rationale?: string;
  kind?: string;
  text?: string;
  statement?: string;
  probability?: number;
  confidence?: string;
  sensitivity?: "public" | "internal" | "private";
  dueAt?: string;
  validFrom?: string;
  validTo?: string;
  resolution?: string;
  supersededBy?: string;
  summary?: string;
  pageType?: string;
  topics: string[];
  statuses: string[];
  governanceDetectors: GovernanceDetectorKind[];
  staleAfterDays?: number;
  sourceIds: string[];
  subjectIds: string[];
  pageIds: string[];
  claimIds: string[];
  targetId?: string;
  targetPath?: string;
  sectionId?: string;
  sectionPaths: string[];
  visibility?: "public" | "internal" | "private";
  ownerPrincipal?: string;
  viewerPrincipals: string[];
  contributorPrincipals: string[];
  researcherPrincipals: string[];
  reviewerPrincipals: string[];
  maintainerPrincipals: string[];
  adminPrincipals: string[];
  requiredReviewerPrincipals: string[];
  updatedAfter?: string;
  decision?: DecisionValue;
  commit: boolean;
  commitAll: boolean;
  commitPaths: string[];
  force: boolean;
  applySynthesis: boolean;
  citations: boolean;
  message?: string;
  task?: string;
  agentCommand?: string;
  agentArgs: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRuntimeMs?: number;
  eventType?: string;
  operation?: string;
  lockName?: string;
  recordId?: string;
  since?: string;
  until?: string;
  cursor?: string;
  timelineCursor?: string;
  enqueue: boolean;
  once: boolean;
  pollMs?: number;
  maxJobs?: number;
  mcpToolMode?: McpToolMode;
  mode?: string;
  mcpRole?: OpenWikiRole;
  mcpScopes: OpenWikiScope[];
  principals: string[];
  token?: string;
  tokenEnv?: string;
  tokenFile?: string;
  tokenId?: string;
  profile?: string;
  authTokenProfile?: ServiceAccountTokenProfile;
  expiresAt?: string;
  expiresInDays?: number;
  description?: string;
  tokenDescription?: string;
  reason?: string;
  trustHeaders: boolean;
  trustedHeaderSecret?: string;
  fromRef?: string;
  toRef?: string;
  agentClient?: AgentClient;
  agentTransport?: AgentTransport;
  serverUrl?: string;
  configOut?: string;
  tokenOut?: string;
  createToken: boolean;
  confirmWriteTools: boolean;
  allowSyncFolderWorkspace: boolean;
  skipAgent: boolean;
  dryRun?: boolean;
  verifyBackup: boolean;
  backupId?: string;
  backupDestination?: string;
  backupPath?: string;
  backupBucket?: string;
  rcloneRemote?: string;
  backupPrefix?: string;
  backupRegion?: string;
  endpointUrl?: string;
  accessKeyEnv?: string;
  secretKeyEnv?: string;
  sessionTokenEnv?: string;
  credentialsEnv?: string;
  serverSideEncryption?: string;
  kmsKeyId?: string;
  kmsKeyName?: string;
  forcePathStyle: boolean;
  allowInsecureHttp: boolean;
  keepLast?: number;
  keepDays?: number;
  adminPrincipal?: string;
  teamGroup?: string;
  spaceTitle?: string;
  replaceGrants: boolean;
  deployProfile?: string;
  publicOrigin?: string;
  image?: string;
  schemaPack?: string;
  dreamPhases: string[];
  createProposals: boolean;
}

function defaultOptions(): CliOptions {
  return {
    json: false,
    explain: false,
    highlights: false,
    fuzzy: false,
    commit: false,
    commitAll: false,
    commitPaths: [],
    force: false,
    applySynthesis: false,
    citations: false,
    agentArgs: [],
    syncPull: false,
    syncPush: false,
    pullOnStart: false,
    pushAfterCommit: false,
    enqueue: false,
    once: false,
    types: [],
    topics: [],
    statuses: [],
    governanceDetectors: [],
    sourceIds: [],
    subjectIds: [],
    pageIds: [],
    claimIds: [],
    sectionPaths: [],
    viewerPrincipals: [],
    contributorPrincipals: [],
    researcherPrincipals: [],
    reviewerPrincipals: [],
    maintainerPrincipals: [],
    adminPrincipals: [],
    requiredReviewerPrincipals: [],
    mcpScopes: [],
    principals: [],
    trustHeaders: false,
    createToken: false,
    confirmWriteTools: false,
    allowSyncFolderWorkspace: false,
    skipAgent: false,
    verifyBackup: false,
    replaceGrants: false,
    forcePathStyle: false,
    allowInsecureHttp: false,
    dreamPhases: [],
    createProposals: false,
  };
}

/** Flags that take no value and simply toggle a boolean option. */
const BOOLEAN_FLAGS: Record<string, (options: CliOptions) => void> = {
  "--json": (o) => { o.json = true; },
  "--explain": (o) => { o.explain = true; },
  "--highlights": (o) => { o.highlights = true; },
  "--fuzzy": (o) => { o.fuzzy = true; },
  "--commit": (o) => { o.commit = true; },
  "--all": (o) => { o.commitAll = true; },
  "--force": (o) => { o.force = true; },
  "--apply": (o) => { o.applySynthesis = true; },
  "--citations": (o) => { o.citations = true; },
  "--enqueue": (o) => { o.enqueue = true; },
  "--once": (o) => { o.once = true; },
  "--create-token": (o) => { o.createToken = true; },
  "--confirm-write-tools": (o) => { o.confirmWriteTools = true; },
  "--allow-sync-folder-workspace": (o) => { o.allowSyncFolderWorkspace = true; },
  "--skip-agent": (o) => { o.skipAgent = true; },
  "--dry-run": (o) => { o.dryRun = true; },
  "--create-proposals": (o) => { o.createProposals = true; },
  "--verify": (o) => { o.verifyBackup = true; },
  "--trust-headers": (o) => { o.trustHeaders = true; },
  "--replace-grants": (o) => { o.replaceGrants = true; },
  "--force-path-style": (o) => { o.forcePathStyle = true; },
  "--allow-insecure-http": (o) => { o.allowInsecureHttp = true; },
  "--pull": (o) => { o.syncPull = true; },
  "--push": (o) => { o.syncPush = true; },
  "--pull-on-start": (o) => { o.pullOnStart = true; },
  "--push-after-commit": (o) => { o.pushAfterCommit = true; },
};

/**
 * Flags that consume the following argv value. Each handler receives the validated raw value and
 * writes it (parsed/converted as needed) onto the option bag. `--path` is handled separately in
 * `parseArgs` because it routes into a command-scoped list rather than the option bag.
 */
const VALUE_FLAGS: Record<string, (options: CliOptions, raw: string) => void> = {
  "--root": (o, v) => { o.root = v; },
  "--limit": (o, v) => { o.limit = numberFlag("--limit", v); },
  "--offset": (o, v) => { o.offset = numberFlag("--offset", v); },
  "--persona": (o, v) => { o.persona = parseSearchPersona(v); },
  "--type": (o, v) => { o.types.push(v); },
  "--mode": (o, v) => { o.mode = v; },
  "--title": (o, v) => { o.title = v; },
  "--template": (o, v) => { o.template = parseWorkspaceTemplate(v); },
  "--id": (o, v) => { o.targetId = v; },
  "--profile": (o, v) => {
    o.profile = v;
    if (isServiceAccountTokenProfile(v)) {
      o.authTokenProfile = parseServiceAccountTokenProfile(v);
    }
  },
  "--port": (o, v) => { o.port = numberFlag("--port", v); },
  "--host": (o, v) => { o.host = v; },
  "--out-dir": (o, v) => { o.outDir = v; },
  "--target-root": (o, v) => { o.targetRoot = v; },
  "--wiki-root": (o, v) => { o.wikiRoot = v; },
  "--base-url": (o, v) => { o.baseUrl = v; },
  "--html-page-ceiling": (o, v) => { o.htmlPageCeiling = numberFlag("--html-page-ceiling", v); },
  "--sitemap-shard-size": (o, v) => { o.sitemapShardSize = numberFlag("--sitemap-shard-size", v); },
  "--llms-full-max-bytes": (o, v) => { o.llmsFullMaxBytes = numberFlag("--llms-full-max-bytes", v); },
  "--body-file": (o, v) => { o.bodyFile = v; },
  "--content-file": (o, v) => { o.contentFile = v; },
  "--file": (o, v) => { o.contentFile = v; },
  "--dir": (o, v) => { o.inboxDir = v; },
  "--adapter": (o, v) => {
    if (v !== "file") {
      throw new Error(`Invalid inbox adapter '${v}'. Expected file.`);
    }
    o.inboxAdapter = v;
  },
  "--provider": (o, v) => { o.provider = v; },
  "--external-id": (o, v) => { o.externalId = v; },
  "--idempotency-key": (o, v) => { o.idempotencyKey = v; },
  "--archive-dir": (o, v) => { o.archiveDir = v; },
  "--quarantine-dir": (o, v) => { o.quarantineDir = v; },
  "--source-type": (o, v) => { o.sourceType = v; },
  "--content-hash": (o, v) => { o.contentHash = v; },
  "--url": (o, v) => { o.url = v; },
  "--connector-kind": (o, v) => { o.connectorKind = parseConnectorKind(v); },
  "--connector": (o, v) => { o.connectorId = v; },
  "--credential-ref": (o, v) => { o.credentialRef = v; },
  "--github-owner": (o, v) => { o.githubOwner = v; },
  "--github-repo": (o, v) => { o.githubRepo = v; },
  "--remote": (o, v) => { o.gitRemote = v; },
  "--branch": (o, v) => { o.gitBranch = v; },
  "--remote-url": (o, v) => { o.gitRemoteUrl = v; },
  "--git-remote": (o, v) => { o.gitRemoteUrl = v; },
  "--every": (o, v) => { o.every = v; },
  "--gitlab-project": (o, v) => { o.gitlabProject = v; },
  "--source-path": (o, v) => { o.sourcePath = v; },
  "--ref": (o, v) => { o.sourceRef = v; },
  "--actor": (o, v) => { o.actor = v; },
  "--rationale": (o, v) => { o.rationale = v; },
  "--reason": (o, v) => { o.rationale = v; o.reason = v; },
  "--kind": (o, v) => { o.kind = v; },
  "--text": (o, v) => { o.text = v; },
  "--statement": (o, v) => { o.statement = v; },
  "--probability": (o, v) => { o.probability = numberFlag("--probability", v); },
  "--confidence": (o, v) => { o.confidence = v; },
  "--sensitivity": (o, v) => { o.sensitivity = parseVisibility(v); },
  "--due-at": (o, v) => { o.dueAt = v; },
  "--valid-from": (o, v) => { o.validFrom = v; },
  "--valid-to": (o, v) => { o.validTo = v; },
  "--resolution": (o, v) => { o.resolution = v; },
  "--superseded-by": (o, v) => { o.supersededBy = v; },
  "--summary": (o, v) => { o.summary = v; },
  "--page-type": (o, v) => { o.pageType = v; },
  "--topic": (o, v) => { o.topics.push(v); },
  "--status": (o, v) => { o.statuses.push(v); },
  "--detector": (o, v) => { o.governanceDetectors.push(parseGovernanceDetector(v)); },
  "--stale-after-days": (o, v) => { o.staleAfterDays = numberFlag("--stale-after-days", v); },
  "--updated-after": (o, v) => { o.updatedAfter = v; },
  "--source": (o, v) => { o.sourceIds.push(v); },
  "--subject": (o, v) => { o.subjectIds.push(v); },
  "--page": (o, v) => { o.pageIds.push(v); },
  "--claim": (o, v) => { o.claimIds.push(v); },
  "--target": (o, v) => { o.targetId = v; },
  "--target-path": (o, v) => { o.targetPath = v; },
  "--section": (o, v) => { o.sectionId = v; },
  "--visibility": (o, v) => { o.visibility = parseVisibility(v); },
  "--owner": (o, v) => { o.ownerPrincipal = v; },
  "--viewer": (o, v) => { o.viewerPrincipals.push(v); },
  "--contributor": (o, v) => { o.contributorPrincipals.push(v); },
  "--researcher": (o, v) => { o.researcherPrincipals.push(v); },
  "--reviewer": (o, v) => { o.reviewerPrincipals.push(v); },
  "--maintainer": (o, v) => { o.maintainerPrincipals.push(v); },
  "--admin": (o, v) => { o.adminPrincipals.push(v); },
  "--required-reviewer": (o, v) => { o.requiredReviewerPrincipals.push(v); },
  "--decision": (o, v) => { o.decision = parseDecision(v); },
  "--message": (o, v) => { o.message = v; },
  "--task": (o, v) => { o.task = v; },
  "--agent-command": (o, v) => { o.agentCommand = v; },
  "--agent-arg": (o, v) => { o.agentArgs.push(v); },
  "--timeout-ms": (o, v) => { o.timeoutMs = numberFlag("--timeout-ms", v); },
  "--max-bytes": (o, v) => { o.maxBytes = numberFlag("--max-bytes", v); },
  "--max-runtime-ms": (o, v) => { o.maxRuntimeMs = numberFlag("--max-runtime-ms", v); },
  "--event-type": (o, v) => { o.eventType = v; },
  "--operation": (o, v) => { o.operation = v; },
  "--lock-name": (o, v) => { o.lockName = v; },
  "--record": (o, v) => { o.recordId = v; },
  "--since": (o, v) => { o.since = v; },
  "--until": (o, v) => { o.until = v; },
  "--cursor": (o, v) => { o.cursor = v; },
  "--timeline-cursor": (o, v) => { o.timelineCursor = v; },
  "--poll-ms": (o, v) => { o.pollMs = numberFlag("--poll-ms", v); },
  "--max-jobs": (o, v) => { o.maxJobs = numberFlag("--max-jobs", v); },
  "--tools": (o, v) => { o.mcpToolMode = parseMcpToolMode(v); },
  "--role": (o, v) => { o.mcpRole = parseOpenWikiRole(v); },
  "--principal": (o, v) => { o.principals.push(v); },
  "--group": (o, v) => { o.principals.push(v.startsWith("group:") ? v : `group:${v}`); },
  "--scope": (o, v) => { o.mcpScopes.push(...parseScopes(v)); },
  "--token-id": (o, v) => { o.tokenId = v; },
  "--expires-at": (o, v) => { o.expiresAt = v; },
  "--expires-in-days": (o, v) => { o.expiresInDays = numberFlag("--expires-in-days", v); },
  "--description": (o, v) => { o.description = v; },
  "--token-description": (o, v) => { o.tokenDescription = v; },
  "--token": (o, v) => { o.token = v; },
  "--token-env": (o, v) => { o.tokenEnv = v; },
  "--token-file": (o, v) => { o.tokenFile = v; },
  "--token-out": (o, v) => { o.tokenOut = v; },
  "--agent": (o, v) => { o.agentClient = parseAgentClient(v); },
  "--client": (o, v) => { o.agentClient = parseAgentClient(v); },
  "--transport": (o, v) => { o.agentTransport = parseAgentTransport(v); },
  "--server-url": (o, v) => { o.serverUrl = v; },
  "--config-out": (o, v) => { o.configOut = v; },
  "--output": (o, v) => { o.configOut = v; },
  "--destination": (o, v) => { o.backupDestination = v; },
  "--backup-id": (o, v) => { o.backupId = v; },
  "--backup-path": (o, v) => { o.backupPath = v; },
  "--bucket": (o, v) => { o.backupBucket = v; },
  "--rclone-remote": (o, v) => { o.rcloneRemote = v; },
  "--prefix": (o, v) => { o.backupPrefix = v; },
  "--region": (o, v) => { o.backupRegion = v; },
  "--endpoint-url": (o, v) => { o.endpointUrl = v; },
  "--access-key-env": (o, v) => { o.accessKeyEnv = v; },
  "--secret-key-env": (o, v) => { o.secretKeyEnv = v; },
  "--session-token-env": (o, v) => { o.sessionTokenEnv = v; },
  "--credentials-env": (o, v) => { o.credentialsEnv = v; },
  "--server-side-encryption": (o, v) => { o.serverSideEncryption = v; },
  "--kms-key-id": (o, v) => { o.kmsKeyId = v; },
  "--kms-key-name": (o, v) => { o.kmsKeyName = v; },
  "--keep-last": (o, v) => { o.keepLast = numberFlag("--keep-last", v); },
  "--keep-days": (o, v) => { o.keepDays = numberFlag("--keep-days", v); },
  "--admin-principal": (o, v) => { o.adminPrincipal = v; },
  "--team-group": (o, v) => { o.teamGroup = v; },
  "--space-title": (o, v) => { o.spaceTitle = v; },
  "--deploy-profile": (o, v) => { o.deployProfile = v; },
  "--public-origin": (o, v) => { o.publicOrigin = v; },
  "--image": (o, v) => { o.image = v; },
  "--schema-pack": (o, v) => { o.schemaPack = v; },
  "--phase": (o, v) => { o.dreamPhases.push(v); },
  "--trusted-header-secret": (o, v) => { o.trustedHeaderSecret = v; },
  "--from": (o, v) => { o.fromRef = v; },
  "--to": (o, v) => { o.toRef = v; },
};

function numberFlag(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} expects a finite number, got '${raw}'`);
  }
  return value;
}

/** Parse raw `openwiki` argv values into a command, positional args, and typed options. */
export function parseArgs(argv: string[]): { command: string | undefined; args: string[]; options: CliOptions } {
  const args: string[] = [];
  const pathArgs: string[] = [];
  const options = defaultOptions();
  if (argv.includes("--token")) {
    throw new Error("--token is disabled because command-line secrets are visible to other local processes; use --token-env, --token-file, or OPENWIKI_TOKEN");
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value === "--") {
      continue;
    }
    const booleanFlag = BOOLEAN_FLAGS[value];
    if (booleanFlag !== undefined) {
      booleanFlag(options);
      continue;
    }
    if (value === "--path") {
      pathArgs.push(requireValue(argv, index, "--path"));
      index += 1;
      continue;
    }
    const valueFlag = VALUE_FLAGS[value];
    if (valueFlag !== undefined) {
      valueFlag(options, requireValue(argv, index, value));
      index += 1;
      continue;
    }
    args.push(value);
  }

  const [command, ...rest] = args;
  applyCommandScopedMode(command, options);
  if (pathArgs.length > 0) {
    if (command === "commit") {
      options.commitPaths.push(...pathArgs);
    } else if (command === "policy" && rest[0] === "propose-section") {
      options.sectionPaths.push(...pathArgs);
    } else if (command === "backup" && rest[0] === "configure") {
      const [backupPath] = pathArgs;
      if (pathArgs.length !== 1 || backupPath === undefined) {
        throw new Error("backup configure expects exactly one --path value.");
      }
      options.backupPath = backupPath;
    } else {
      throw new Error("--path is only supported by `commit`, `policy propose-section`, and `backup configure`.");
    }
  }
  return { command, args: rest, options };
}

function applyCommandScopedMode(command: string | undefined, options: CliOptions): void {
  if (options.mode === undefined) {
    return;
  }
  if (command === "mcp") {
    options.mcpToolMode = parseMcpToolMode(options.mode);
    return;
  }
  if (command === "search") {
    options.searchMode = parseSearchMode(options.mode);
    return;
  }
  if (options.mode === "read" || options.mode === "proposal" || options.mode === "write") {
    options.mcpToolMode = parseMcpToolMode(options.mode);
    return;
  }
  options.searchMode = parseSearchMode(options.mode);
}

export { parseOpenWikiOperation, parsePolicyFileName, parseProposalStatus } from "./arg-values.ts";
export type { AgentClient, AgentTransport } from "./arg-values.ts";
