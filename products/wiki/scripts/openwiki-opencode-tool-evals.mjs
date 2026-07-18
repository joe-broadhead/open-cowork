#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeOpenCodeEvalRecorderAvailability, resolveOpenCodeEvalRecorderPlugin } from "./opencode-tool-evals/recorder-discovery.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));
const MODEL = process.env.OPENWIKI_OPENCODE_MODEL || "opencode-go/kimi-k2.6";
const ACTOR_ID = "actor:agent:opencode-eval";
const MCP_ID = process.env.OPENWIKI_OPENCODE_MCP_ID || "openwiki-eval";
const ADMIN_PUBLISH_OUT_DIR = "eval-public";

const SCENARIOS = [
  {
    id: "read-research",
    agent: "openwiki-researcher",
    expectedTools: [
      "wiki.search",
      "wiki.ask",
      "wiki.read_page",
      "wiki.read_source",
      "wiki.read_claim",
      "wiki.trace_claim",
      "wiki.get_history",
      "wiki.diff_versions",
      "wiki.list_recent_changes",
      "wiki.list_topics",
      "wiki.list_open_questions",
      "wiki.graph_neighbors",
      "wiki.graph_backlinks",
      "wiki.graph_related",
      "wiki.graph_path",
      "wiki.graph_orphans",
      "wiki.graph_stale",
      "wiki.graph_report",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a tool coverage eval. Do not use bash and do not edit files directly.",
      "Call every one of these OpenWiki tools at least once: wiki.search, wiki.ask, wiki.read_page, wiki.read_source, wiki.read_claim, wiki.trace_claim, wiki.get_history, wiki.diff_versions, wiki.list_recent_changes, wiki.list_topics, wiki.list_open_questions, wiki.graph_neighbors, wiki.graph_backlinks, wiki.graph_related, wiki.graph_path, wiki.graph_orphans, wiki.graph_stale, wiki.graph_report.",
      "Use page:concept:personal-knowledge-base, source:2026-05-21-001, and claim:2026-05-21-001 where an ID is required. For graph_path use from_id page:concept:personal-knowledge-base and to_id source:2026-05-21-001.",
      "End with a concise coverage summary listing the tools you called.",
    ].join("\n"),
  },
  {
    id: "proposal-editing",
    agent: "openwiki-editor",
    expectedTools: [
      "wiki.propose_source",
      "wiki.propose_synthesis",
      "wiki.propose_edit",
      "wiki.list_proposals",
      "wiki.read_proposal",
      "wiki.read_proposal_detail",
      "wiki.comment_on_proposal",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a tool coverage eval. Do not use bash and do not edit files directly.",
      "Call every one of these OpenWiki tools at least once: wiki.propose_source, wiki.propose_synthesis, wiki.propose_edit, wiki.list_proposals, wiki.read_proposal, wiki.read_proposal_detail, wiki.comment_on_proposal.",
      "Use actor_id " + ACTOR_ID + ".",
      "For wiki.propose_edit, target page:concept:personal-knowledge-base and submit a valid body-only Markdown replacement that preserves the page meaning and adds one short eval sentence.",
      "For wiki.propose_source, use source_type webpage and URL https://example.com/openwiki-agent-eval.",
      "For wiki.propose_synthesis, create a short synthesis page titled Agent Tool Coverage Eval.",
      "After proposals are created, read one proposal normally and with detail, then comment on one open proposal.",
      "End with a concise coverage summary listing proposal IDs and tools you called.",
    ].join("\n"),
  },
  {
    id: "meeting-curator-inbox",
    agent: "openwiki-meeting-curator",
    expectedTools: [
      "wiki.inbox_submit",
      "wiki.inbox_list",
      "wiki.inbox_read",
      "wiki.inbox_process",
      "wiki.search",
      "wiki.propose_synthesis",
      "wiki.read_proposal_detail",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a tool coverage eval for transcript inbox curation. Do not use bash and do not edit files directly.",
      "Call every one of these OpenWiki tools at least once: wiki.inbox_submit, wiki.inbox_list, wiki.inbox_read, wiki.inbox_process, wiki.search, wiki.propose_synthesis, wiki.read_proposal_detail.",
      "Use actor_id " + ACTOR_ID + ".",
      "Submit one inbox item titled Eval Transcript Sync Meeting with kind meeting_transcript, provider transcript_file, adapter file, owner_actor_id " + ACTOR_ID + ", idempotency_key eval-transcript-sync-meeting, and transcript content saying: On 2026-05-31, Alice from Acme and Bob from OpenWiki discussed transcript import. Alice decided to send weekly exports. Bob owns documenting the sync workflow. The due date was not stated.",
      "List inbox items for owner_actor_id " + ACTOR_ID + ", read the submitted item with include_content true, then process it.",
      "Search for personal knowledge or existing transcript-derived pages before proposing new pages.",
      "Propose a short meeting synthesis page titled Eval Transcript Sync Meeting that cites the created source ID if available, preserves the unknown due date as an open question, and does not infer any unstated facts.",
      "Read the proposal detail and end with a concise coverage summary listing inbox item IDs, source IDs, proposal IDs, and unresolved ambiguity.",
    ].join("\n"),
  },
  {
    id: "review-apply-close",
    agent: "openwiki-reviewer",
    expectedTools: [
      "wiki.list_proposals",
      "wiki.read_proposal_detail",
      "wiki.review_proposal",
      "wiki.close_proposal",
      "wiki.apply_proposal",
      "wiki.run_lint",
      "wiki.commit_changes",
      "wiki.read_decision",
      "wiki.git_status",
      "wiki.list_events",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a trusted maintainer-mode tool coverage eval. Do not use bash and do not edit files directly.",
      "Call every one of these OpenWiki tools at least once: wiki.list_proposals, wiki.read_proposal_detail, wiki.review_proposal, wiki.close_proposal, wiki.apply_proposal, wiki.run_lint, wiki.commit_changes, wiki.read_decision, wiki.git_status, wiki.list_events.",
      "Use actor_id " + ACTOR_ID + ".",
      "There are preseeded proposals. Accept and apply {{VALID_PROPOSAL_ID}} if its validation passed. Close {{STALE_PROPOSAL_ID}} as superseded by {{VALID_PROPOSAL_ID}} with a concrete rationale.",
      "After applying or closing, read the resulting decision record if one exists, run lint, commit all OpenWiki-managed changes with message 'OpenWiki eval review workflow', then check git status and recent events.",
      "End with a concise coverage summary listing decisions, commits, and tools you called.",
    ].join("\n"),
  },
  {
    id: "git-sync",
    agent: "openwiki-reviewer",
    expectedTools: [
      "wiki.git_status",
      "wiki.git_pull",
      "wiki.git_push",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a trusted Git sync tool coverage eval. Do not use bash and do not edit files directly.",
      "Call exactly these OpenWiki tools in this order: wiki.git_status, wiki.git_pull, wiki.git_push.",
      "Use remote origin and branch master for pull and push.",
      "Do not create, edit, publish, or commit any content.",
      "End with a concise coverage summary listing the sync state and tools you called.",
    ].join("\n"),
  },
  {
    id: "admin-operations",
    agent: "openwiki-reviewer",
    expectedTools: [
      "wiki.detect_governance",
      "wiki.read_policy",
      "wiki.list_workspaces",
      "wiki.connect_workspace",
      "wiki.propose_policy",
      "wiki.propose_section_policy",
      "wiki.ingest_source",
      "wiki.fetch_source",
      "wiki.create_synthesis",
      "wiki.run_job",
      "wiki.publish",
      "wiki.list_runs",
    ],
    prompt: [
      "Use the " + MCP_ID + " MCP against this temporary eval wiki.",
      "This is a trusted admin-mode tool coverage eval. Do not use bash and do not edit files directly.",
      "Call every one of these OpenWiki tools at least once: wiki.detect_governance, wiki.read_policy, wiki.list_workspaces, wiki.connect_workspace, wiki.propose_policy, wiki.propose_section_policy, wiki.ingest_source, wiki.fetch_source, wiki.create_synthesis, wiki.run_job, wiki.publish, wiki.list_runs.",
      "Use actor_id " + ACTOR_ID + ".",
      "Execute this exact checklist in order and do not skip ahead:",
      "1. Call wiki.detect_governance with stale_claim, missing_source, broken_link, and orphan_page detectors.",
      "2. Call wiki.read_policy.",
      "3. Call wiki.list_workspaces.",
      "4. Call wiki.connect_workspace with remote origin, branch master, and credential_ref cred:openwiki-eval. Do not include raw credentials.",
      "5. Call wiki.propose_policy for grants.",
      "6. Call wiki.propose_section_policy for section:eval-ops.",
      "7. Call wiki.ingest_source.",
      "8. Call wiki.fetch_source.",
      "9. Call wiki.create_synthesis.",
      "10. Call wiki.run_job.",
      "11. Call wiki.publish.",
      "12. Call wiki.list_runs.",
      "For wiki.propose_policy, read policy first, then propose an equivalent grants policy body. The body must be the raw grants JSON array, not an object with a grants property.",
      "For wiki.propose_section_policy, propose section_id section:eval-ops, title Eval Ops, paths [\"wiki/eval-ops/**\"], visibility internal, viewer_principals [\"group:eval-viewers\"], reviewer_principals [\"group:eval-reviewers\"], admin_principals [\"group:eval-admins\"], required_reviewer_principals [\"group:eval-reviewers\"].",
      "For wiki.ingest_source, use exactly source_type manual and inline content about this eval.",
      "For wiki.fetch_source, use title OpenWiki Eval Fetch Probe, url https://example.com/, connector_kind http, wait false, max_bytes 1024, timeout_ms 5000.",
      "For wiki.create_synthesis, create a short page titled Eval Maintainer Operations with commit false.",
      "Run wiki.run_job for lint with wait true, publish to " + ADMIN_PUBLISH_OUT_DIR + ", and list runs. Do not call wiki.commit_changes, wiki.git_pull, or wiki.git_push in this scenario.",
      "End with a concise coverage summary listing run IDs, publish output, and tools you called.",
    ].join("\n"),
  },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const toolInventory = await readToolInventory();
  const selectedScenarios = options.scenario === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.id === options.scenario);
  if (selectedScenarios.length === 0) {
    throw new Error("Unknown scenario '" + options.scenario + "'. Expected one of: " + SCENARIOS.map((scenario) => scenario.id).join(", "));
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-opencode-eval-"));
  const wikiRoot = path.join(tempRoot, "wiki");
  const projectRoot = path.join(tempRoot, "opencode-project");
  const results = {
    started_at: new Date().toISOString(),
    model: MODEL,
    temp_root: tempRoot,
    wiki_root: wikiRoot,
    project_root: projectRoot,
    tool_inventory: toolInventory,
    scenarios: [],
    summary: {},
  };

  try {
    const seed = await prepareEvalWorkspace({ tempRoot, wikiRoot, projectRoot, setupOnly: options.setupOnly });
    results.seed = seed;
    if (options.setupOnly) {
      results.summary = { setup_only: true, selected_scenarios: selectedScenarios.map((scenario) => scenario.id), seed };
      await writeResults(results);
      printSummary(results);
      return;
    }
    for (const scenario of selectedScenarios) {
      const result = await runScenario({ scenario, projectRoot, wikiRoot, retries: options.retries, timeoutMs: options.timeoutMs, seed });
      results.scenarios.push(result);
    }
    results.runtime_checks = await verifyRuntimeSurfaces({ tempRoot, wikiRoot });
    results.summary = summarize(results.scenarios, selectedScenarios, toolInventory, results.runtime_checks);
    await writeResults(results);
    printSummary(results);
    if (
      results.summary.missing_required_tools.length > 0 ||
      results.summary.failed_scenarios.length > 0 ||
      results.summary.failed_workflow_checks.length > 0 ||
      results.summary.failed_runtime_checks.length > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    if (!options.keep) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.error("Kept eval workspace: " + tempRoot);
    }
  }
}

