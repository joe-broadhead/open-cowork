import type { CliOptions } from "./args.ts";

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Print a JSON payload when requested, otherwise emit the provided human summary. */
export function printMaybeJson(value: unknown, options: CliOptions, message: string): void {
  if (options.json) {
    printJson(value);
    return;
  }
  console.log(message);
}

const MAIN_HELP = `OpenWiki local CLI

Usage:
  openwiki help [command]
  openwiki --version
  openwiki version --check [--json]
  openwiki upgrade [--json]
  openwiki self-check [--json]
  openwiki completion bash|zsh|fish
  openwiki doctor [--root <path>] [--profile personal|hosted|kubernetes] [--json]
  openwiki setup personal [path] [--title "Personal Wiki"] [--agent opencode|generic|none] [--tools read|proposal|write] [--git-remote URL] [--branch main] [--backup-path folder] [--config-out path] [--create-token --token-out path] [--confirm-write-tools] [--json]
  openwiki setup team [path] [--title "Team Wiki"] [--admin-principal principal] [--team-group group:team] [--space-title "Team Knowledge"] [--json]
  openwiki agent providers list [--json]
  openwiki agent install --provider opencode --profile personal-curator|researcher|reviewer|maintainer|wiki-curator|developer|global [--out-dir <path>] [--wiki-root <path>] [--json]
  openwiki [--root <path>] agent configure --client opencode|generic [--transport stdio|http] [--server-url URL] [--tools read|proposal|write] [--token-env ENV|--token-file path|--create-token --token-out path] [--config-out path] [--json]
  openwiki [--root <path>] mcp install opencode|generic --mode read|proposal|write [--output path] [--confirm-write-tools] [--json]
  openwiki deploy profile list [--json]
  openwiki [--root <path>] deploy preflight [--deploy-profile local-personal|public-static|docker-private|hosted-enterprise|kubernetes-enterprise|aws-ecs-efs|gcp-gke|cloud-run-readmostly] [--public-origin URL] [--image image@sha256:...] [--out-dir public] [--json]
  openwiki init <path> [--title "My Wiki"] [--template team-wiki|basic|personal-wiki|company-wiki|public-encyclopedia|github-pages] [--json]
  openwiki [--root <path>] index [--json]
  openwiki [--root <path>] db rebuild|sync-postgres [--full]|migrate|schema postgres|check|summary|postgres-summary|write-lease|recover-write-lease|records|edges [--type page|page_source] [--limit N] [--lock-name name] [--json]
  openwiki [--root <path>] search <query> [--json] [--limit N] [--persona researcher] [--type page] [--mode lexical|hybrid] [--fuzzy] [--topic topic] [--status status] [--offset N] [--highlights] [--explain]
  openwiki search <wiki-root> <query> [--json] [--limit N]
  openwiki [--root <path>] recall <query> [--json] [--limit N] [--type fact|take|claim|page|source] [--explain] [--highlights]
  openwiki [--root <path>] ask <question> [--citations] [--json] [--limit N] [--explain]
  openwiki ask <wiki-root> <question> [--citations] [--json] [--limit N]
  openwiki [--root <path>] think <question> [--citations] [--json] [--limit N] [--explain]
  openwiki think <wiki-root> <question> [--citations] [--json] [--limit N]
  openwiki [--root <path>] pages list|read <id>|search <query>|history <id>|diff <id>|propose <id> [--json]
  openwiki [--root <path>] page read <id> [--json]
  openwiki [--root <path>] source list [--limit N] [--json]
  openwiki [--root <path>] source read <id> [--json]
  openwiki [--root <path>] source content <id> [--max-bytes N] [--json]
  openwiki [--root <path>] source ingest --title text [--url URL] [--source-type type] [--content-file path] [--json]
  openwiki [--root <path>] source propose --title text [--url URL] [--source-type type] [--content-hash sha256:...] [--json]
  openwiki [--root <path>] source fetch --title text --url URL [--source-type type] [--connector-kind http|github|gitlab] [--connector id] [--credential-ref ref] [--github-owner owner --github-repo repo --source-path path] [--gitlab-project group/project --source-path path --ref ref] [--max-bytes N] [--timeout-ms N] [--enqueue] [--json]
  openwiki [--root <path>] claim read <id> [--json]
  openwiki [--root <path>] claim trace <id> [--json]
  openwiki [--root <path>] facts list|read <id>|propose|forget <id> [--text text] [--body-file path] [--kind kind] [--subject id] [--page page:id] [--source source:id] [--claim claim:id] [--confidence low|medium|high] [--sensitivity public|internal|private] [--json]
  openwiki [--root <path>] takes list|read <id>|scorecard|propose|resolve <id> [--statement text] [--probability 0.7] [--resolution correct|incorrect|partial|unresolvable] [--page page:id] [--source source:id] [--claim claim:id] [--json]
  openwiki [--root <path>] trajectory <id-or-query> [--target record:id] [--limit N] [--json]
  openwiki [--root <path>] decision read <id> [--json]
  openwiki [--root <path>] schema-pack list|validate [path]|explain [--schema-pack path-or-name]|scaffold [name] [--out-dir folder] [--force] [--json]
  openwiki [--root <path>] topics [--json]
  openwiki [--root <path>] questions [--json]
  openwiki [--root <path>] dream run [phase...] [--phase phase] [--limit N] [--timeout-ms N] [--dry-run|--create-proposals] [--enqueue] [--actor actor:user:local] [--json]
  openwiki [--root <path>] dream status [run-id] [--limit N] [--json]
  openwiki [--root <path>] dream report [run-id] [--json]
  openwiki [--root <path>] graph edges|neighbors <id>|backlinks <id>|related <id>|path <from> <to>|orphans|stale|report [--json] [--limit N] [--explain]
  openwiki [--root <path>] history <id> [--limit N] [--json]
  openwiki [--root <path>] diff <id> [--from ref] [--to ref] [--json]
  openwiki [--root <path>] changes [--limit N] [--json]
  openwiki [--root <path>] git status|configure|pull|push [--remote origin] [--branch main] [--remote-url url] [--credential-ref ref] [--json]
  openwiki [--root <path>] sync status [--json]
  openwiki [--root <path>] sync check-remote [--remote origin] [--branch main] [--timeout-ms N] [--json]
  openwiki [--root <path>] sync explain-conflict [--json]
  openwiki [--root <path>] sync connect git --remote-url <url> --branch main [--remote origin] [--credential-ref ref] [--json]
  openwiki [--root <path>] sync now [--pull] [--push] [--message text] [--remote origin] [--branch main] [--json]
  openwiki [--root <path>] sync watch --every 15m [--pull] [--push] [--once] [--json]
  openwiki [--root <path>] sync enable --every 15m [--pull-on-start] [--push-after-commit] [--remote origin] [--branch main] [--json]
  openwiki [--root <path>] sync disable [--json]
  openwiki [--root <path>] sync repair [--json]
  openwiki [--root <path>] inbox add --title text [--file path] [--source-type meeting_transcript] [--provider source-name] [--actor actor:user:local] [--section section:id] [--json]
  openwiki [--root <path>] inbox list [--status received|proposed|ignored|failed] [--actor actor:user:local] [--provider source-name] [--limit N] [--json]
  openwiki [--root <path>] inbox read <inbox-id> [--max-bytes N] [--json]
  openwiki [--root <path>] inbox ignore|retry|process <inbox-id> [--actor actor:user:local] [--dry-run] [--enqueue] [--json]
  openwiki [--root <path>] inbox watch --dir <folder> --adapter file [--provider source-name] [--source-type meeting_transcript] [--every 30s] [--once] [--json]
  openwiki [--root <path>] service install sync --every 15m [--pull] [--push] [--remote origin] [--branch main] [--json]
  openwiki [--root <path>] service install backup --every 24h [--destination id|--out-dir backups] [--json]
  openwiki [--root <path>] service install inbox --dir <folder> --adapter file [--provider source-name] [--source-type meeting_transcript] --every 5m [--json]
  openwiki [--root <path>] service status [--json]
  openwiki [--root <path>] service uninstall sync|backup|inbox [--json]
  openwiki [--root <path>] commit --message text [--all|--path path] [--actor actor:user:local] [--json]
  openwiki [--root <path>] events [--actor actor:user:id] [--event-type type] [--operation op] [--record id] [--since ISO] [--until ISO] [--limit N] [--json]
  openwiki [--root <path>] audit export [--actor actor:user:id] [--event-type type] [--operation op] [--record id] [--since ISO] [--until ISO] [--cursor C] [--timeline-cursor C] [--limit N] [--json]
  openwiki [--root <path>] governance detectors [--detector stale_claim|missing_source|broken_link|orphan_page] [--stale-after-days N] [--json]
  openwiki [--root <path>] runs [monitor|detail <run-id>|reap-stale|cancel <run-id>] [--status queued|running|succeeded|failed] [--limit N] [--max-runtime-ms N] [--dry-run] [--json]
  openwiki [--root <path>] run index|export|lint|inbox-process|inbox-reconcile [<inbox-id>] [--enqueue] [--actor actor:user:local] [--out-dir public] [--base-url URL] [--json]
  openwiki [--root <path>] validate [--json]
  openwiki [--root <path>] worker [--once] [--max-jobs N] [--poll-ms N] [--json]
  openwiki [--root <path>] propose-edit <page-id> --body-file <path> [--source source:id] [--claim claim:id] [--actor actor:user:local] [--rationale text] [--json]
  openwiki [--root <path>] synthesize --title text --body-file <path> [--apply] [--page-type concept] [--topic topic] [--source source:id] [--json]
  openwiki [--root <path>] proposal list [--status open] [--actor actor:id] [--target page:id] [--target-path path] [--section section:id] [--updated-after iso] [--limit N] [--json]
  openwiki [--root <path>] proposal read <proposal-id> [--json]
  openwiki [--root <path>] proposal detail <proposal-id> [--json]
  openwiki [--root <path>] proposal diff <proposal-id> [--json]
  openwiki [--root <path>] proposal snapshot <proposal-id> [--json]
  openwiki [--root <path>] proposal validation <proposal-id> [--json]
  openwiki [--root <path>] proposal comment <proposal-id> --body-file <path> [--actor actor:user:local] [--json]
  openwiki [--root <path>] proposal review <proposal-id> --decision accepted|rejected|needs_changes --rationale text [--json]
  openwiki [--root <path>] proposal close <proposal-id> --reason text [--superseded-by proposal:id] [--json]
  openwiki [--root <path>] proposal apply <proposal-id> [--commit] [--message text] [--json]
  openwiki [--root <path>] policy read [--json]
  openwiki [--root <path>] policy identities [--json]
  openwiki [--root <path>] policy preview [--actor actor:id] [--role role] [--scope scope] [--principal principal] [--group group] [--target-path path] [--target record:id] [--operation wiki.read_page] [--json]
  openwiki [--root <path>] policy propose sections|grants|approval-rules --body-file <path> [--actor actor:user:local] [--rationale text] [--json]
  openwiki [--root <path>] policy propose-section --section section:id --title text --path wiki/team/** [--viewer group:team] [--reviewer group:team-reviewers] [--admin group:team-admins] [--visibility private] [--replace-grants] [--json]
  openwiki [--root <path>] spaces list|read <section:id>|preview|create|edit-advanced sections|grants|approval-rules [--json]
  openwiki [--root <path>] auth token create [service:id|--id service:id] [--profile local-agent|ci-bot|hosted-readonly-agent|inbox-submitter|inbox-curator|proposal-agent|maintainer-automation] [--actor actor:agent:id] [--role role|--scope scope] [--principal principal|--group group] [--expires-at iso|--expires-in-days N] [--description text] [--token-description text] [--json]
  openwiki [--root <path>] auth token list [service:id|--id service:id] [--json]
  openwiki [--root <path>] auth token inspect <service:id> [--json]
  openwiki [--root <path>] auth token revoke <service:id> [--token-id token:id] [--reason text] [--json]
  openwiki [--root <path>] auth token rotate <service:id> [--token-id token:id] [--expires-at iso|--expires-in-days N] [--json]
  openwiki [--root <path>] workspace registry [--json]
  openwiki [--root <path>] workspace connect --remote origin --branch main --remote-url URL --credential-ref cred:name [--json]
  openwiki [--root <path>] maintainer prepare <page-id> --task text [--json]
  openwiki [--root <path>] maintainer run <page-id> --task text [--agent-command cmd --agent-arg arg] [--json]
  openwiki integrate opencode [--profile wiki-curator|developer|global] [--out-dir <path>] [--wiki-root <path>] [--json]
  openwiki [--root <path>] mcp --stdio [--tools read|proposal|write] [--token-env ENV|--token-file path|--role role|--scope scope|--principal principal]
  openwiki [--root <path>] serve [--host 127.0.0.1] [--port 3030] [--role role|--scope scope|--token-env ENV|--token-file path|--principal principal] [--trust-headers --trusted-header-secret secret]
  openwiki serve <wiki-root> [--host 127.0.0.1] [--port 3030]
  openwiki [--root <path>] export static [--out-dir public] [--base-url URL] [--html-page-ceiling N] [--sitemap-shard-size N] [--llms-full-max-bytes N] [--json]
  openwiki [--root <path>] publish static [--out-dir public] [--base-url URL] [--actor actor:user:local] [--html-page-ceiling N] [--json]
  openwiki [--root <path>] backup configure local --id destination-id --path <folder> [--keep-last N] [--keep-days N] [--actor actor:user:local] [--json]
  openwiki [--root <path>] backup configure s3 --id destination-id --bucket bucket --prefix prefix --region region --access-key-env ENV --secret-key-env ENV [--session-token-env ENV] [--server-side-encryption AES256|aws:kms] [--kms-key-id key] [--json]
  openwiki [--root <path>] backup configure minio --id destination-id --endpoint-url URL --bucket bucket --prefix prefix --access-key-env ENV --secret-key-env ENV [--force-path-style] [--allow-insecure-http] [--json]
  openwiki [--root <path>] backup configure gcs --id destination-id --bucket bucket --prefix prefix --credentials-env ENV [--kms-key-name name] [--json]
  openwiki [--root <path>] backup configure rclone --id destination-id --rclone-remote remote:path [--prefix prefix] [--json]
  openwiki [--root <path>] backup credentials explain <destination-id> [--json]
  openwiki [--root <path>] backup rotate <destination-id> [--json]
  openwiki [--root <path>] backup create [--destination id|--out-dir backups] [--verify] [--actor actor:user:local] [--json]
  openwiki [--root <path>] backup watch --every 24h [--destination id|--out-dir backups] [--once] [--json]
  openwiki [--root <path>] backup list [--destination id|--out-dir backups] [--json]
  openwiki [--root <path>] backup status [--destination id] [--json]
  openwiki [--root <path>] backup verify <backup-id|latest|path> [--destination id|--out-dir backups] [--actor actor:user:local] [--json]
  openwiki [--root <path>] backup rehearse [<backup-id|latest|path>] [--backup-id latest] --target-root <path> [--destination id|--out-dir backups] [--force] [--actor actor:user:local] [--json]
  openwiki [--root <path>] backup restore <backup-id|latest|path> --target-root <path> [--destination id|--out-dir backups] [--force] [--dry-run] [--actor actor:user:local] [--json]
  openwiki [--root <path>] backup prune [--destination id|--out-dir backups] [--keep-last N] [--keep-days N] [--dry-run] [--actor actor:user:local] [--json]
`;

