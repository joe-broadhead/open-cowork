import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

test("README references existing local spec documents", async () => {
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const referencedSpecs = [
    ...readme.matchAll(/`(docs\/spec\/[^`]+)`/g),
  ].map((match) => match[1]).filter((value): value is string => value !== undefined);

  assert.ok(referencedSpecs.includes("docs/spec/openwiki-protocol-v0.1.md"));
  for (const specPath of referencedSpecs) {
    await access(path.join(process.cwd(), specPath));
  }
});

test("MkDocs site has a strict public-release documentation scaffold", async () => {
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /site_name:\s*(OpenWiki|Wiki \(Open Cowork\))/);
  assert.match(mkdocs, /strict: true/);
  assert.match(mkdocs, /theme:\n  name: material/);
  assert.match(mkdocs, /  - minify:/);
  assert.match(mkdocs, /getting-started\/quickstart\.md/);
  assert.match(mkdocs, /getting-started\/first-user-path\.md/);
  assert.match(mkdocs, /reference\/distribution\.md/);
  assert.match(mkdocs, /reference\/command-inventory\.md/);
  assert.match(mkdocs, /reference\/schemas\.md/);
  assert.match(mkdocs, /reference\/package-apis\.md/);
  assert.match(mkdocs, /reference\/errors\.md/);
  assert.match(mkdocs, /reference\/compatibility\.md/);
  assert.match(mkdocs, /deployment\/operations\.md/);
  assert.match(mkdocs, /deployment\/operations\/matrix\.md/);
  assert.match(mkdocs, /development\/public-release-docs-checklist\.md/);
  assert.match(mkdocs, /spec\/openwiki-protocol-v0\.1\.md/);
  assert.match(mkdocs, /adr\/0009-pglite-local-runtime-spike\.md/);
  assert.match(mkdocs, /security\/threat-model\.md/);
  assert.match(mkdocs, /javascripts\/mermaid-loader\.js/);
  assert.doesNotMatch(mkdocs, /https:\/\/unpkg\.com\/mermaid/);
  const mermaidLoader = await readFile(path.join(process.cwd(), "docs", "javascripts", "mermaid-loader.js"), "utf8");
  assert.match(mermaidLoader, /https:\/\/unpkg\.com\/mermaid@10\.9\.3\/dist\/mermaid\.min\.js/);
  assert.match(mermaidLoader, /integrity = "sha256-/);
  assert.doesNotMatch(mkdocs, /^  - Planning:/m);

  const requirements = await readFile(path.join(process.cwd(), "docs", "requirements.txt"), "utf8");
  assert.match(requirements, /mkdocs-material/);
  assert.match(requirements, /mkdocs-material>=9\.6\.23,<9\.7/);
  assert.match(requirements, /mkdocs-minify-plugin/);

  const gitignore = await readFile(path.join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /site\//);

  const navPages = [...mkdocs.matchAll(/: ([A-Za-z0-9_\-/.]+\.md)$/gm)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(navPages.includes("index.md"));
  for (const page of navPages) {
    await access(path.join(process.cwd(), "docs", page));
  }
});

test("command inventory maps CLI, HTTP, MCP, and web surfaces", async () => {
  const inventory = await readFile(path.join(process.cwd(), "docs", "reference", "command-inventory.md"), "utf8");
  for (const required of [
    "Coverage Matrix",
    "`pages list`",
    "`pages read`",
    "`pages search`",
    "`pages propose`",
    "`spaces list",
    "`spaces list/read/preview/create/edit-advanced`",
    "`deploy profile list`",
    "`openwiki upgrade`",
    "`openwiki self-check`",
    "`mcp install`",
    "Intentional Gaps",
    "JSON Stability",
    "wiki.propose_edit",
    "/api/v1/proposals",
    "Spaces & Permissions page",
    "Hosted deployments require an auth boundary",
  ]) {
    assert.match(inventory, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("active public docs stay within reviewable file-size bounds", async () => {
  const markdownFiles = await listMarkdownFiles(path.join(process.cwd(), "docs"));
  const oversized: string[] = [];
  for (const file of markdownFiles) {
    const relative = path.relative(process.cwd(), file);
    if (relative.startsWith("docs/archive/")) {
      continue;
    }
    const lineCount = (await readFile(file, "utf8")).split("\n").length;
    if (lineCount > 800) {
      oversized.push(`${relative}: ${lineCount}`);
    }
  }
  assert.deepEqual(oversized, []);
});

test("public repository community files are present", async () => {
  const expectedFiles = [
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "SUPPORT.md",
    "AGENTS.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/ISSUE_TEMPLATE/docs_improvement.md",
    ".github/ISSUE_TEMPLATE/config.yml",
  ];

  for (const file of expectedFiles) {
    await access(path.join(process.cwd(), file));
  }
  const issueTemplateConfig = await readFile(path.join(process.cwd(), ".github", "ISSUE_TEMPLATE", "config.yml"), "utf8");
  assert.match(issueTemplateConfig, /blank_issues_enabled: false/);
  for (const template of ["bug_report.md", "feature_request.md", "docs_improvement.md"]) {
    const body = await readFile(path.join(process.cwd(), ".github", "ISSUE_TEMPLATE", template), "utf8");
    assert.match(body, /Suspected security vulnerabilities must not be posted in public issues/);
  }

  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /Quick Start/);
  assert.match(readme, /Release Status/);
  assert.match(readme, /docs\/development\/release\.md/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(readme, /SUPPORT\.md/);
  assert.match(readme, /CODE_OF_CONDUCT\.md/);
  assert.match(readme, /CHANGELOG\.md/);

  const docsHome = await readFile(path.join(process.cwd(), "docs", "index.md"), "utf8");
  assert.match(docsHome, /deployment\/operations\/matrix\.md/);
  assert.match(docsHome, /SUPPORT\.md/);
  assert.match(docsHome, /SECURITY\.md/);
  assert.match(docsHome, /CODE_OF_CONDUCT\.md/);
  assert.match(docsHome, /CHANGELOG\.md/);
});

test("release docs and public config avoid stale documentation regressions", async () => {
  const contributing = await readFile(path.join(process.cwd(), "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /Node\.js `>=22\.22\.3`/);
  assert.match(contributing, /pnpm docs:build/);
  assert.match(contributing, /\/opt\/homebrew\/bin/);
  assert.doesNotMatch(contributing, />=22\.5/);

  const dockerignore = await readFile(path.join(process.cwd(), ".dockerignore"), "utf8");
  assert.doesNotMatch(dockerignore, /!\.env\.example/);

  const protocol = [
    await readFile(path.join(process.cwd(), "docs", "spec", "openwiki-protocol-v0.1.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "spec", "protocol", "operation-contract.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "spec", "protocol", "mcp.md"), "utf8"),
  ].join("\n");
  assert.match(protocol, /Status: Accepted for OpenWiki v0\.0\.0/);
  for (const operation of [
    "wiki.detect_governance",
    "wiki.graph_neighbors",
    "wiki.graph_backlinks",
    "wiki.graph_related",
    "wiki.graph_path",
    "wiki.graph_orphans",
    "wiki.graph_stale",
    "wiki.graph_report",
  ]) {
    assert.match(protocol, new RegExp("`" + operation.replace(".", "\\.") + "`"));
  }

  const releaseTemplate = await readFile(path.join(process.cwd(), "docs", "development", "release-notes-template.md"), "utf8");
  assert.doesNotMatch(releaseTemplate, /`compose-private`/);
  assert.match(releaseTemplate, /Docker Compose config is validated as this profile's local\/trusted-network variant/);
  assert.match(releaseTemplate, /Security Posture/);
  assert.match(releaseTemplate, /docs\/security\/threat-model\.md/);
  assert.match(releaseTemplate, /pnpm test:security/);
  assert.match(releaseTemplate, /pnpm audit --audit-level high/);

  // The docs/archive private-era roadmap snapshots were removed before the
  // public release (their history lives in the private archive repository),
  // so no archive-content regression guards remain.

  const proposals = await readFile(path.join(process.cwd(), "docs", "guides", "proposals.md"), "utf8");
  assert.match(proposals, /CLI Examples/);
  assert.match(proposals, /Agent Access/);
  assert.match(proposals, /Review Semantics/);

  const troubleshooting = await readFile(path.join(process.cwd(), "docs", "troubleshooting.md"), "utf8");
  assert.match(troubleshooting, /\[installation guide\]/);
  assert.match(troubleshooting, /\[Docker private profile\]/);

  const install = await readFile(path.join(process.cwd(), "docs", "getting-started", "installation.md"), "utf8");
  assert.match(install, /release-day artifacts/);
  assert.match(install, /npm install -g \.\/artifacts\/npm\/openwiki-cli-0\.0\.0\.tgz/);
  assert.match(install, /npm install -g @openwiki\/cli@0\.0\.0/);

  const checklist = await readFile(path.join(process.cwd(), "docs", "development", "public-release-docs-checklist.md"), "utf8");
  for (const required of [
    "Distribution Clarity",
    "Navigation Hygiene",
    "Community And Reporting Paths",
    "Enterprise And Deployment Claims",
    "Ownership And Review",
    "pnpm docs:reference -- --check",
  ]) {
    assert.match(checklist, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("agent docs cover personal wiki proposal-mode smoke testing", async () => {
  const agentGuide = await readFile(path.join(process.cwd(), "docs", "guides", "mcp-and-agents.md"), "utf8");
  assert.match(agentGuide, /Tool Modes/);
  assert.match(agentGuide, /Personal Wiki Agent Smoke Test/);
  assert.match(agentGuide, /--template personal-wiki/);
  assert.match(agentGuide, /db rebuild/);
  assert.match(agentGuide, /"openwiki",\n        "--root"/);
  assert.match(agentGuide, /CONTRIBUTING\.md/);
  assert.match(agentGuide, /--tools",\n        "proposal"/);
  assert.match(agentGuide, /Do not start with `--tools write`/);
  assert.match(agentGuide, /OpenCode Pack/);
  assert.match(agentGuide, /openwiki-meeting-curator/);
  assert.match(agentGuide, /openwiki-transcript-inbox/);
  assert.match(agentGuide, /opencode\.hosted-http-proposal\.json/);
  assert.match(agentGuide, /Service Account Tokens/);
  assert.match(agentGuide, /auth token create/);
  assert.match(agentGuide, /auth token rotate service:proposal-agent/);
  assert.match(agentGuide, /auth token revoke service:proposal-agent/);
  assert.match(agentGuide, /--transport http/);
  assert.match(agentGuide, /OPENWIKI_PROPOSAL_TOKEN/);
  assert.match(agentGuide, /Output Bounds/);
  assert.match(agentGuide, /OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES/);
  assert.match(agentGuide, /Rate Limits/);
});

test("inbox and hosted agent docs cover release-gated orchestration flows", async () => {
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /guides\/hosted-inbox-agents\.md/);

  const inbox = await readFile(path.join(process.cwd(), "docs", "guides", "inbox.md"), "utf8");
  assert.match(inbox, /Hosted Inbox Agents/);

  const hosted = await readFile(path.join(process.cwd(), "docs", "guides", "hosted-inbox-agents.md"), "utf8");
  for (const required of [
    "Per-User Inbox",
    "Shared Space Inbox",
    "inbox-submitter",
    "proposal-agent",
    "inbox-curator",
    "Streamable HTTP MCP",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres",
    "OPENWIKI_RATE_LIMIT_MCP",
    "Cloud Run",
    "Kubernetes",
    "Docker",
    "prompt-injection",
    "pnpm eval:inbox-agents",
  ]) {
    assert.match(hosted, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const release = await readFile(path.join(process.cwd(), "docs", "development", "release.md"), "utf8");
  assert.match(release, /Inbox agent orchestration/);
  assert.match(release, /pnpm eval:inbox-agents/);
  assert.match(release, /openwiki\.inbox_agent_evals\.v1/);

  const threatModel = await readFile(path.join(process.cwd(), "docs", "security", "threat-model.md"), "utf8");
  assert.match(threatModel, /Inbox Payloads And Agent Orchestration/);
  assert.match(threatModel, /Submitting to another `owner_actor_id` requires `wiki:inbox:admin`/);

  const evalReadme = await readFile(path.join(process.cwd(), "evals", "inbox-agent-orchestration", "README.md"), "utf8");
  assert.match(evalReadme, /openwiki\.inbox_agent_evals\.v1/);
  assert.match(evalReadme, /provider_failure/);
  assert.match(evalReadme, /prompt-injection transcript handling/);
});

test("first-user path covers local, hosted, UI, auth, and agent onboarding", async () => {
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /First User Path: getting-started\/first-user-path\.md/);

  const home = await readFile(path.join(process.cwd(), "docs", "index.md"), "utf8");
  assert.match(home, /first-user path/i);

  const quickstart = await readFile(path.join(process.cwd(), "docs", "getting-started", "quickstart.md"), "utf8");
  assert.match(quickstart, /First User Path/);

  const guide = await readFile(path.join(process.cwd(), "docs", "getting-started", "first-user-path.md"), "utf8");
  for (const section of [
    "Start Locally",
    "Walk The Human UI",
    "Connect A Local Agent",
    "Choose Hosted Deployment",
    "Add The Auth Boundary",
    "Configure Hosted Agents",
    "Set Rate Limits By Profile",
    "Done Checklist",
  ]) {
    assert.match(guide, new RegExp("## (?:[0-9]+\\. )?" + section));
  }

  for (const required of [
    "openwiki setup personal",
    "--stdio",
    "--tools",
    "proposal",
    "Search",
    "Read",
    "Propose",
    "History",
    "Spaces & Permissions",
    "top bar identity",
    "chip shows",
    "deploy/proxy/nginx-oauth2-proxy.conf",
    "oauth2-proxy + nginx",
    "Cloudflare Access",
    "Google IAP",
    "Cloud Run",
    "AWS ALB OIDC",
    "Docker And Compose",
    "Kubernetes And Helm",
    "GCP",
    "OPENWIKI_PUBLIC_ORIGIN",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres",
    "OPENWIKI_RATE_LIMIT_ENABLED=1",
    "auth token create",
    "agent configure",
    "--transport http",
  ]) {
    assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("production operations docs cover hosted deployment runbooks", async () => {
  const operations = [
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "write-coordination.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "backup-restore.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "postgres-and-workers.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "upgrades.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "incidents.md"), "utf8"),
  ].join("\n");
  assert.match(operations, /Production Boundary/);
  assert.match(operations, /Preflight Checklist/);
  assert.match(operations, /Runtime Topology/);
  assert.match(operations, /OPENWIKI_PUBLIC_ORIGIN/);
  assert.match(operations, /OPENWIKI_QUEUE_BACKEND=postgres/);
  assert.match(operations, /OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres/);
  assert.match(operations, /write_leases/);
  assert.match(operations, /write-in-progress/);
  assert.match(operations, /Backup And Restore/);
  assert.match(operations, /pg_dump/);
  assert.match(operations, /Rebuilds And Migrations/);
  assert.match(operations, /openwiki --root \/data\/wiki db rebuild --json/);
  assert.match(operations, /openwiki --root \/data\/wiki-restore db rebuild --json/);
  assert.match(operations, /Workers And Queues/);
  assert.match(operations, /Upgrade sequence/);
  assert.match(operations, /Incident Playbooks/);
});

test("deployment profile docs cover supported paths and caveats", async () => {
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /deployment\/profiles\.md/);

  const profiles = await readFile(path.join(process.cwd(), "docs", "deployment", "profiles.md"), "utf8");
  const requiredProfiles = new Map([
    ["local-personal", "local-personal.md"],
    ["public-static", "public-static.md"],
    ["docker-private", "docker-compose.md"],
    ["kubernetes-enterprise", "kubernetes-helm.md"],
    ["aws-ecs-efs", "aws.md"],
    ["gcp-gke", "gcp.md"],
    ["cloud-run-readmostly", "cloud-run.md"],
  ]);
  const focusedProfiles = [];
  for (const [profile, file] of requiredProfiles) {
    const section = await readFile(path.join(process.cwd(), "docs", "deployment", "profiles", file), "utf8");
    focusedProfiles.push(section);
    assert.match(profiles, new RegExp("`" + profile + "`"));
    assert.match(section, /## Quickstart/);
    assert.match(section, /## Preflight/);
    assert.match(section, /## Security Notes/);
    assert.match(section, /## Readiness Checks/);
    assert.match(section, /## Backup And Restore/);
    assert.match(section, /## Rollback/);
    assert.match(section, /## MCP/);
  }
  const hostedProfile = await readFile(path.join(process.cwd(), "docs", "deployment", "hosted-human-agent.md"), "utf8");
  assert.match(profiles, /`hosted-enterprise`/);
  assert.match(profiles, /hosted-human-agent\.md/);
  assert.match(hostedProfile, /Hosted Humans And Agents/);
  assert.match(hostedProfile, /openwiki --root \/data\/wiki deploy preflight/);
  assert.match(hostedProfile, /--deploy-profile hosted-enterprise/);
  const allProfileDocs = [profiles, ...focusedProfiles].join("\n");
  const dockerProfile = await readFile(path.join(process.cwd(), "docs", "deployment", "profiles", "docker-compose.md"), "utf8");
  const kubernetesProfile = await readFile(path.join(process.cwd(), "docs", "deployment", "profiles", "kubernetes-helm.md"), "utf8");

  assert.match(allProfileDocs, /source checkout|pnpm install/);
  assert.match(allProfileDocs, /stdio MCP/);
  assert.match(allProfileDocs, /loopback/);
  assert.match(allProfileDocs, /static export/);
  assert.match(allProfileDocs, /no server writes/);
  assert.match(allProfileDocs, /optional Postgres|Postgres/);
  assert.match(allProfileDocs, /object storage/);
  assert.match(allProfileDocs, /worker/);
  assert.match(allProfileDocs, /ALB OIDC/);
  assert.match(allProfileDocs, /Workload Identity/);
  assert.match(allProfileDocs, /Cloud Storage FUSE is not POSIX Git storage/);
  assert.match(allProfileDocs, /preview\/demo\/read-mostly/i);
  assert.match(dockerProfile, /--profile backup run --rm openwiki-backup/);
  assert.doesNotMatch(dockerProfile, /--profile backups/);
  assert.match(kubernetesProfile, /deploy\/helm\/openwiki\/examples\/enterprise-values\.yaml/);
  assert.match(kubernetesProfile, /claimName":"openwiki-workspace-backups"/);
  assert.doesNotMatch(kubernetesProfile, /claimName":"openwiki-backups"/);
});

test("SSO auth boundary docs cover trusted headers, providers, and threat model", async () => {
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /deployment\/auth-boundaries\.md/);
  assert.match(mkdocs, /deployment\/hosted-human-agent\.md/);
  assert.match(mkdocs, /deployment\/identity-mapping\.md/);

  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /docs\/deployment\/hosted-human-agent\.md/);

  const overview = await readFile(path.join(process.cwd(), "docs", "deployment", "overview.md"), "utf8");
  assert.match(overview, /hosted-human-agent\.md/);

  const release = await readFile(path.join(process.cwd(), "docs", "development", "release.md"), "utf8");
  assert.match(release, /docs\/deployment\/hosted-human-agent\.md/);

  const auth = await readFile(path.join(process.cwd(), "docs", "deployment", "auth-boundaries.md"), "utf8");
  assert.match(auth, /x-openwiki-actor/);
  assert.match(auth, /x-openwiki-role/);
  assert.match(auth, /x-openwiki-scopes/);
  assert.match(auth, /x-openwiki-principals/);
  assert.match(auth, /x-openwiki-groups/);
  assert.match(auth, /x-openwiki-proxy-secret/);
  assert.match(auth, /OPENWIKI_TRUST_AUTH_HEADERS_SECRET/);
  assert.match(auth, /strip(?:s|ping)? untrusted|strip all inbound/i);
  assert.match(auth, /OPENWIKI_PUBLIC_ORIGIN/);
  assert.match(auth, /OPENWIKI_TRUST_AUTH_HEADERS/);
  assert.match(auth, /OPENWIKI_TRUST_PROXY_ORIGIN/);
  assert.match(auth, /OPENWIKI_TRUST_PROXY_ORIGIN_SECRET/);
  assert.match(auth, /identity chip/);
  assert.match(auth, /same-origin/);
  assert.match(auth, /service-account bearer tokens/);
  assert.match(auth, /oauth2-proxy/);
  assert.match(auth, /Envoy/);
  assert.match(auth, /Cloudflare Access/);
  assert.match(auth, /Google IAP/);
  assert.match(auth, /Cloud Run/);
  assert.match(auth, /AWS ALB OIDC/);
  assert.match(auth, /generic OIDC/i);
  assert.match(auth, /group:all-users` means authenticated users/);
  assert.match(auth, /Threat Model/);
  assert.match(auth, /clients can reach OpenWiki without passing through the auth proxy/);

  const hosted = await readFile(path.join(process.cwd(), "docs", "deployment", "hosted-human-agent.md"), "utf8");
  for (const required of [
    "OpenWiki does not implement native username/password login",
    "organization SSO",
    "Streamable HTTP MCP",
    "service-account bearer tokens",
    "x-openwiki-proxy-secret",
    "OPENWIKI_TRUST_AUTH_HEADERS_SECRET",
    "OPENWIKI_TRUST_PROXY_ORIGIN_SECRET",
    "OPENWIKI_PUBLIC_ORIGIN",
    "CSRF",
    "same-origin",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres",
    "OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES",
    "OPENWIKI_RATE_LIMIT_MCP",
    "Cloud Run",
    "Kubernetes",
    "Docker",
    "Local personal",
    "Do not expose a write-capable hosted OpenWiki directly to the public internet",
    "proxy secret mismatch",
    "Missing identity headers",
    "Bad token scopes",
    "CORS/origin mismatch",
    "Rate limit exhaustion",
    "Missing persistent storage",
    "Manual checks",
  ]) {
    assert.match(hosted, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const identity = await readFile(path.join(process.cwd(), "docs", "deployment", "identity-mapping.md"), "utf8");
  assert.match(identity, /Actor/);
  assert.match(identity, /Group/);
  assert.match(identity, /Principal/);
  assert.match(identity, /Role/);
  assert.match(identity, /Scope/);
  assert.match(identity, /Service account/);
  assert.match(identity, /x-openwiki-groups/);
  assert.match(identity, /group:all-users` is always present/);
  assert.match(identity, /policy preview/);
  assert.match(identity, /OPENWIKI_TRUST_AUTH_HEADERS_SECRET/);
  assert.match(identity, /deploy preflight/);

  const operations = [
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs", "deployment", "operations", "backup-restore.md"), "utf8"),
  ].join("\n");
  assert.match(operations, /OPENWIKI_TRUST_PROXY_ORIGIN_SECRET/);
  assert.match(operations, /OPENWIKI_TOKEN/);
  assert.match(operations, /openwiki-postgres-backup/);
  assert.match(operations, /backup rehearse/);
  assert.match(operations, /backup restore latest[\s\S]*--dry-run/);
  assert.match(operations, /Recover the Git workspace|Restore or reclone the Git workspace/);
  assert.match(operations, /Recover object storage|Restore object storage/);
  assert.match(operations, /Recover Postgres|Restore Postgres/);
  assert.match(operations, /Restore service secrets|service secrets/);
  assert.match(operations, /RPO/);
  assert.match(operations, /RTO/);
  assert.match(operations, /\/readyz/);
  assert.match(operations, /\/mcp/);
  assert.match(operations, /pg_dump/);
  assert.match(operations, /rclone bridge/);

  const cloudBackups = await readFile(path.join(process.cwd(), "docs", "guides", "cloud-backups.md"), "utf8");
  assert.match(cloudBackups, /rclone Bridge/i);
  assert.match(cloudBackups, /backup configure rclone/);
  assert.match(cloudBackups, /backup adapter contract/);
  assert.match(cloudBackups, /ADR 0007/);

  const backupContract = await readFile(path.join(process.cwd(), "docs", "reference", "backup-adapter-contract.md"), "utf8");
  assert.match(backupContract, /Object Operations/);
  assert.match(backupContract, /manifest.json` is uploaded last/);
  assert.match(backupContract, /credential_state/);
  assert.match(backupContract, /tests\/support\/backup-adapter-conformance.ts/);
});

test("release docs distinguish personal testing from public release", async () => {
  const release = await readFile(path.join(process.cwd(), "docs", "development", "release.md"), "utf8");
  assert.match(release, /Current Release Contract/);
  assert.match(release, /Personal wiki with local agents \| Ready for private testing/);
  assert.match(release, /Supported Profile Table/);
  assert.match(release, /Release Validation Matrix/);
  assert.match(release, /local-personal` \| Supported/);
  assert.match(release, /public-static` \| Supported/);
  assert.match(release, /OpenWiki Release Validation/);
  assert.match(release, /pnpm release:smoke -- local-personal/);
  assert.match(release, /pnpm test:security/);
  assert.match(release, /pnpm audit --audit-level high/);
  assert.match(release, /pnpm eval:mcp-conformance/);
  assert.match(release, /pnpm eval:enterprise-demo -- --json/);
  assert.match(release, /docker compose -f deploy\/compose\/docker-compose\.yml config --quiet/);
  assert.match(release, /Release And Tag Checklist/);
  assert.match(release, /Public Announcement Checklist/);
  assert.match(release, /Dogfood And Private Validation Checklist/);
  assert.match(release, /openwiki db rebuild/);
  assert.match(release, /Do not expose a write-capable server directly to the internet/);

  const testing = await readFile(path.join(process.cwd(), "docs", "development", "testing.md"), "utf8");
  assert.match(testing, /pnpm docs:build/);
  assert.match(testing, /Heavyweight Evals/);
  assert.match(testing, /Run heavyweight evals serially/);

  const dogfood = await readFile(path.join(process.cwd(), "docs", "guides", "dogfood-and-demo-corpus.md"), "utf8");
  assert.match(dogfood, /openwiki setup personal/);
  assert.match(dogfood, /--transport stdio/);
  assert.match(dogfood, /proposal apply/);
  assert.match(dogfood, /backup restore/);
  assert.match(dogfood, /pnpm demo:enterprise/);
  assert.match(dogfood, /pnpm eval:enterprise-demo -- --json/);
  assert.match(dogfood, /OPENWIKI_UI_FIXTURE=enterprise-demo pnpm test:ui/);
  assert.match(dogfood, /OPENWIKI_SCREENSHOT_FIXTURE=enterprise-demo pnpm screenshots/);

  const template = await readFile(path.join(process.cwd(), "docs", "development", "release-notes-template.md"), "utf8");
  assert.match(template, /Supported Profiles/);
  assert.match(template, /Preview Profiles/);
  assert.match(template, /ghcr\.io\/joe-broadhead\/open-wiki@sha256:<digest>/);
  assert.match(template, /Cosign signature/);
  assert.match(template, /SBOM attestation/);
  assert.match(template, /Build provenance attestation/);
  assert.match(template, /local-personal/);
  assert.match(template, /public-static/);
  assert.match(template, /docker-private/);
});

test("module-size documented exceptions stay in sync with the gate", async () => {
  const script = await readFile(path.join(process.cwd(), "scripts", "openwiki-module-size-report.mjs"), "utf8");
  const moduleSizeDocs = await readFile(path.join(process.cwd(), "docs", "development", "module-size.md"), "utf8");
  const documentedExceptions = [...script.matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(documentedExceptions.length > 0);
  for (const relativePath of documentedExceptions) {
    assert.match(moduleSizeDocs, new RegExp(escapeRegExp("`" + relativePath + "`")));
  }
});

test("local transcript inbox dogfood guide documents the no-pnpm personal workflow", async () => {
  const guide = await readFile(path.join(process.cwd(), "docs", "guides", "local-transcript-inbox-dogfood.md"), "utf8");
  const mkdocs = await readFile(path.join(process.cwd(), "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /guides\/local-transcript-inbox-dogfood\.md/);
  for (const required of [
    "openwiki setup personal ~/OpenWiki/personal-wiki",
    "--agent opencode",
    "--tools proposal",
    "openwiki agent install",
    "opencode run --agent openwiki-meeting-curator",
    "service install inbox",
    "inbox watch",
    "proposal review",
    "proposal apply",
    "sync now",
    "backup rehearse",
    "fixtures/transcripts/acme-launch-sync.txt",
  ]) {
    assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(guide, /\bpnpm\b/);
  assert.match(guide, /Google Drive, iCloud Drive, Dropbox, and\s+OneDrive/);
});

test("user-facing docs use the packaged openwiki binary", async () => {
  const files = [
    "README.md",
    ...await listMarkdownFiles(path.join(process.cwd(), "docs", "getting-started")),
    ...await listMarkdownFiles(path.join(process.cwd(), "docs", "guides")),
    ...await listMarkdownFiles(path.join(process.cwd(), "docs", "deployment")),
    ...await listMarkdownFiles(path.join(process.cwd(), "docs", "reference")),
    ...await listMarkdownFiles(path.join(process.cwd(), "docs", "spec")),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const content = await readFile(absolute, "utf8");
    if (/pnpm openwiki/.test(content)) {
      offenders.push(path.relative(process.cwd(), absolute));
    }
  }
  assert.deepEqual(offenders, []);

  const contributing = await readFile(path.join(process.cwd(), "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /pnpm openwiki -- \.\.\./);
});

test("security docs define the public preview threat model and reporting SLA", async () => {
  const rootSecurity = await readFile(path.join(process.cwd(), "SECURITY.md"), "utf8");
  assert.match(rootSecurity, /security\/threat-model\.md/);
  assert.match(rootSecurity, /Response Targets/);
  assert.match(rootSecurity, /1 business day/);

  const security = await readFile(path.join(process.cwd(), "docs", "security.md"), "utf8");
  assert.match(security, /\[threat model\]\(security\/threat-model\.md\)/);
  assert.match(security, /Public unauthenticated content should use static export/);

  const threatModel = await readFile(path.join(process.cwd(), "docs", "security", "threat-model.md"), "utf8");
  for (const heading of [
    "Local Personal Mode",
    "Hosted Web And HTTP API",
    "HTTP MCP For Agents",
    "Source Fetching And Connectors",
    "Git, Object Storage, And Postgres",
    "Required Security Tests",
    "Supply-Chain Assurance",
    "Secret Scanning And Credential Refs",
    "Vulnerability Response SLA",
    "Preview Limitations",
  ]) {
    assert.match(threatModel, new RegExp(`## ${heading}|### ${heading}`));
  }
  for (const category of [
    "Path traversal",
    "Git option injection",
    "SSRF and DNS rebinding",
    "Trusted-header spoofing",
    "CSRF and origin checks",
    "Token leakage",
    "Oversized body/depth limits",
    "MCP auth denial",
  ]) {
    assert.match(threatModel, new RegExp(category));
  }
  assert.match(threatModel, /OPENWIKI_SECRET_CRED_DOCS_READER_<HASH>/);
  assert.match(threatModel, /Subresource Integrity hash/);
});

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listMarkdownFiles(resolved);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [resolved] : [];
    }),
  );
  return nested.flat();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
