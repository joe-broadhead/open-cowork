#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeetingCurationPlan, validateMeetingCurationPlan } from "@openwiki/workflows";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
const DEFAULT_FIXTURE = path.join(REPO_ROOT, "fixtures", "transcripts", "acme-launch-sync.txt");
const ACTOR_USER = "actor:user:local";
const ACTOR_AGENT = "actor:agent:meeting-curator";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = options.tempRoot ?? await mkdtemp(path.join(os.tmpdir(), "openwiki-personal-inbox-"));
  const wikiRoot = path.resolve(options.wikiRoot ?? path.join(tempRoot, "OpenWiki", "personal-wiki"));
  const inboxDir = path.resolve(options.inboxDir ?? path.join(tempRoot, "Transcript Inbox"));
  const backupDir = path.resolve(options.backupDir ?? path.join(tempRoot, "OpenWiki", "backups"));
  const restoreRoot = path.resolve(options.restoreRoot ?? path.join(tempRoot, "OpenWiki", "restore-rehearsal"));
  const serviceHome = path.resolve(options.serviceHome ?? path.join(tempRoot, "service-home"));
  const fixturePath = path.resolve(options.fixture ?? DEFAULT_FIXTURE);
  const remoteUrl = options.remoteUrl ?? path.join(tempRoot, "github-private-standin.git");
  if (options.remoteUrl === undefined && process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE === undefined) {
    process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = "1";
  }
  const configOut = path.join(wikiRoot, "opencode.openwiki.json");
  const copiedFixture = path.join(inboxDir, path.basename(fixturePath));
  const commands = [];
  const cleanup = options.keep ? undefined : tempRoot;

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    if (options.remoteUrl === undefined) {
      await mkdir(path.dirname(remoteUrl), { recursive: true });
      await runCommand({
        display: ["git", "init", "--bare", "--initial-branch", "main", remoteUrl],
        actual: ["git", "init", "--bare", "--initial-branch", "main", remoteUrl],
        cwd: REPO_ROOT,
        commands,
      });
    }

    const setup = await runCliJson({
      displayArgs: [
        "setup",
        "personal",
        wikiRoot,
        "--title",
        "Personal Wiki Dogfood",
        "--agent",
        "opencode",
        "--tools",
        "proposal",
        "--git-remote",
        remoteUrl,
        "--branch",
        "main",
        "--backup-path",
        backupDir,
        "--config-out",
        configOut,
        "--json",
      ],
      commands,
    });
    await configureLocalGitIdentity(wikiRoot, commands);

    const opencodeInstall = await runCliJson({
      displayArgs: [
        "agent",
        "install",
        "--provider",
        "opencode",
        "--profile",
        "personal-curator",
        "--out-dir",
        wikiRoot,
        "--json",
      ],
      commands,
    });

    const syncEnabled = await runCliJson({
      displayArgs: ["--root", wikiRoot, "sync", "enable", "--every", "15m", "--pull-on-start", "--json"],
      commands,
    });
    const serviceEnv = serviceInstallEnv(serviceHome, options.activateServices);
    const syncService = await runCliJson({
      displayArgs: ["--root", wikiRoot, "service", "install", "sync", "--every", "15m", "--push", "--json"],
      commands,
      env: serviceEnv,
    });
    const backupService = await runCliJson({
      displayArgs: ["--root", wikiRoot, "service", "install", "backup", "--every", "24h", "--json"],
      commands,
      env: serviceEnv,
    });
    const inboxService = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "service",
        "install",
        "inbox",
        "--every",
        "5m",
        "--dir",
        inboxDir,
        "--adapter",
        "file",
        "--provider",
        "transcript_file",
        "--source-type",
        "meeting_transcript",
        "--actor",
        ACTOR_USER,
        "--json",
      ],
      commands,
      env: serviceEnv,
    });

    const initialSync = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "sync",
        "now",
        "--push",
        "--message",
        "Initialize personal transcript inbox dogfood wiki",
        "--json",
      ],
      commands,
    });

    await cp(fixturePath, copiedFixture);
    const sidecar = `${fixturePath}.json`;
    if (await exists(sidecar)) {
      await cp(sidecar, `${copiedFixture}.json`);
    }
    const fixtureSha = await sha256File(copiedFixture);

    const inboxWatch = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "inbox",
        "watch",
        "--dir",
        inboxDir,
        "--adapter",
        "file",
        "--provider",
        "transcript_file",
        "--source-type",
        "meeting_transcript",
        "--actor",
        ACTOR_USER,
        "--once",
        "--json",
      ],
      commands,
    });
    const inboxList = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "inbox",
        "list",
        "--status",
        "received",
        "--source-type",
        "meeting_transcript",
        "--actor",
        ACTOR_USER,
        "--limit",
        "10",
        "--json",
      ],
      commands,
    });
    const inboxItemId = firstInboxItemId(inboxList);
    const inboxRead = await runCliJson({
      displayArgs: ["--root", wikiRoot, "inbox", "read", inboxItemId, "--json"],
      commands,
    });
    const inboxProcess = await runCliJson({
      displayArgs: ["--root", wikiRoot, "inbox", "process", inboxItemId, "--actor", ACTOR_AGENT, "--json"],
      commands,
    });
    const sourceId = sourceIdFromProcess(inboxProcess);
    const sourceContent = await runCliJson({
      displayArgs: ["--root", wikiRoot, "source", "content", sourceId, "--json"],
      commands,
    });

    const plan = buildDogfoodMeetingPlan(inboxItemId, sourceId);
    const planValidation = validateMeetingCurationPlan(plan);
    if (planValidation.status !== "passed") {
      throw new Error(`Dogfood meeting curation plan failed validation: ${JSON.stringify(planValidation.issues)}`);
    }
    const curationBodies = path.join(tempRoot, "curation-bodies");
    await mkdir(curationBodies, { recursive: true });
    const proposals = [];
    for (const page of plan.page_creations) {
      if (!["meeting", "person", "organization", "project", "topic", "decision", "action"].includes(page.page_type)) {
        continue;
      }
      const bodyPath = path.join(curationBodies, `${page.page_type}-${page.slug}.md`);
      await writeFile(bodyPath, page.body.endsWith("\n") ? page.body : `${page.body}\n`);
      const proposal = await runCliJson({
        displayArgs: [
          "--root",
          wikiRoot,
          "synthesize",
          "--title",
          page.title,
          "--page-type",
          page.page_type,
          "--summary",
          page.summary,
          "--source",
          sourceId,
          "--body-file",
          bodyPath,
          "--actor",
          ACTOR_AGENT,
          "--rationale",
          `OpenCode meeting curator proposal for ${inboxItemId}.`,
          "--json",
        ],
        commands,
      });
      proposals.push({
        id: proposal.proposal.id,
        title: page.title,
        page_type: page.page_type,
        target_path: proposal.proposal.target_path,
        validation_status: proposal.validation.status,
      });
    }

    const appliedProposalId = proposals.find((proposal) => proposal.page_type === "meeting")?.id;
    if (appliedProposalId === undefined) {
      throw new Error("Dogfood curation did not create a meeting proposal");
    }
    const review = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "proposal",
        "review",
        appliedProposalId,
        "--decision",
        "accepted",
        "--rationale",
        "Synthetic transcript inbox dogfood fixture is valid and preserves uncertainty.",
        "--actor",
        ACTOR_USER,
        "--json",
      ],
      commands,
    });
    const apply = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "proposal",
        "apply",
        appliedProposalId,
        "--commit",
        "--message",
        "Apply transcript meeting dogfood proposal",
        "--actor",
        ACTOR_USER,
        "--json",
      ],
      commands,
    });
    const sync = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "sync",
        "now",
        "--push",
        "--message",
        "Sync transcript meeting dogfood evidence",
        "--json",
      ],
      commands,
    });
    const syncStatus = await runCliJson({
      displayArgs: ["--root", wikiRoot, "sync", "status", "--json"],
      commands,
    });
    const remoteHead = await readRemoteHead(remoteUrl, "main", commands);

    const backupCreate = await runCliJson({
      displayArgs: ["--root", wikiRoot, "backup", "create", "--destination", "local-backups", "--verify", "--json"],
      commands,
    });
    const backupVerify = await runCliJson({
      displayArgs: ["--root", wikiRoot, "backup", "verify", "latest", "--destination", "local-backups", "--json"],
      commands,
    });
    const backupRehearse = await runCliJson({
      displayArgs: [
        "--root",
        wikiRoot,
        "backup",
        "rehearse",
        "latest",
        "--target-root",
        restoreRoot,
        "--destination",
        "local-backups",
        "--force",
        "--json",
      ],
      commands,
    });

    const evidence = {
      schema_version: "openwiki.personal_inbox_evidence.v1",
      generated_at: new Date().toISOString(),
      scenario: "local transcript inbox dogfood",
      temp_root: tempRoot,
      paths: {
        wiki_root: wikiRoot,
        transcript_inbox: inboxDir,
        backups: backupDir,
        restore_rehearsal: restoreRoot,
        opencode_config: setup.agent?.config_path ?? configOut,
      },
      live_workspace_sync_folder_guard: {
        passed: !looksLikeCloudSyncedPath(wikiRoot),
        checked_path: wikiRoot,
      },
      remote: {
        url: redactRemote(remoteUrl),
        kind: options.remoteUrl === undefined ? "local-bare-standin" : "user-provided",
        head: remoteHead,
      },
      cli: {
        user_command: "openwiki",
        smoke_runner: `${process.execPath} --no-warnings --import tsx ${path.relative(REPO_ROOT, CLI_ENTRY)}`,
      },
      opencode: {
        install_profile: opencodeInstall.profile,
        install_scope: opencodeInstall.install_scope,
        config_path: setup.agent?.config_path ?? configOut,
        tool_mode: setup.agent?.tool_mode,
        transport: setup.agent?.transport,
        installed_files: opencodeInstall.files,
        meeting_curator_agent_present: opencodeInstall.files.includes(".opencode/agents/openwiki-meeting-curator.md"),
      },
      services: {
        sync_enabled: syncEnabled.sync,
        sync: serviceSummary(syncService),
        backup: serviceSummary(backupService),
        inbox: serviceSummary(inboxService),
      },
      transcript: {
        fixture: path.relative(REPO_ROOT, fixturePath),
        copied_to: copiedFixture,
        sha256: fixtureSha,
        watch_status: inboxWatch.runs?.[0]?.status,
        inbox_item_id: inboxItemId,
        source_id: sourceId,
        raw_source_verified: typeof sourceContent.content?.body === "string" && sourceContent.content.body.includes("Transcript Export"),
        inbox_status_after_process: inboxProcess.item.status,
        inbox_payload_bytes: inboxRead.content?.bytes,
      },
      meeting_curation: {
        mode: "deterministic-openwiki-meeting-curator-smoke",
        validation_status: planValidation.status,
        proposal_ids: proposals.map((proposal) => proposal.id),
        proposal_types: proposals.map((proposal) => proposal.page_type),
        required_types_present: ["meeting", "person", "organization", "topic"].every((type) =>
          proposals.some((proposal) => proposal.page_type === type),
        ),
        proposals,
      },
      review_apply: {
        reviewed_proposal_id: review.proposal.id,
        decision_id: review.decision.id,
        applied_proposal_id: apply.proposal.id,
        applied_paths: apply.applied_paths,
        applied_commit_sha: apply.commit,
      },
      sync: {
        status: sync.status,
        operations: sync.operations,
        committed: sync.committed,
        state: syncStatus.sync_state,
        ahead: syncStatus.ahead,
        behind: syncStatus.behind,
        clean: syncStatus.clean,
        remote_head: remoteHead,
      },
      backup: {
        created_backup_id: backupCreate.backup_id,
        verification_status: backupVerify.backup_id === backupCreate.backup_id ? "passed" : "mismatched",
        verify_files_checked: backupVerify.files_checked,
        rehearsal_status: backupRehearse.validation.status,
        rehearsal_issue_count: backupRehearse.validation.issue_count,
        rehearsal_target: backupRehearse.target_root,
      },
      product_notes: [
        "Live OpenCode model quality should be compared against this deterministic fixture before enabling write mode.",
        "The generic file watcher can ingest text, Markdown, and JSON sidecars; downstream provider-specific importers can normalize proprietary exports before dropping files into the inbox.",
        "The service installer is platform-aware; CI uses skipped activation while a personal workstation should activate launchd or systemd services.",
      ],
      commands,
    };

    assertEvidence(evidence);
    if (options.evidenceOut !== undefined) {
      await mkdir(path.dirname(path.resolve(options.evidenceOut)), { recursive: true });
      await writeFile(path.resolve(options.evidenceOut), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (cleanup !== undefined) {
      await rm(cleanup, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = { keep: false, activateServices: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--activate-services") {
      options.activateServices = true;
    } else if (arg === "--wiki-root") {
      options.wikiRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--inbox-dir") {
      options.inboxDir = requireValue(argv, ++index, arg);
    } else if (arg === "--backup-dir") {
      options.backupDir = requireValue(argv, ++index, arg);
    } else if (arg === "--restore-root") {
      options.restoreRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--remote-url") {
      options.remoteUrl = requireValue(argv, ++index, arg);
    } else if (arg === "--fixture") {
      options.fixture = requireValue(argv, ++index, arg);
    } else if (arg === "--evidence-out") {
      options.evidenceOut = requireValue(argv, ++index, arg);
    } else if (arg === "--service-home") {
      options.serviceHome = requireValue(argv, ++index, arg);
    } else if (arg === "--temp-root") {
      options.tempRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--json") {
      // The script always emits JSON; accept --json so it behaves like other OpenWiki smoke scripts.
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function runCliJson({ displayArgs, commands, env = {} }) {
  const result = await runCommand({
    display: ["openwiki", ...displayArgs],
    actual: [process.execPath, "--no-warnings", "--import", "tsx", CLI_ENTRY, ...displayArgs],
    cwd: REPO_ROOT,
    commands,
    env,
  });
  return JSON.parse(result.stdout);
}

async function runCommand({ display, actual, cwd, commands, env = {} }) {
  const startedAt = new Date().toISOString();
  const [command, ...args] = actual;
  if (command === undefined) {
    throw new Error("Cannot run an empty command");
  }
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });
  });
  commands.push({
    command: display.map(shellArg).join(" "),
    exit_code: result.exitCode,
    started_at: startedAt,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${display.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function configureLocalGitIdentity(wikiRoot, commands) {
  await runCommand({
    display: ["git", "-C", wikiRoot, "config", "user.name", "OpenWiki Dogfood"],
    actual: ["git", "-C", wikiRoot, "config", "user.name", "OpenWiki Dogfood"],
    cwd: REPO_ROOT,
    commands,
  });
  await runCommand({
    display: ["git", "-C", wikiRoot, "config", "user.email", "dogfood@openwiki.local"],
    actual: ["git", "-C", wikiRoot, "config", "user.email", "dogfood@openwiki.local"],
    cwd: REPO_ROOT,
    commands,
  });
}

function serviceInstallEnv(serviceHome, activateServices) {
  return activateServices
    ? {}
    : {
        OPENWIKI_SERVICE_HOME: serviceHome,
        OPENWIKI_SERVICE_PLATFORM: "linux",
        OPENWIKI_SERVICE_SKIP_ACTIVATE: "1",
      };
}

function firstInboxItemId(inboxWatch) {
  const item = inboxWatch.items?.[0] ?? inboxWatch.runs?.[0]?.details?.items?.[0];
  if (typeof item?.id !== "string") {
    throw new Error("Inbox watch did not submit a listable item");
  }
  return item.id;
}

function sourceIdFromProcess(inboxProcess) {
  if (typeof inboxProcess.source?.id !== "string") {
    throw new Error("Inbox process did not create a source");
  }
  return inboxProcess.source.id;
}

function buildDogfoodMeetingPlan(inboxItemId, sourceId) {
  return buildMeetingCurationPlan({
    inboxItemId,
    sourceId,
    title: "Acme Launch Sync",
    date: "2026-05-31",
    summary: "Alice, Bob, and Jordan discussed transcript import, launch readiness, and private GitHub sync.",
    transcriptFacts: [
      "Alice Chen from Acme Launch Operations attended the meeting.",
      "Bob Rivera from OpenWiki owns documenting the transcript-to-OpenWiki sync workflow.",
      "Jordan Patel from Acme Product said Acme will send weekly transcript exports after launch operations meetings.",
      "The first test should run in proposal mode, not write mode.",
    ],
    agentInterpretation: [
      "This transcript should create durable meeting, person, organization, project, and topic proposals for human review.",
    ],
    entities: [
      {
        page_type: "person",
        title: "Alice Chen",
        organization: "Acme",
        evidence: "Alice Chen represented Acme Launch Operations and owns confirming proposal reviewers.",
      },
      {
        page_type: "person",
        title: "Bob Rivera",
        organization: "OpenWiki",
        evidence: "Bob owns documenting the transcript-to-OpenWiki sync workflow.",
      },
      {
        page_type: "person",
        title: "Jordan Patel",
        organization: "Acme",
        evidence: "Jordan owns collecting the next launch operations transcript.",
      },
      {
        page_type: "organization",
        title: "Acme",
        evidence: "Acme will send weekly transcript exports.",
      },
      {
        page_type: "project",
        title: "Transcript Import",
        evidence: "The meeting focused on importing transcript exports into OpenWiki.",
      },
      {
        page_type: "topic",
        title: "Private GitHub Sync",
        evidence: "The meeting identified private GitHub sync as a key topic.",
      },
      {
        page_type: "topic",
        title: "Meeting Automation",
        evidence: "The meeting discussed autonomous transcript-to-wiki processing.",
      },
    ],
    decisions: [
      {
        title: "Use Proposal Mode For First Transcript Dogfood",
        summary: "The first transcript-to-OpenWiki test runs in proposal mode, not write mode.",
      },
      {
        title: "Send Weekly Transcript Exports",
        summary: "Acme will send weekly transcript exports after each launch operations meeting.",
      },
    ],
    actions: [
      {
        title: "Document Transcript To OpenWiki Sync Workflow",
        owner: "Bob Rivera",
      },
      {
        title: "Confirm Meeting Proposal Reviewers",
        owner: "Alice Chen",
      },
      {
        title: "Collect Next Launch Operations Transcript",
        owner: "Jordan Patel",
      },
    ],
    ambiguities: [
      "The due date for Bob's documentation task was not stated.",
      "The private GitHub repository URL is user-provided.",
    ],
  });
}

async function readRemoteHead(remoteUrl, branch, commands) {
  const result = await runCommand({
    display: ["git", "ls-remote", "--heads", remoteUrl, branch],
    actual: ["git", "ls-remote", "--heads", remoteUrl, branch],
    cwd: REPO_ROOT,
    commands,
  });
  const [sha] = result.stdout.trim().split(/\s+/);
  if (sha === undefined || sha.length < 40) {
    throw new Error(`Remote ${remoteUrl} does not contain branch ${branch}`);
  }
  return sha;
}

function serviceSummary(result) {
  return {
    installed: result.installed,
    platform: result.platform,
    activation_status: result.activation?.status,
    command: result.plan?.command,
    activation_commands: result.activation?.commands,
  };
}

async function sha256File(filePath) {
  const body = await readFile(filePath);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function looksLikeCloudSyncedPath(filePath) {
  return /(?:Google Drive|iCloud Drive|Dropbox|OneDrive)/i.test(filePath);
}

function redactRemote(remoteUrl) {
  return remoteUrl.replace(/:\/\/([^/@]+)@/, "://***@");
}

function shellArg(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function assertEvidence(evidence) {
  const failures = [];
  if (evidence.opencode.tool_mode !== "proposal") {
    failures.push("OpenCode MCP was not configured in proposal mode");
  }
  if (evidence.opencode.transport !== "stdio") {
    failures.push("OpenCode MCP was not configured for stdio");
  }
  if (!evidence.opencode.meeting_curator_agent_present) {
    failures.push("OpenCode meeting curator agent was not installed");
  }
  if (!evidence.transcript.raw_source_verified) {
    failures.push("Raw transcript source was not verified");
  }
  if (!evidence.meeting_curation.required_types_present) {
    failures.push("Meeting/person/organization/topic proposals were not all created");
  }
  if (evidence.review_apply.applied_commit_sha === undefined) {
    failures.push("No applied proposal commit was recorded");
  }
  if (evidence.sync.status !== "synced" || evidence.sync.remote_head.length < 40) {
    failures.push("Git sync did not push to the remote");
  }
  if (evidence.backup.verification_status !== "passed" || evidence.backup.rehearsal_status !== "passed") {
    failures.push("Backup verification or restore rehearsal did not pass");
  }
  if (evidence.product_notes.length < 3) {
    failures.push("Expected at least three product notes");
  }
  if (failures.length > 0) {
    throw new Error(`Dogfood evidence failed acceptance checks:\n- ${failures.join("\n- ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