/** Print the canonical CLI help text used by generated CLI reference docs. */
export function printHelp(): void {
  console.log(MAIN_HELP);
}

const COMMAND_HELP: Record<string, string> = {
  setup: `OpenWiki setup

Usage:
  openwiki setup personal [path] [--title "Personal Wiki"] [--agent opencode|generic|none] [--tools read|proposal|write] [--git-remote URL] [--branch main] [--backup-path folder] [--config-out path] [--create-token --token-out path] [--confirm-write-tools] [--json]
  openwiki setup team [path] [--title "Team Wiki"] [--admin-principal principal] [--team-group group:team] [--space-title "Team Knowledge"] [--json]

Creates a local personal or team wiki without requiring pnpm commands. Use proposal-mode agent tools by default; write tools require --confirm-write-tools.`,
  search: `OpenWiki search

Usage:
  openwiki [--root <path>] search <query> [--json] [--limit N] [--persona researcher] [--type page] [--mode lexical|hybrid] [--fuzzy] [--topic topic] [--status status] [--offset N] [--highlights] [--explain]

Search reads the current derived index. In hosted mode, configure the Postgres search backend before serving search traffic.`,
  recall: `OpenWiki recall

Usage:
  openwiki [--root <path>] recall <query> [--json] [--limit N] [--type fact|take|claim|page|source] [--explain] [--highlights]

Recall retrieves policy-visible facts, takes, claims, pages, and sources and returns hot memory for agent context.`,
  facts: `OpenWiki facts

Usage:
  openwiki [--root <path>] facts list|read <id>|propose|forget <id> [--json]
  openwiki [--root <path>] facts propose --text text [--kind kind] [--subject id] [--page page:id] [--source source:id] [--claim claim:id] [--confidence low|medium|high] [--sensitivity public|internal|private] [--actor actor:user:local] [--rationale text] [--json]

Fact writes create proposals against facts/facts.jsonl. Forgetting a fact marks it forgotten in the ledger; it does not rewrite Git history.`,
  takes: `OpenWiki takes

Usage:
  openwiki [--root <path>] takes list|read <id>|scorecard|propose|resolve <id> [--json]
  openwiki [--root <path>] takes propose --statement text [--probability 0.7] [--page page:id] [--source source:id] [--claim claim:id] [--json]
  openwiki [--root <path>] takes resolve <take-id> --resolution correct|incorrect|partial|unresolvable [--json]

Takes are probabilistic predictions or judgments. Resolved takes get deterministic Brier-score output.`,
  trajectory: `OpenWiki trajectory

Usage:
  openwiki [--root <path>] trajectory <id-or-query> [--target record:id] [--limit N] [--json]

Trajectory returns a deterministic timeline across visible facts, takes, claims, proposals, and events.`,
  think: `OpenWiki think

Usage:
  openwiki [--root <path>] think <question> [--citations] [--json] [--limit N] [--explain]
  openwiki think <wiki-root> <question> [--citations] [--json] [--limit N]

Think synthesizes a citation-first answer with gaps and retrieval diagnostics. It uses deterministic local synthesis unless a future provider is explicitly configured.`,
  serve: `OpenWiki serve

Usage:
  openwiki [--root <path>] serve [--host 127.0.0.1] [--port 3030] [--role role|--scope scope|--token-env ENV|--token-file path|--principal principal] [--trust-headers --trusted-header-secret secret]
  openwiki serve <wiki-root> [--host 127.0.0.1] [--port 3030]

Serves the full wiki UI, HTTP API, and Streamable HTTP MCP endpoint. Use trusted headers only behind a proxy that supplies the shared secret.`,
  agent: `OpenWiki agent

Usage:
  openwiki agent providers list [--json]
  openwiki agent install --provider opencode --profile personal-curator|researcher|reviewer|maintainer|wiki-curator|developer|global [--out-dir <path>] [--wiki-root <path>] [--json]
  openwiki [--root <path>] agent configure --client opencode|generic [--transport stdio|http] [--server-url URL] [--tools read|proposal|write] [--token-env ENV|--token-file path|--create-token --token-out path] [--config-out path] [--json]

Generates provider-neutral agent and MCP configuration. Store service-account tokens in files or environment variables, never command-line flags.`,
  mcp: `OpenWiki MCP

Usage:
  openwiki [--root <path>] mcp install opencode|generic --mode read|proposal|write [--output path] [--confirm-write-tools] [--json]
  openwiki [--root <path>] mcp --stdio [--tools read|proposal|write] [--token-env ENV|--token-file path|--role role|--scope scope|--principal principal]

Use stdio MCP for local agents and Streamable HTTP MCP from the served wiki for hosted deployments. Proposal mode is the default for autonomous agents.`,
  deploy: `OpenWiki deploy

Usage:
  openwiki deploy profile list [--json]
  openwiki [--root <path>] deploy preflight [--deploy-profile local-personal|public-static|docker-private|hosted-enterprise|kubernetes-enterprise|aws-ecs-efs|gcp-gke|cloud-run-readmostly] [--public-origin URL] [--image image@sha256:...] [--out-dir public] [--json]

Runs deployment readiness checks. Production hosted profiles require digest-pinned images, auth boundary secrets, Postgres backends, backups, and restore rehearsal evidence.`,
  backup: `OpenWiki backup

Usage:
  openwiki [--root <path>] backup configure local --id destination-id --path <folder> [--keep-last N] [--keep-days N] [--json]
  openwiki [--root <path>] backup configure s3|minio|gcs|rclone ...
  openwiki [--root <path>] backup create|list|status|verify|rehearse|restore|prune ... [--json]

Backups are explicit destinations. Rehearse restores before trusting a destination and keep cloud credentials in environment-backed references.`,
  sync: `OpenWiki sync

Usage:
  openwiki [--root <path>] sync connect git --remote-url <url> --branch main [--remote origin] [--credential-ref ref] [--json]
  openwiki [--root <path>] sync status|check-remote|now|watch|enable|disable|repair [--json]

Sync connects a wiki to a Git remote for backup and collaboration. Dirty workspaces are not auto-pushed; commit or repair conflicts first.`,
  graph: `OpenWiki graph

Usage:
  openwiki [--root <path>] graph edges|neighbors <id>|backlinks <id>|related <id>|path <from> <to>|orphans|stale|report [--json] [--limit N] [--explain]

Graph report emits deterministic hubs, components, missing-link candidates, stale hubs, source coverage gaps, and suggested traversal questions for humans and agents. Use --explain with edge views to show explicit versus derived link provenance.`,
  dream: `OpenWiki dream

Usage:
  openwiki [--root <path>] dream run [phase...] [--phase phase] [--limit N] [--timeout-ms N] [--dry-run|--create-proposals] [--enqueue] [--actor actor:user:local] [--json]
  openwiki [--root <path>] dream status [run-id] [--limit N] [--json]
  openwiki [--root <path>] dream report [run-id] [--json]

Dream cycle runs deterministic maintenance phases over a wiki, records durable run/events, refreshes derived indexes, reports stale/orphan/thin/link candidates, and creates review proposals only when --create-proposals is explicit.`,
  "schema-pack": `OpenWiki schema-pack

Usage:
  openwiki [--root <path>] schema-pack list [--json]
  openwiki [--root <path>] schema-pack validate [path] [--schema-pack path-or-name] [--json]
  openwiki [--root <path>] schema-pack explain [--schema-pack path-or-name] [--json]
  openwiki schema-pack scaffold [name] [--out-dir folder] [--force] [--json]

Schema packs are YAML guidance contracts for record templates, required frontmatter, topic taxonomies, edge types, section defaults, proposal requirements, and validation rules. Resolution order is CLI flag, OPENWIKI_SCHEMA_PACK, repo config, workspace profile, bundled default, then no-pack fallback.`,
  proposal: `OpenWiki proposal

Usage:
  openwiki [--root <path>] proposal list|read|detail|diff|snapshot|validation <proposal-id> [--json]
  openwiki [--root <path>] proposal comment <proposal-id> --body-file <path> [--json]
  openwiki [--root <path>] proposal review <proposal-id> --decision accepted|rejected|needs_changes --rationale text [--json]
  openwiki [--root <path>] proposal apply <proposal-id> [--commit] [--message text] [--json]

Proposal commands are the governed write path for humans and agents. Review/apply requires reviewer or maintainer permissions for the affected Spaces.`,
  auth: `OpenWiki auth

Usage:
  openwiki [--root <path>] auth token create|list|inspect|revoke|rotate ...

Creates service-account tokens for agents, CI, and hosted clients. The token secret is shown once; OpenWiki stores hashes and redacts token metadata.`,
  spaces: `OpenWiki Spaces

Usage:
  openwiki [--root <path>] spaces list|read <section:id>|preview|create|edit-advanced sections|grants|approval-rules [--json]

Spaces are the human-facing permission model over policy sections, grants, and approval rules.`,
};