function parseArgs(argv) {
  const options = {
    keep: false,
    retries: 2,
    timeoutMs: 180000,
    scenario: undefined,
    setupOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--keep") {
      options.keep = true;
      continue;
    }
    if (value === "--retries") {
      options.retries = Number(requireValue(argv, index, "--retries"));
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, index, "--timeout-ms"));
      index += 1;
      continue;
    }
    if (value === "--scenario") {
      options.scenario = requireValue(argv, index, "--scenario");
      index += 1;
      continue;
    }
    if (value === "--setup-only") {
      options.setupOnly = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      console.log("Usage: pnpm eval:opencode-tools [--scenario id] [--retries n] [--timeout-ms ms] [--keep] [--setup-only]");
      process.exit(0);
    }
    throw new Error("Unknown option '" + value + "'");
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error("Expected value after " + flag);
  }
  return value;
}

async function readToolInventory() {
  const sources = await Promise.all([
    readFile(path.join(REPO_ROOT, "packages", "mcp-server", "src", "tool-definitions.ts"), "utf8"),
    readFile(path.join(REPO_ROOT, "packages", "mcp-server", "src", "inbox-tool-definitions.ts"), "utf8"),
  ]);
  const source = sources.join("\n");
  return Array.from(source.matchAll(/name: "((?:wiki)\.[^"]+)"/g), (match) => match[1]).filter((tool, index, tools) => tools.indexOf(tool) === index);
}

