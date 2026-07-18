#!/usr/bin/env node
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebuildIndexStore } from "@openwiki/index-store";
import { createRun, executeRun } from "@openwiki/jobs";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import { exportStaticSite } from "@openwiki/static-export";
import {
  commentOnProposal,
  createWorkspaceBackup,
  proposeEdit,
  reviewProposal,
} from "@openwiki/workflows";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = path.join(REPO_ROOT, "artifacts", "enterprise-demo-wiki");
const DEMO_NOW = "2026-05-29T12:00:00.000Z";
const PUBLIC_SENTINEL = "enterprise-demo-public-knowledge-alpha";
const FINANCE_SENTINEL = "enterprise-demo-finance-private-bravo";
const HR_SENTINEL = "enterprise-demo-hr-private-charlie";
const EXEC_SENTINEL = "enterprise-demo-exec-private-delta";

export const ENTERPRISE_DEMO_SENTINELS = {
  public: PUBLIC_SENTINEL,
  finance: FINANCE_SENTINEL,
  hr: HR_SENTINEL,
  executive: EXEC_SENTINEL,
};

const POLICY_SECTIONS = [
  {
    id: "section:public-knowledge",
    title: "Public Knowledge",
    paths: ["wiki/public/**", "sources/manifests/public/**"],
    visibility: "public",
    owner_principal: "group:knowledge-admins",
    default_reviewers: ["group:knowledge-reviewers"],
    description: "Demo content safe for unauthenticated static export and public read paths.",
  },
  {
    id: "section:employee-handbook",
    title: "Employee Handbook",
    paths: ["wiki/engineering/**", "wiki/product/**", "wiki/support/**", "sources/manifests/engineering/**", "sources/manifests/product/**", "sources/manifests/support/**"],
    visibility: "internal",
    owner_principal: "group:knowledge-admins",
    default_reviewers: ["group:knowledge-reviewers"],
    description: "Internal content visible to authenticated employees and hosted read-mode agents.",
  },
  {
    id: "section:finance",
    title: "Finance Space",
    paths: ["wiki/finance/**", "sources/manifests/finance/**"],
    visibility: "private",
    owner_principal: "group:finance-admins",
    default_reviewers: ["group:finance-reviewers"],
    description: "Finance planning and forecast knowledge for finance maintainers.",
  },
  {
    id: "section:hr",
    title: "People Space",
    paths: ["wiki/hr/**", "sources/manifests/hr/**"],
    visibility: "private",
    owner_principal: "group:hr-admins",
    default_reviewers: ["group:hr-reviewers"],
    description: "People operations knowledge for HR maintainers.",
  },
  {
    id: "section:executive",
    title: "Executive Space",
    paths: ["wiki/executive/**", "sources/manifests/executive/**"],
    visibility: "private",
    owner_principal: "group:executive-admins",
    default_reviewers: ["group:executive-reviewers"],
    description: "Executive planning knowledge for restricted reviewers.",
  },
  {
    id: "section:platform-admin",
    title: "Platform Admin",
    paths: ["wiki/platform/**", "sources/manifests/platform/**"],
    visibility: "private",
    owner_principal: "group:platform-admins",
    default_reviewers: ["group:platform-admins"],
    description: "Operational control-plane knowledge for administrators.",
  },
];

const POLICY_GRANTS = [
  { principal: "group:all-users", section: "section:public-knowledge", role: "viewer" },
  { principal: "group:demo-contributors", section: "section:public-knowledge", role: "contributor" },
  { principal: "group:employees", section: "section:employee-handbook", role: "viewer" },
  { principal: "group:knowledge-reviewers", section: "section:employee-handbook", role: "reviewer" },
  { principal: "group:engineering", section: "section:employee-handbook", role: "maintainer" },
  { principal: "group:product", section: "section:employee-handbook", role: "maintainer" },
  { principal: "group:support", section: "section:employee-handbook", role: "maintainer" },
  { principal: "group:finance", section: "section:finance", role: "maintainer" },
  { principal: "group:finance-reviewers", section: "section:finance", role: "reviewer" },
  { principal: "group:hr", section: "section:hr", role: "maintainer" },
  { principal: "group:hr-reviewers", section: "section:hr", role: "reviewer" },
  { principal: "group:executive", section: "section:executive", role: "reviewer" },
  { principal: "group:platform-admins", section: "section:platform-admin", role: "admin" },
];