export function printCommandHelp(command?: string): void {
  console.log(commandHelpText(command));
}

export function commandHelpText(command?: string): string {
  if (command === undefined) {
    return MAIN_HELP;
  }
  const key = commandHelpKey(command);
  const text = key === undefined ? undefined : COMMAND_HELP[key];
  if (text !== undefined) {
    return text;
  }
  const fallback = commandUsageHelp(command);
  if (fallback === undefined) {
    throw new Error(`No command-scoped help is available for '${command}'. Run openwiki --help for the full command list.`);
  }
  return fallback;
}

function commandHelpKey(command: string): string | undefined {
  const normalized = command.trim();
  if (normalized === "publish" || normalized === "export") {
    return "deploy";
  }
  if (normalized === "policy") {
    return "spaces";
  }
  return Object.prototype.hasOwnProperty.call(COMMAND_HELP, normalized) ? normalized : undefined;
}

function commandUsageHelp(command: string): string | undefined {
  const normalized = command.trim();
  const usageLines = MAIN_HELP.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("openwiki ") && commandForUsageLine(line) === normalized);
  if (usageLines.length === 0) {
    return undefined;
  }
  return `OpenWiki ${normalized}\n\nUsage:\n${usageLines.map((line) => `  ${line}`).join("\n")}`;
}

function commandForUsageLine(line: string): string | undefined {
  const tokens = line.split(/\s+/).slice(1);
  while (tokens[0]?.startsWith("[") && tokens.length > 0) {
    const token = tokens.shift();
    if (token?.endsWith("]")) {
      break;
    }
    while (tokens.length > 0) {
      const optionalToken = tokens.shift();
      if (optionalToken?.endsWith("]")) {
        break;
      }
    }
  }
  return tokens[0];
}