async function prepareEvalWorkspace({ tempRoot, wikiRoot, projectRoot, setupOnly }) {
  await mkdir(projectRoot, { recursive: true });
  await run(process.execPath, [
    "--no-warnings",
    "--import",
    TSX_IMPORT,
    CLI_ENTRY,
    "init",
    wikiRoot,
    "--template",
    "personal-wiki",
    "--title",
    "OpenWiki Agent Eval",
    "--json",
  ], { cwd: REPO_ROOT, timeoutMs: 60000 });

  await run("git", ["init", "--initial-branch", "master"], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["config", "user.email", "eval@openwiki.local"], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["config", "user.name", "OpenWiki Eval"], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["add", "."], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["commit", "-m", "Initial OpenWiki eval workspace"], { cwd: wikiRoot, timeoutMs: 60000 });

  const remoteRoot = path.join(tempRoot, "remote.git");
  await run("git", ["init", "--bare", "--initial-branch", "master", remoteRoot], { cwd: tempRoot, timeoutMs: 60000 });
  await run("git", ["remote", "add", "origin", remoteRoot], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["push", "-u", "origin", "master"], { cwd: wikiRoot, timeoutMs: 60000 });

  const seed = await seedReviewProposals(wikiRoot);
  await run("git", ["add", "."], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["commit", "-m", "Seed OpenWiki eval proposals"], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["push", "origin", "master"], { cwd: wikiRoot, timeoutMs: 60000 });
  const recorderPlugin = await installEvalOpenCodeProject(projectRoot, wikiRoot, setupOnly);
  return { ...seed, recorder_plugin: recorderPlugin };
}

async function seedReviewProposals(wikiRoot) {
  const validBody = [
    "Use this workspace to keep cited notes, decisions, recurring research, and durable context that should survive individual agent sessions.",
    "",
    "Start by turning important files, web pages, and conversations into source records before making durable claims.",
    "",
    "This eval sentence checks the governed apply path.",
    "",
    "## Open Questions",
    "",
    "- Which recurring topics should become dedicated pages?",
  ].join("\n");
  const validResult = await run(process.execPath, [
    "--no-warnings",
    "--import",
    TSX_IMPORT,
    CLI_ENTRY,
    "--root",
    wikiRoot,
    "propose-edit",
    "page:concept:personal-knowledge-base",
    "--body-file",
    await writeTempFile(wikiRoot, ".openwiki/eval-valid-edit.md", validBody),
    "--actor",
    ACTOR_ID,
    "--rationale",
    "Seed a valid edit proposal for the OpenCode reviewer eval.",
    "--json",
  ], { cwd: REPO_ROOT, timeoutMs: 60000 });

  const staleBody = [
    "Use this workspace to keep cited notes, decisions, recurring research, and durable context that should survive individual agent sessions.",
    "",
    "Start by turning important files, web pages, and conversations into source records before making durable claims.",
    "",
    "This stale eval sentence should be superseded.",
  ].join("\n");
  const staleResult = await run(process.execPath, [
    "--no-warnings",
    "--import",
    TSX_IMPORT,
    CLI_ENTRY,
    "--root",
    wikiRoot,
    "propose-edit",
    "page:concept:personal-knowledge-base",
    "--body-file",
    await writeTempFile(wikiRoot, ".openwiki/eval-stale-edit.md", staleBody),
    "--actor",
    ACTOR_ID,
    "--rationale",
    "Seed a stale proposal for close/supersede eval coverage.",
    "--json",
  ], { cwd: REPO_ROOT, timeoutMs: 60000 });

  const valid = JSON.parse(validResult.stdout);
  const stale = JSON.parse(staleResult.stdout);
  return {
    valid_proposal_id: valid.proposal.id,
    stale_proposal_id: stale.proposal.id,
  };
}