const POLICY_APPROVAL_RULES = [
  {
    id: "approval:public-knowledge",
    paths: ["wiki/public/**"],
    required_reviewers: [{ principal: "group:knowledge-reviewers", role: "reviewer" }],
    require_separate_actor: true,
  },
  {
    id: "approval:finance-space",
    paths: ["wiki/finance/**"],
    required_reviewers: [{ principal: "group:finance-reviewers", role: "reviewer" }],
    require_separate_actor: true,
  },
  {
    id: "approval:people-space",
    paths: ["wiki/hr/**"],
    required_reviewers: [{ principal: "group:hr-reviewers", role: "reviewer" }],
    require_separate_actor: true,
  },
  {
    id: "approval:executive-space",
    paths: ["wiki/executive/**"],
    required_reviewers: [{ principal: "group:executive-reviewers", role: "reviewer" }],
    require_separate_actor: true,
  },
];

const DEMO_PAGES = [
  {
    id: "page:public:company-handbook",
    path: "wiki/public/company-handbook.md",
    page_type: "public",
    title: "Company Handbook",
    summary: "Public-facing overview of how the demo company uses OpenWiki.",
    topics: ["company", "handbook", "public"],
    source_id: "source:public:handbook",
    claim_id: "claim:public:handbook",
    unique_term: PUBLIC_SENTINEL,
    sensitivity: "public",
    body: [
      "The company handbook introduces the OpenWiki enterprise demo and uses enterprise-demo-public-knowledge-alpha.",
      "",
      "Teams use [[Engineering Runbook]], [[Launch Readiness Plan]], and [[Customer Escalation Playbook]] for internal work. Restricted Spaces such as Finance, People, Executive, and Platform Admin are intentionally hidden from public static export.",
      "",
      "This page also includes a broken demo link to [Retired Partner Portal](retired-partner-portal.md) so governance detectors have a public broken-link fixture.",
    ].join("\n"),
  },
  {
    id: "page:engineering:runbook",
    path: "wiki/engineering/runbook.md",
    page_type: "engineering",
    title: "Engineering Runbook",
    summary: "Internal engineering incident and service ownership notes.",
    topics: ["engineering", "runbook", "internal"],
    source_id: "source:engineering:runbook",
    claim_id: "claim:engineering:runbook",
    unique_term: "enterprise-demo-engineering-internal-echo",
    sensitivity: "internal",
    body: "Engineering keeps service runbooks in OpenWiki so humans and agents can cite operational context before proposing changes. The internal sentinel is enterprise-demo-engineering-internal-echo.",
  },
  {
    id: "page:product:launch-readiness",
    path: "wiki/product/launch-readiness.md",
    page_type: "product",
    title: "Launch Readiness Plan",
    summary: "Internal product launch checklist and decision trail.",
    topics: ["product", "launch", "internal"],
    source_id: "source:product:launch-readiness",
    claim_id: "claim:product:launch-readiness",
    unique_term: "enterprise-demo-product-internal-foxtrot",
    sensitivity: "internal",
    body: "Product teams use launch readiness pages to connect decisions, risks, owners, and evidence. The internal sentinel is enterprise-demo-product-internal-foxtrot.",
  },
  {
    id: "page:support:escalation",
    path: "wiki/support/customer-escalation.md",
    page_type: "support",
    title: "Customer Escalation Playbook",
    summary: "Internal customer support escalation guidance.",
    topics: ["support", "customers", "internal"],
    source_id: "source:support:escalation",
    claim_id: "claim:support:escalation",
    unique_term: "enterprise-demo-support-internal-golf",
    sensitivity: "internal",
    body: "Support teams use this playbook to decide when agents may summarize customer context and when humans must review proposed changes. The internal sentinel is enterprise-demo-support-internal-golf.",
  },
  {
    id: "page:finance:forecast",
    path: "wiki/finance/forecast.md",
    page_type: "finance",
    title: "Finance Forecast",
    summary: "Private finance forecast fixture for permission checks.",
    topics: ["finance", "forecast", "private"],
    source_id: "source:finance:forecast",
    claim_id: "claim:finance:forecast",
    unique_term: FINANCE_SENTINEL,
    sensitivity: "private",
    body: "Finance forecast content uses enterprise-demo-finance-private-bravo and must not appear in public search, public static export, or unauthorized MCP read paths.",
  },
  {
    id: "page:hr:benefits",
    path: "wiki/hr/benefits.md",
    page_type: "hr",
    title: "People Benefits",
    summary: "Private HR benefits fixture for Spaces checks.",
    topics: ["people", "benefits", "private"],
    source_id: "source:hr:benefits",
    claim_id: "claim:hr:benefits",
    unique_term: HR_SENTINEL,
    sensitivity: "private",
    body: "People operations content uses enterprise-demo-hr-private-charlie and is available only to HR reviewers and maintainers.",
  },
  {
    id: "page:executive:roadmap",
    path: "wiki/executive/roadmap.md",
    page_type: "executive",
    title: "Executive Roadmap",
    summary: "Private executive roadmap fixture for proposal and static-export filtering.",
    topics: ["executive", "strategy", "private"],
    source_id: "source:executive:roadmap",
    claim_id: "claim:executive:roadmap",
    unique_term: EXEC_SENTINEL,
    sensitivity: "private",
    body: "Executive roadmap content uses enterprise-demo-exec-private-delta and is intentionally restricted to executive reviewers.",
  },
  {
    id: "page:platform:incident-controls",
    path: "wiki/platform/incident-controls.md",
    page_type: "platform",
    title: "Platform Incident Controls",
    summary: "Private platform-admin control-plane fixture.",
    topics: ["platform", "security", "private"],
    source_id: "source:platform:incident-controls",
    claim_id: "claim:platform:incident-controls",
    unique_term: "enterprise-demo-platform-private-hotel",
    sensitivity: "private",
    body: "Platform administrators use this page to verify that admin-only knowledge is kept out of general search and static export.",
  },
  {
    id: "page:product:orphan-idea",
    path: "wiki/product/orphan-idea.md",
    page_type: "product",
    title: "Orphan Product Idea",
    summary: "Internal orphan page fixture for governance detectors.",
    topics: ["product", "governance"],
    source_id: "source:product:orphan-idea",
    claim_id: "claim:product:orphan-idea",
    unique_term: "enterprise-demo-orphan-internal-india",
    sensitivity: "internal",
    body: "This intentionally unlinked page gives governance detectors an orphan page to report in the enterprise demo corpus.",
  },
];