async function writeTempFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

async function installEvalOpenCodeProject(projectRoot, wikiRoot, setupOnly) {
  await mkdir(path.join(projectRoot, ".opencode"), { recursive: true });
  for (const directory of ["agents", "skills"]) {
    await cp(path.join(REPO_ROOT, "integrations", "opencode", directory), path.join(projectRoot, ".opencode", directory), {
      recursive: true,
      force: true,
    });
  }
  const recorderPlugin = await installEvalRecorderPlugin(projectRoot, setupOnly);
  await specializeEvalOpenCodePrompts(projectRoot);
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      "openwiki-personal": {
        enabled: false,
      },
      [MCP_ID]: {
        type: "local",
        enabled: true,
        command: [
          "/bin/zsh",
          "-lc",
          [
            "cd " + shellQuote(REPO_ROOT),
            "&&",
            "OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1",
            "exec " + shellQuote(process.execPath),
            "--no-warnings",
            "--import",
            "tsx",
            shellQuote(CLI_ENTRY),
            "--root",
            shellQuote(wikiRoot),
            "--actor",
            shellQuote(ACTOR_ID),
            "--role",
            "admin",
            "mcp",
            "--stdio",
            "--tools",
            "write",
          ].join(" "),
        ],
      },
    },
    skills: {
      paths: [".opencode/skills"],
    },
  };
  await writeFile(path.join(projectRoot, "opencode.json"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(
    path.join(projectRoot, "AGENTS.md"),
    [
      "# OpenWiki Eval Project",
      "",
      "Use the " + MCP_ID + " MCP for OpenWiki actions.",
      "Do not edit files directly during eval runs.",
    ].join("\n") + "\n",
  );
  return recorderPlugin;
}

async function installEvalRecorderPlugin(projectRoot, setupOnly) {
  const availability = describeOpenCodeEvalRecorderAvailability(REPO_ROOT);
  if (setupOnly) {
    return {
      installed: false,
      skipped: true,
      skip_category: "setup_only",
      reason: "setup-only does not require the private/local opencode-tools recorder plugin",
      recorder_available: availability.available,
      candidates: availability.candidates,
    };
  }
  const recorder = resolveOpenCodeEvalRecorderPlugin(REPO_ROOT);
  const targetPath = path.join(projectRoot, ".opencode", "plugins", "opencode_eval_recorder.ts");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(recorder.path, targetPath, { force: true });
  return {
    installed: true,
    source: recorder.path,
    source_kind: recorder.source,
    candidates: recorder.candidates,
    target: path.relative(projectRoot, targetPath),
  };
}

async function specializeEvalOpenCodePrompts(projectRoot) {
  const files = [
    path.join(projectRoot, ".opencode", "agents", "openwiki-researcher.md"),
    path.join(projectRoot, ".opencode", "agents", "openwiki-editor.md"),
    path.join(projectRoot, ".opencode", "agents", "openwiki-inbox-operator.md"),
    path.join(projectRoot, ".opencode", "agents", "openwiki-meeting-curator.md"),
    path.join(projectRoot, ".opencode", "agents", "openwiki-reviewer.md"),
    path.join(projectRoot, ".opencode", "agents", "openwiki-monitor.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-inbox", "SKILL.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-meeting-curation", "SKILL.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-operator", "SKILL.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-edit", "SKILL.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-research", "SKILL.md"),
    path.join(projectRoot, ".opencode", "skills", "openwiki-transcript-inbox", "SKILL.md"),
  ];
  for (const file of files) {
    let content = await readFile(file, "utf8");
    content = content.replaceAll("openwiki-personal", MCP_ID);
    content = content.replaceAll("edit: deny\n  bash: ask", "edit: deny\n  bash: deny\n  read: deny\n  glob: deny\n  grep: deny\n  task: deny\n  webfetch: deny\n  todowrite: deny\n  skill: deny");
    if (file.endsWith(".md") && file.includes("agents")) {
      content += "\n\nEval constraint: use only the " + MCP_ID + " MCP tools. Do not use built-in read, glob, grep, edit, bash, task, webfetch, todowrite, or skill tools. Do not use openwiki-personal.\n";
    }
    await writeFile(file, content);
  }
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

async function runScenario({ scenario, projectRoot, wikiRoot, retries, timeoutMs, seed }) {
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const startedAt = new Date().toISOString();
    const tracePath = path.join(projectRoot, ".openwiki-eval-traces", `${scenario.id}-attempt-${attempt}.jsonl`);
    const runResult = await run("opencode", [
      "run",
      "--dir",
      projectRoot,
      "--format",
      "json",
      "--model",
      MODEL,
      "--agent",
      scenario.agent,
      renderPrompt(scenario.prompt, seed),
    ], { cwd: projectRoot, timeoutMs, allowFailure: true, env: { OPENCODE_EVAL_TRACE: tracePath } });
    const parsed = parseOpenCodeOutput(runResult.stdout);
    const traceRecords = await readOpenCodeEvalTrace(tracePath);
    const traceToolUses = parseOpenCodeTrace(traceRecords);
    const toolUses = mergeToolUses(parsed.toolUses, traceToolUses);
    const attemptedTools = Array.from(new Set(toolUses.map((toolUse) => toolUse.tool))).sort();
    const calledTools = Array.from(new Set(toolUses.filter((toolUse) => toolUse.status === "completed").map((toolUse) => toolUse.tool))).sort();
    const missingTools = scenario.expectedTools.filter((tool) => !calledTools.includes(tool));
    const providerFailed = isProviderFailure(runResult.stdout + "\n" + runResult.stderr);
    const modelRefused = isModelRefusal(parsed.text);
    const traceMissing = !providerFailed && !runResult.timedOut && traceToolUses.length === 0;
    const failedToolUses = toolUses.filter((toolUse) => toolUse.status !== "completed");
    const failureKind = classifyAttemptFailure({
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      providerFailed,
      modelRefused,
      traceMissing,
      missingTools,
      failedToolUses,
    });
    const attemptResult = {
      attempt,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: runResult.exitCode,
      timed_out: runResult.timedOut,
      provider_failed: providerFailed,
      model_refused: modelRefused,
      trace_missing: traceMissing,
      failure_kind: failureKind,
      trace_path: tracePath,
      trace_record_count: traceRecords.length,
      trace_tool_uses: traceToolUses,
      attempted_tools: attemptedTools,
      called_tools: calledTools,
      missing_tools: missingTools,
      tool_uses: toolUses,
      failed_tool_uses: failedToolUses,
      text: parsed.text,
      stderr_tail: tail(runResult.stderr, 4000),
      stdout_tail: tail(runResult.stdout, 4000),
    };
    attempts.push(attemptResult);
    if (runResult.exitCode === 0 && missingTools.length === 0 && !traceMissing) {
      const workflow = await verifyWorkflowState({ scenarioId: scenario.id, wikiRoot, seed });
      return {
        id: scenario.id,
        agent: scenario.agent,
        expected_tools: scenario.expectedTools,
        status: workflow.ok ? "passed" : "failed",
        attempts,
        called_tools: calledTools,
        missing_tools: [],
        workflow_checks: workflow.checks,
      };
    }
  }
  const bestAttempt = attempts.slice().sort((a, b) => a.missing_tools.length - b.missing_tools.length)[0] || attempts[0];
  return {
    id: scenario.id,
    agent: scenario.agent,
    expected_tools: scenario.expectedTools,
    status: "failed",
    attempts,
    called_tools: bestAttempt ? bestAttempt.called_tools : [],
    missing_tools: bestAttempt ? bestAttempt.missing_tools : scenario.expectedTools,
    workflow_checks: [],
  };
}

async function verifyWorkflowState({ scenarioId, wikiRoot, seed }) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  if (scenarioId === "read-research") {
    add("canonical page remains readable", await exists(path.join(wikiRoot, "wiki", "concepts", "personal-knowledge-base.md")));
    add("canonical source remains readable", (await readTextFiles(path.join(wikiRoot, "sources"))).some((text) => text.includes("source:2026-05-21-001")));
  } else if (scenarioId === "proposal-editing") {
    const proposalTexts = await readTextFiles(path.join(wikiRoot, "proposals"));
    const proposalCount = proposalTexts.filter((text) => text.includes("id: proposal:")).length;
    add("agent created additional proposals", proposalCount >= 5, "proposal_count=" + proposalCount);
    add("proposal comment recorded", proposalTexts.some((text) => (text.includes("proposal_id:") || text.includes("\"proposal_id\"")) && text.includes(ACTOR_ID)));
  } else if (scenarioId === "meeting-curator-inbox") {
    const inboxTexts = await readTextFiles(path.join(wikiRoot, "inbox"));
    add("meeting inbox item recorded", inboxTexts.some((text) => text.includes("Eval Transcript Sync Meeting") && text.includes("meeting_transcript")));
    const sourceTexts = await readTextFiles(path.join(wikiRoot, "sources"));
    add("meeting transcript source recorded", sourceTexts.some((text) => text.includes("Eval Transcript Sync Meeting") || text.includes("weekly exports")));
    const proposalTexts = await readTextFiles(path.join(wikiRoot, "proposals"));
    add("meeting synthesis proposal recorded", proposalTexts.some((text) => text.includes("Eval Transcript Sync Meeting")));
  } else if (scenarioId === "review-apply-close") {
    const proposalTexts = await readTextFiles(path.join(wikiRoot, "proposals"));
    add("valid proposal applied", proposalTexts.some((text) => text.includes("id: " + seed.valid_proposal_id) && text.includes("status: applied")));
    add("stale proposal superseded", proposalTexts.some((text) => text.includes("id: " + seed.stale_proposal_id) && text.includes("status: closed") && text.includes("close_resolution: superseded")));
    const page = await readOptionalText(path.join(wikiRoot, "wiki", "concepts", "personal-knowledge-base.md"));
    add("applied page contains eval sentence", page.includes("governed apply path"));
  } else if (scenarioId === "admin-operations") {
    add("publish output exists", await exists(path.join(wikiRoot, ADMIN_PUBLISH_OUT_DIR, "index.html")));
    const runLog = await readOptionalText(path.join(wikiRoot, "runs", "runs.jsonl"));
    add("admin run recorded", runLog.includes("source.fetch") || runLog.includes("lint"));
    const sourceTexts = await readTextFiles(path.join(wikiRoot, "sources"));
    add("admin source ingested or proposed", sourceTexts.some((text) => text.includes("eval") || text.includes("OpenWiki Eval")));
    const config = await readOptionalText(path.join(wikiRoot, "openwiki.json"));
    add("workspace credential ref configured", config.includes("cred:openwiki-eval"));
    const proposalTexts = await readTextFiles(path.join(wikiRoot, "proposals"));
    add("section policy proposal recorded", proposalTexts.some((text) => text.includes("section:eval-ops")));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function verifyRuntimeSurfaces({ tempRoot, wikiRoot }) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  await commitEvalWorkspaceIfDirty(wikiRoot, "Record eval runtime surface state");
  await runCliJson(["--root", wikiRoot, "index", "--json"]);
  await runCliJson(["--root", wikiRoot, "db", "rebuild", "--json"]);
  const probes = await runRuntimeProbe(wikiRoot);
  add("livez returns alive", probes.livez.status === 200 && probes.livez.body?.status === "alive", probeDetail(probes.livez));
  add("readyz returns ready", probes.readyz.status === 200 && probes.readyz.body?.status === "ready", probeDetail(probes.readyz));
  add("metrics expose workspace gauges", probes.metrics.status === 200 && /openwiki_workspace_records/.test(probes.metrics.body), probeDetail(probes.metrics));
  add("metrics expose readiness gauge", probes.metrics.status === 200 && /openwiki_ready/.test(probes.metrics.body), probeDetail(probes.metrics));

  const backupDir = path.join(tempRoot, "backups");
  const restoreRoot = path.join(tempRoot, "restored-wiki");
  const backup = await runCliJson([
    "--root",
    wikiRoot,
    "backup",
    "create",
    "--out-dir",
    backupDir,
    "--json",
  ]);
  add("backup manifest created", backup.manifest?.schema_version === "openwiki.backup.v1" && typeof backup.backup_dir === "string");
  add("backup checksums created", typeof backup.manifest?.checksum_file_hash === "string" && typeof backup.checksums_path === "string");
  add("backup includes canonical repo paths", Array.isArray(backup.manifest?.included_paths) && backup.manifest.included_paths.includes("openwiki.json") && backup.manifest.included_paths.includes("wiki"));

  const backupVerification = await runCliJson([
    "--root",
    wikiRoot,
    "backup",
    "verify",
    backup.backup_dir,
    "--json",
  ]);
  add("backup verifies before restore", backupVerification.backup_id === backup.backup_id && backupVerification.files_checked > 0);

  const restore = await runCliJson([
    "backup",
    "restore",
    backup.backup_dir,
    "--target-root",
    restoreRoot,
    "--json",
  ]);
  add("restore rebuilt search index", restore.search_index?.recordCount > 0, "recordCount=" + String(restore.search_index?.recordCount ?? "missing"));
  add("restore rebuilt index-store", restore.index_store?.recordCount > 0, "recordCount=" + String(restore.index_store?.recordCount ?? "missing"));

  const restoredSearch = await runCliJson([
    "--root",
    restoreRoot,
    "search",
    "personal knowledge",
    "--limit",
    "1",
    "--json",
  ]);
  add("restored wiki remains searchable", Array.isArray(restoredSearch.results) && restoredSearch.results.length > 0);

  return checks;
}

function probeDetail(probe) {
  const body = typeof probe.body === "string" ? probe.body.slice(0, 200) : JSON.stringify(probe.body ?? {}).slice(0, 200);
  return `status=${probe.status}; body=${body}`;
}

async function runRuntimeProbe(wikiRoot) {
  const code = [
    "import { routeHttpRequest } from " + JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "packages", "http-api", "src", "index.ts")).href) + ";",
    "const root = " + JSON.stringify(wikiRoot) + ";",
    "const policy = { role: 'admin', actorId: " + JSON.stringify(ACTOR_ID) + " };",
    "const livez = await routeHttpRequest(root, 'GET', '/livez');",
    "const readyz = await routeHttpRequest(root, 'GET', '/readyz');",
    "const metrics = await routeHttpRequest(root, 'GET', '/metrics', undefined, policy);",
    "console.log(JSON.stringify({ livez, readyz, metrics }));",
  ].join("\n");
  const result = await run(process.execPath, [
    "--no-warnings",
    "--import",
    TSX_IMPORT,
    "--eval",
    code,
  ], { cwd: REPO_ROOT, timeoutMs: 60000 });
  return JSON.parse(result.stdout);
}