export async function generateEnterpriseDemoWiki(input = {}) {
  const root = path.resolve(input.root ?? DEFAULT_ROOT);
  await prepareRoot(root, input.force === true);
  await createWorkspace(root, { title: "OpenWiki Enterprise Demo", template: "team-wiki" });
  await resetGeneratedWorkspace(root);
  await writePolicy(root);
  await writePagesAndSources(root);
  await writeClaims(root);

  const publicProposal = await proposeEdit({
    root,
    pageId: "page:public:company-handbook",
    actorId: "actor:agent:proposal-demo",
    rationale: "Agent proposes a clearer public demo summary.",
    body: "# Company Handbook\n\nThe public handbook demonstrates search, citation, proposals, history, and public static export for OpenWiki teams.\n",
  });
  await commentOnProposal({
    root,
    proposalId: publicProposal.proposal.id,
    actorId: "actor:user:knowledge-reviewer",
    body: "The proposal is scoped to public content and is ready for review.",
  });

  const financeProposal = await proposeEdit({
    root,
    pageId: "page:finance:forecast",
    actorId: "actor:agent:finance-assistant",
    rationale: "Finance assistant proposes a restricted forecast clarification.",
    body: "# Finance Forecast\n\nPrivate forecast update for " + FINANCE_SENTINEL + ".\n",
  });

  const acceptedProposal = await proposeEdit({
    root,
    pageId: "page:support:escalation",
    actorId: "actor:user:support-maintainer",
    rationale: "Support lead clarifies escalation ownership.",
    body: "# Customer Escalation Playbook\n\nSupport teams use this playbook to decide when agents may summarize customer context, when humans must review proposed changes, and who owns the escalation handoff.\n",
  });
  const acceptedDecision = await reviewProposal({
    root,
    proposalId: acceptedProposal.proposal.id,
    decision: "accepted",
    actorId: "actor:user:knowledge-reviewer",
    rationale: "The support escalation clarification is valid and scoped.",
  });

  const lintRun = await createRun({
    root,
    runType: "lint",
    actorId: "actor:system:enterprise-demo",
    input: { corpus: "enterprise-demo" },
  });
  const executedRun = await executeRun({ root, runId: lintRun.id, workerId: "actor:system:enterprise-demo-worker" });

  if (input.withDerived === true) {
    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);
  }

  let staticExport;
  if (input.withStatic === true) {
    staticExport = await exportStaticSite({
      root,
      outDir: input.staticOutDir ?? "public",
      baseUrl: input.baseUrl ?? "https://example.com/openwiki-enterprise-demo",
    });
  }

  let backup;
  if (input.withBackup === true) {
    backup = await createWorkspaceBackup({
      root,
      outDir: input.backupOutDir ?? "backups",
      actorId: "actor:user:demo-owner",
    });
  }

  const repo = await loadRepository(root);
  return {
    root,
    title: repo.config.title,
    page_ids: DEMO_PAGES.map((page) => page.id),
    source_ids: DEMO_PAGES.map((page) => page.source_id),
    claim_ids: DEMO_PAGES.map((page) => page.claim_id),
    proposal_ids: [publicProposal.proposal.id, financeProposal.proposal.id, acceptedProposal.proposal.id],
    open_proposal_ids: [publicProposal.proposal.id, financeProposal.proposal.id],
    decision_ids: [acceptedDecision.decision.id],
    run_ids: [executedRun.run.id],
    event_count: repo.events.length,
    spaces: POLICY_SECTIONS.map((section) => ({ id: section.id, title: section.title, visibility: section.visibility })),
    sentinels: ENTERPRISE_DEMO_SENTINELS,
    governance_fixtures: {
      stale_claim: "claim:product:launch-readiness",
      missing_source_page: "page:public:company-handbook",
      broken_link_page: "page:public:company-handbook",
      orphan_page: "page:product:orphan-idea",
    },
    artifacts: {
      ...(staticExport === undefined ? {} : { static_out_dir: staticExport.outDir, static_file_count: staticExport.files.length }),
      ...(backup === undefined ? {} : { backup_dir: backup.backup_dir }),
    },
  };
}