async function commitEvalWorkspaceIfDirty(wikiRoot, message) {
  const status = await run("git", ["status", "--porcelain"], { cwd: wikiRoot, timeoutMs: 60000 });
  if (!status.stdout.trim()) {
    return;
  }
  await run("git", ["add", "-A", "."], { cwd: wikiRoot, timeoutMs: 60000 });
  await run("git", ["commit", "-m", message], { cwd: wikiRoot, timeoutMs: 60000 });
}

async function runCliJson(args) {
  const result = await run(process.execPath, [
    "--no-warnings",
    "--import",
    TSX_IMPORT,
    CLI_ENTRY,
    ...args,
  ], { cwd: REPO_ROOT, timeoutMs: 120000 });
  return JSON.parse(result.stdout);
}

function renderPrompt(prompt, seed) {
  return prompt
    .replaceAll("{{VALID_PROPOSAL_ID}}", seed.valid_proposal_id)
    .replaceAll("{{STALE_PROPOSAL_ID}}", seed.stale_proposal_id);
}

function parseOpenCodeOutput(stdout) {
  const toolUses = [];
  const text = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "tool_use" && event.part && event.part.type === "tool") {
      const rawTool = String(event.part.tool || "");
      const normalized = normalizeToolName(rawTool);
      if (normalized && normalized.startsWith("wiki.")) {
        toolUses.push({
          tool: normalized,
          raw_tool: rawTool,
          call_id: event.part.callID,
          status: event.part.state && event.part.state.status,
          input: event.part.state && event.part.state.input,
          output_preview: tail(String((event.part.state && event.part.state.output) || ""), 1200),
          error_preview: tail(String((event.part.state && event.part.state.error) || ""), 1200),
        });
      }
    }
    if (event.type === "text" && event.part && typeof event.part.text === "string") {
      text.push(event.part.text);
    }
  }
  return { toolUses, text: text.join("\n\n") };
}