async function prepareRoot(root, force) {
  assertSafeOutputRoot(root);
  const exists = await pathExists(root);
  if (!exists) {
    await mkdir(root, { recursive: true });
    return;
  }
  if (!force) {
    throw new Error(`Output root already exists: ${root}. Pass --force to replace it.`);
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

function assertSafeOutputRoot(root) {
  const resolved = path.resolve(root);
  const forbidden = new Set([REPO_ROOT, path.dirname(REPO_ROOT), os.homedir(), os.tmpdir(), path.parse(resolved).root]);
  if (forbidden.has(resolved)) {
    throw new Error(`Refusing to use unsafe enterprise demo output root: ${resolved}`);
  }
  const relativeToRepo = path.relative(REPO_ROOT, resolved);
  if (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo) && relativeToRepo.split(path.sep).length < 2) {
    throw new Error(`Refusing to replace broad repository directory: ${resolved}`);
  }
}

async function resetGeneratedWorkspace(root) {
  for (const relativePath of ["wiki", "sources", "claims", "proposals", "decisions", "events", "runs", "policy", ".openwiki"]) {
    await rm(path.join(root, relativePath), { recursive: true, force: true });
  }
  for (const relativePath of ["wiki", "sources/manifests", "claims", "proposals", "decisions", "events", "runs", "policy"]) {
    await mkdir(path.join(root, relativePath), { recursive: true });
  }
}

async function writePolicy(root) {
  await writeJson(root, "policy/sections.json", POLICY_SECTIONS);
  await writeJson(root, "policy/grants.json", POLICY_GRANTS);
  await writeJson(root, "policy/approval-rules.json", POLICY_APPROVAL_RULES);
}

async function writePagesAndSources(root) {
  for (const page of DEMO_PAGES) {
    await writePage(root, page);
    await writeSource(root, page);
  }
}

async function writePage(root, page) {
  await mkdir(path.dirname(path.join(root, page.path)), { recursive: true });
  await writeFile(
    path.join(root, page.path),
    [
      "---",
      `id: ${page.id}`,
      `type: ${page.page_type}`,
      `title: ${page.title}`,
      `summary: ${page.summary}`,
      "status: draft",
      `sensitivity: ${page.sensitivity}`,
      "topics:",
      ...page.topics.map((topic) => `  - ${topic}`),
      "source_ids:",
      `  - ${page.source_id}`,
      "claim_ids:",
      `  - ${page.claim_id}`,
      `created_at: ${DEMO_NOW}`,
      `updated_at: ${DEMO_NOW}`,
      "---",
      "",
      `# ${page.title}`,
      "",
      page.body,
      "",
    ].join("\n"),
  );
}

async function writeSource(root, page) {
  const sourcePath = `sources/manifests/${page.page_type}/${page.source_id.replace(/^source:/, "").replace(/:/g, "-")}.yaml`;
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(
    path.join(root, sourcePath),
    [
      `id: ${page.source_id}`,
      `title: ${page.title} Source`,
      "source_type: manual",
      `retrieved_at: ${DEMO_NOW}`,
      `content_hash: sha256:${page.unique_term}`,
      "trust:",
      "  reliability: high",
      `  sensitivity: ${page.sensitivity === "public" ? "public" : page.sensitivity === "internal" ? "internal" : "private"}`,
      "",
    ].join("\n"),
  );
}

async function writeClaims(root) {
  const claims = DEMO_PAGES.map((page) => ({
    id: page.claim_id,
    uri: "openwiki://claim/" + page.claim_id.replace(/^claim:/, "").replace(/:/g, "/"),
    type: "claim",
    text: `${page.title} is part of the OpenWiki enterprise demo corpus and uses ${page.unique_term}.`,
    page_id: page.id,
    source_ids: page.id === "page:public:company-handbook" ? [] : [page.source_id],
    confidence: "high",
    risk: page.sensitivity === "public" ? "low" : "high",
    status: page.id === "page:product:launch-readiness" ? "stale" : "active",
    last_verified_at: page.id === "page:product:launch-readiness" ? "2025-01-01T00:00:00.000Z" : DEMO_NOW,
  }));
  await writeFile(path.join(root, "claims", "claim-index.jsonl"), claims.map((claim) => JSON.stringify(claim)).join("\n") + "\n");
}

async function writeJson(root, relativePath, value) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value, null, 2) + "\n");
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    force: false,
    withDerived: false,
    withStatic: false,
    withBackup: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--root") {
      options.root = requireValue(argv, index, "--root");
      index += 1;
      continue;
    }
    if (value === "--force") {
      options.force = true;
      continue;
    }
    if (value === "--with-derived") {
      options.withDerived = true;
      continue;
    }
    if (value === "--with-static") {
      options.withStatic = true;
      continue;
    }
    if (value === "--with-backup") {
      options.withBackup = true;
      continue;
    }
    if (value === "--base-url") {
      options.baseUrl = requireValue(argv, index, "--base-url");
      index += 1;
      continue;
    }
    if (value === "--static-out-dir") {
      options.staticOutDir = requireValue(argv, index, "--static-out-dir");
      index += 1;
      continue;
    }
    if (value === "--backup-out-dir") {
      options.backupOutDir = requireValue(argv, index, "--backup-out-dir");
      index += 1;
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      console.log("Usage: pnpm demo:enterprise -- --root artifacts/enterprise-demo-wiki --force [--with-derived] [--with-static] [--with-backup] [--json]");
      process.exit(0);
    }
    throw new Error(`Unknown option '${value}'`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await generateEnterpriseDemoWiki(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`OpenWiki enterprise demo generated at ${report.root}`);
  console.log(`Pages: ${report.page_ids.length}; sources: ${report.source_ids.length}; claims: ${report.claim_ids.length}; proposals: ${report.proposal_ids.length}`);
  if (report.artifacts.static_out_dir) {
    console.log(`Static export: ${report.artifacts.static_out_dir}`);
  }
  if (report.artifacts.backup_dir) {
    console.log(`Backup: ${report.artifacts.backup_dir}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