async function readOpenCodeEvalTrace(tracePath) {
  if (!(await exists(tracePath))) {
    return [];
  }
  const content = await readFile(tracePath, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseOpenCodeTrace(records) {
  const byCall = new Map();
  let sequence = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const rawTool = typeof record.tool === "string" ? record.tool : "";
    const normalized = normalizeToolName(rawTool);
    if (!normalized || !normalized.startsWith("wiki.")) {
      continue;
    }
    const callId = typeof record.call_id === "string" ? record.call_id : `trace-${sequence++}`;
    const existing = byCall.get(callId) ?? {
      tool: normalized,
      raw_tool: rawTool,
      call_id: callId,
      status: "started",
    };
    const status = record.status === "completed" || record.type === "opencode.eval.tool.after" ? "completed" : existing.status;
    byCall.set(callId, {
      ...existing,
      tool: normalized,
      raw_tool: rawTool,
      call_id: callId,
      status,
      input: existing.input ?? (record.type === "opencode.eval.tool.before" ? record.data : undefined),
      output_preview: existing.output_preview ?? tail(JSON.stringify(record.data ?? ""), 1200),
    });
  }
  return [...byCall.values()];
}

function mergeToolUses(...groups) {
  const merged = new Map();
  let sequence = 0;
  for (const toolUse of groups.flat()) {
    const key = toolUse.call_id || `${toolUse.tool}-${sequence++}`;
    const existing = merged.get(key) ?? {};
    merged.set(key, {
      ...existing,
      ...toolUse,
      status: existing.status === "completed" || toolUse.status === "completed" ? "completed" : toolUse.status ?? existing.status,
      input: toolUse.input ?? existing.input,
      output_preview: toolUse.output_preview ?? existing.output_preview,
      error_preview: toolUse.error_preview ?? existing.error_preview,
    });
  }
  return [...merged.values()];
}

function normalizeToolName(rawTool) {
  const marker = "_wiki_";
  const index = rawTool.indexOf(marker);
  if (index === -1) {
    return rawTool.startsWith("wiki.") ? rawTool : undefined;
  }
  return "wiki." + rawTool.slice(index + marker.length);
}

function isProviderFailure(output) {
  return /Error from provider|Provider returned error|rate limit|overloaded|CreditsError|insufficient balance|billing/i.test(output);
}

function isModelRefusal(text) {
  return /\b(?:I'm sorry|I’m sorry|I am sorry|I cannot|I can't|I can’t|I am unable|cannot comply|can't comply|can’t comply|unable to comply|not able to assist)\b/i.test(text);
}

function classifyAttemptFailure({ exitCode, timedOut, providerFailed, modelRefused, traceMissing, missingTools, failedToolUses }) {
  if (providerFailed) {
    return "provider_failure";
  }
  if (timedOut) {
    return "model_timeout";
  }
  if (modelRefused) {
    return "model_refusal";
  }
  if (traceMissing) {
    return "trace_missing";
  }
  if (missingTools.length > 0 || failedToolUses.length > 0) {
    return "tool_regression";
  }
  if (exitCode !== 0) {
    return "opencode_failure";
  }
  return "passed";
}

function summarize(scenarios, selectedScenarios, inventory, runtimeChecks = []) {
  const calledTools = Array.from(new Set(scenarios.flatMap((scenario) => scenario.called_tools))).sort();
  const requiredTools = Array.from(new Set(selectedScenarios.flatMap((scenario) => scenario.expectedTools))).sort();
  const failedWorkflowChecks = scenarios.flatMap((scenario) =>
    (scenario.workflow_checks ?? [])
      .filter((check) => !check.ok)
      .map((check) => ({ scenario: scenario.id, ...check })),
  );
  const failedRuntimeChecks = runtimeChecks.filter((check) => !check.ok);
  const providerFailures = scenarios.flatMap((scenario) =>
    scenario.attempts
      .filter((attempt) => attempt.provider_failed)
      .map((attempt) => ({
        scenario: scenario.id,
        attempt: attempt.attempt,
        stderr_tail: attempt.stderr_tail,
        stdout_tail: attempt.stdout_tail,
      })),
  );
  const scenarioIdsByFailureKind = (kind) =>
    Array.from(new Set(scenarios.filter((scenario) => scenario.attempts.some((attempt) => attempt.failure_kind === kind)).map((scenario) => scenario.id))).sort();
  const failureKindCounts = scenarios
    .flatMap((scenario) => scenario.attempts.map((attempt) => attempt.failure_kind))
    .reduce((counts, kind) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {});
  return {
    scenario_count: scenarios.length,
    passed_scenarios: scenarios.filter((scenario) => scenario.status === "passed").map((scenario) => scenario.id),
    failed_scenarios: scenarios.filter((scenario) => scenario.status !== "passed").map((scenario) => scenario.id),
    provider_failed_scenarios: Array.from(new Set(providerFailures.map((failure) => failure.scenario))).sort(),
    model_timeout_scenarios: scenarioIdsByFailureKind("model_timeout"),
    model_refusal_scenarios: scenarioIdsByFailureKind("model_refusal"),
    trace_missing_scenarios: scenarioIdsByFailureKind("trace_missing"),
    tool_regression_scenarios: scenarioIdsByFailureKind("tool_regression"),
    opencode_failure_scenarios: scenarioIdsByFailureKind("opencode_failure"),
    failure_kind_counts: failureKindCounts,
    provider_failures: providerFailures,
    called_tool_count: calledTools.length,
    inventory_tool_count: inventory.length,
    required_tool_count: requiredTools.length,
    called_tools: calledTools,
    missing_required_tools: requiredTools.filter((tool) => !calledTools.includes(tool)),
    failed_workflow_checks: failedWorkflowChecks,
    failed_runtime_checks: failedRuntimeChecks,
    not_required_inventory_tools: inventory.filter((tool) => !requiredTools.includes(tool)),
  };
}

async function readTextFiles(root) {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return readTextFiles(fullPath);
    }
    if (!entry.isFile()) {
      return [];
    }
    if (!/\.(jsonl?|ya?ml|md|txt|html)$/.test(entry.name)) {
      return [];
    }
    return [await readFile(fullPath, "utf8")];
  }));
  return nested.flat();
}

async function readOptionalText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeResults(results) {
  const resultDir = path.join(REPO_ROOT, "evals", "opencode-tool-coverage");
  await mkdir(resultDir, { recursive: true });
  await writeFile(path.join(resultDir, "latest.json"), JSON.stringify(results, null, 2) + "\n");
}

function printSummary(results) {
  console.log(JSON.stringify(results.summary, null, 2));
  for (const scenario of results.scenarios) {
    console.log((scenario.status === "passed" ? "PASS" : "FAIL") + " " + scenario.id + ": " + scenario.called_tools.length + "/" + scenario.expected_tools.length + " expected tools called");
    if (scenario.missing_tools.length > 0) {
      console.log("  missing: " + scenario.missing_tools.join(", "));
    }
    const providerFailedAttempts = scenario.attempts.filter((attempt) => attempt.provider_failed);
    if (providerFailedAttempts.length > 0) {
      console.log("  provider failures: attempts " + providerFailedAttempts.map((attempt) => attempt.attempt).join(", "));
    }
    const timedOutAttempts = scenario.attempts.filter((attempt) => attempt.failure_kind === "model_timeout");
    if (timedOutAttempts.length > 0) {
      console.log("  model timeouts: attempts " + timedOutAttempts.map((attempt) => attempt.attempt).join(", "));
    }
    const refusalAttempts = scenario.attempts.filter((attempt) => attempt.failure_kind === "model_refusal");
    if (refusalAttempts.length > 0) {
      console.log("  model refusals: attempts " + refusalAttempts.map((attempt) => attempt.attempt).join(", "));
    }
    const toolRegressionAttempts = scenario.attempts.filter((attempt) => attempt.failure_kind === "tool_regression");
    if (toolRegressionAttempts.length > 0) {
      console.log("  tool regressions: attempts " + toolRegressionAttempts.map((attempt) => attempt.attempt).join(", "));
    }
    const failedChecks = (scenario.workflow_checks ?? []).filter((check) => !check.ok);
    if (failedChecks.length > 0) {
      console.log("  failed workflow checks: " + failedChecks.map((check) => check.name).join(", "));
    }
  }
  const failedRuntimeChecks = results.summary.failed_runtime_checks ?? [];
  if (failedRuntimeChecks.length > 0) {
    console.log("FAIL runtime checks: " + failedRuntimeChecks.map((check) => check.name).join(", "));
  } else if (results.runtime_checks) {
    console.log("PASS runtime checks: " + results.runtime_checks.length + "/" + results.runtime_checks.length);
  }
  console.log("Wrote evals/opencode-tool-coverage/latest.json");
}

function tail(value, maxLength) {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

async function run(command, args, options) {
  const timeoutMs = options.timeoutMs || 120000;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(options.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  if (!options.allowFailure && exitCode !== 0) {
    throw new Error([
      "Command failed (" + exitCode + "): " + command + " " + args.join(" "),
      stderr.trim(),
      stdout.trim(),
    ].filter(Boolean).join("\n"));
  }
  return { stdout, stderr, exitCode, timedOut };
}

await main();
