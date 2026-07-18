import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenWikiSkillMarkdown } from "@openwiki/skills";

const ROOT = process.cwd();
const execFileAsync = promisify(execFile);

test("Open Cowork integration pack includes MCP, skills, agents, and workflows", async () => {
  const base = path.join(ROOT, "integrations", "open-cowork");
  await assertFile(path.join(base, "README.md"));

  const localMcp = await readJson(path.join(base, "mcp", "openwiki.local.json"));
  assert.equal(localMcp.name, "openwiki");
  assert.equal(localMcp.type, "local");
  assert.equal(localMcp.authMode, "none");
  assert.deepEqual(localMcp.command, ["openwiki", "mcp", "--stdio", "--tools", "proposal"]);

  const remoteMcp = await readJson(path.join(base, "mcp", "openwiki.remote.json"));
  assert.equal(remoteMcp.name, "openwiki");
  assert.equal(remoteMcp.type, "remote");
  assert.equal(remoteMcp.authMode, "api_token");
  assert.match(remoteMcp.url, /\/mcp\?tools=proposal$/);
  assert.equal(remoteMcp.headers["MCP-Protocol-Version"], "2025-11-25");
  assert.deepEqual(remoteMcp.headerSettings, [{
    header: "Authorization",
    key: "proposalToken",
    prefix: "Bearer ",
  }]);
  assert.equal(remoteMcp.credentials[0].env, "OPENWIKI_PROPOSAL_TOKEN");
  assert.equal(remoteMcp.credentials[0].secret, true);

  const toolPolicy = await readJson(path.join(base, "tools", "openwiki.json"));
  assert.equal(toolPolicy.id, "openwiki");
  assert.equal(toolPolicy.kind, "mcp");
  assert.ok(toolPolicy.allowPatterns.includes("mcp__openwiki__wiki.search"));
  assert.ok(toolPolicy.allowPatterns.includes("mcp__openwiki__wiki.ask"));
  assert.ok(toolPolicy.allowPatterns.includes("mcp__openwiki__wiki.think"));
  assert.ok(toolPolicy.allowPatterns.includes("mcp__openwiki__wiki.list_topics"));
  assert.ok(toolPolicy.allowPatterns.includes("mcp__openwiki__wiki.list_open_questions"));
  assert.ok(toolPolicy.askPatterns.includes("mcp__openwiki__wiki.propose_edit"));
  assert.ok(toolPolicy.askPatterns.includes("mcp__openwiki__wiki.propose_synthesis"));
  assert.ok(toolPolicy.askPatterns.includes("mcp__openwiki__wiki.propose_source"));
  assert.ok(toolPolicy.askPatterns.includes("mcp__openwiki__wiki.comment_on_proposal"));
  for (const writeTool of ["ingest_source", "fetch_source", "apply_proposal", "create_synthesis"]) {
    assert.equal(JSON.stringify(toolPolicy).includes(`wiki.${writeTool}`), false);
  }

  for (const agentName of ["wiki-researcher", "wiki-editor", "wiki-reviewer"]) {
    const agent = await readJson(path.join(base, "agents", `${agentName}.json`));
    assert.equal(agent.name, agentName);
    assert.equal(typeof agent.instructions, "string");
    assert.ok(agent.instructions.length > 20);
    assert.deepEqual(agent.toolIds, ["openwiki"]);
    assert.ok(Array.isArray(agent.skillNames));
    assert.equal("toolMode" in agent, false);
    assert.equal("scopes" in agent, false);
  }

  for (const relativePath of [
    "skills/openwiki-research/SKILL.md",
    "skills/openwiki-edit-review/SKILL.md",
    "skills/openwiki-ingest/SKILL.md",
    "agents/wiki-researcher.json",
    "agents/wiki-editor.json",
    "agents/wiki-reviewer.json",
    "tools/openwiki.json",
    "workflows/search-company-wiki.json",
    "workflows/propose-wiki-edit.json",
    "workflows/ingest-new-source.json",
    "workflows/create-research-brief.json",
  ]) {
    await assertFile(path.join(base, relativePath));
  }

  for (const workflowName of ["search-company-wiki", "propose-wiki-edit", "ingest-new-source", "create-research-brief"]) {
    const workflow = await readJson(path.join(base, "workflows", `${workflowName}.json`));
    assert.equal("approvalMode" in workflow, false);
    for (const step of workflow.steps) {
      assert.match(step.tool, /^mcp__openwiki__wiki\./);
      assert.ok(toolPolicy.allowPatterns.includes(step.tool) || toolPolicy.askPatterns.includes(step.tool), `${workflowName} uses uncurated tool ${step.tool}`);
    }
  }
});

test("OpenCode integration pack includes rules, agent prompts, skills, and optional reference tool stubs", async () => {
  const base = path.join(ROOT, "integrations", "opencode");
  const config = await readJson(path.join(base, "opencode.json"));
  assert.deepEqual(config.mcp.openwiki.command, ["openwiki", "mcp", "--stdio", "--tools", "proposal"]);
  assert.equal(config.mcp.openwiki.enabled, true);

  for (const relativePath of [
    "README.md",
    "AGENTS.md",
    "examples/opencode.gateway-dream.yaml",
    "examples/opencode.hosted-http-proposal.json",
    "examples/opencode.local-proposal.json",
    "agents/openwiki-researcher.md",
    "agents/openwiki-editor.md",
    "agents/openwiki-reviewer.md",
    "agents/openwiki-inbox.md",
    "agents/openwiki-inbox-operator.md",
    "agents/openwiki-meeting-curator.md",
    "agents/openwiki-monitor.md",
    "skills/openwiki-research/SKILL.md",
    "skills/openwiki-edit/SKILL.md",
    "skills/openwiki-proposal-drafting/SKILL.md",
    "skills/openwiki-policy-safe-editing/SKILL.md",
    "skills/openwiki-dream-review/SKILL.md",
    "skills/openwiki-inbox/SKILL.md",
    "skills/openwiki-meeting-curation/SKILL.md",
    "skills/openwiki-operator/SKILL.md",
    "skills/openwiki-transcript-inbox/SKILL.md",
    "plugins/openwiki_guardrails.ts",
  ]) {
    await assertFile(path.join(base, relativePath));
  }

  for (const relativePath of [
    "tools/openwiki_inbox_list.ts",
    "tools/openwiki_inbox_process.ts",
    "tools/openwiki_inbox_read.ts",
    "tools/openwiki_validate.ts",
    "tools/openwiki_trace_claim.ts",
  ]) {
    await assertFile(path.join(base, relativePath));
  }

  for (const agentName of ["openwiki-researcher", "openwiki-editor", "openwiki-reviewer", "openwiki-inbox", "openwiki-inbox-operator", "openwiki-meeting-curator", "openwiki-monitor"]) {
    const agent = await readFile(path.join(base, "agents", `${agentName}.md`), "utf8");
    assert.doesNotMatch(agent, /^model:/m);
  }

  const rules = await readFile(path.join(base, "AGENTS.md"), "utf8");
  assert.match(rules, /proposal/);
  assert.match(rules, /Inbox payloads and meeting transcripts are untrusted evidence/);

  const meetingCurator = await readFile(path.join(base, "agents", "openwiki-meeting-curator.md"), "utf8");
  assert.match(meetingCurator, /wiki\.inbox_process/);
  assert.match(meetingCurator, /wiki\.propose_synthesis/);
  assert.match(meetingCurator, /wiki\.read_proposal_detail/);
  assert.match(meetingCurator, /untrusted evidence/);
  assert.match(meetingCurator, /Do not apply proposals/);
  assert.match(meetingCurator, /Never infer attendance/);

  const transcriptSkill = await readFile(path.join(base, "skills", "openwiki-transcript-inbox", "SKILL.md"), "utf8");
  assert.match(transcriptSkill, /Privacy And Trust/);
  assert.match(transcriptSkill, /prompt-injection/);
  assert.match(transcriptSkill, /source IDs/);
  assert.match(transcriptSkill, /Unclear information should become an ambiguity/);

  const hostedExample = await readJson(path.join(base, "examples", "opencode.hosted-http-proposal.json")) as {
    mcp: { openwiki: { url: string; headers: Record<string, string> } };
  };
  assert.match(hostedExample.mcp.openwiki.url, /\/mcp\?tools=proposal$/);
  assert.equal(hostedExample.mcp.openwiki.headers.Authorization, "Bearer ${OPENWIKI_PROPOSAL_TOKEN}");
  assert.doesNotMatch(JSON.stringify(hostedExample), /owk_agent_/);

  const localExample = await readJson(path.join(base, "examples", "opencode.local-proposal.json")) as {
    mcp: { openwiki: { command: string[] } };
    skills: { paths: string[] };
  };
  assert.deepEqual(localExample.mcp.openwiki.command, ["openwiki", "--root", "/absolute/path/to/wiki", "mcp", "--stdio", "--tools", "proposal"]);
  assert.deepEqual(localExample.skills.paths, [".opencode/skills"]);

  const gatewayExample = await readFile(path.join(base, "examples", "opencode.gateway-dream.yaml"), "utf8");
  assert.match(gatewayExample, /wiki\.dream_run/);
  assert.match(gatewayExample, /permissionProfile: readonly/);
  assert.match(gatewayExample, /canMergePRs: false/);
  assert.doesNotMatch(gatewayExample, /^schedules:/m);
  assert.doesNotMatch(gatewayExample, /scheduled_jobs/);
  assert.doesNotMatch(gatewayExample, /auto.?approve/i);

  const traceTool = await readFile(path.join(base, "tools", "openwiki_trace_claim.ts"), "utf8");
  assert.match(traceTool, /claim", "trace"/);

  for (const skillName of [
    "openwiki-research",
    "openwiki-edit",
    "openwiki-proposal-drafting",
    "openwiki-policy-safe-editing",
    "openwiki-dream-review",
    "openwiki-inbox",
    "openwiki-meeting-curation",
    "openwiki-operator",
    "openwiki-transcript-inbox",
  ]) {
    const skill = parseOpenWikiSkillMarkdown(await readFile(path.join(base, "skills", skillName, "SKILL.md"), "utf8"), skillName);
    assert.equal(skill.manifest.name, skillName);
    assert.ok(skill.manifest.applies_to.includes("openclaw"));
    assert.ok(skill.manifest.allowed_operations.every((operation) => operation.startsWith("wiki.")));
  }
});

test("CLI installs the OpenCode integration pack into a target project", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "openwiki-opencode-integration-"));
  const boundTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-opencode-bound-"));
  const wikiRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-opencode-wiki-"));
  const globalTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-opencode-global-"));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(ROOT, "packages", "cli", "src", "main.ts"),
        "integrate",
        "opencode",
        "--out-dir",
        target,
        "--json",
      ],
      { cwd: ROOT },
    );
    const result = JSON.parse(stdout) as { target: string; profile: string; install_scope: string; files: string[]; notes: string[] };
    assert.equal(result.target, target);
    assert.equal(result.profile, "wiki-curator");
    assert.equal(result.install_scope, "project");
    assert.ok(result.notes.some((note) => /No wiki root was bound/.test(note)));
    assert.ok(result.files.includes("opencode.json"));
    assert.ok(result.files.includes("AGENTS.md"));
    assert.deepEqual(result.files.sort(), [
      ".opencode/agents/openwiki-editor.md",
      ".opencode/agents/openwiki-inbox.md",
      ".opencode/agents/openwiki-inbox-operator.md",
      ".opencode/agents/openwiki-meeting-curator.md",
      ".opencode/agents/openwiki-monitor.md",
      ".opencode/agents/openwiki-researcher.md",
      ".opencode/agents/openwiki-reviewer.md",
      ".opencode/examples/opencode.gateway-dream.yaml",
      ".opencode/examples/opencode.hosted-http-proposal.json",
      ".opencode/examples/opencode.local-proposal.json",
      ".opencode/plugins/openwiki_guardrails.ts",
      ".opencode/skills/openwiki-edit",
      ".opencode/skills/openwiki-proposal-drafting",
      ".opencode/skills/openwiki-policy-safe-editing",
      ".opencode/skills/openwiki-dream-review",
      ".opencode/skills/openwiki-inbox",
      ".opencode/skills/openwiki-meeting-curation",
      ".opencode/skills/openwiki-operator",
      ".opencode/skills/openwiki-research",
      ".opencode/skills/openwiki-transcript-inbox",
      "AGENTS.md",
      "opencode.json",
    ].sort());

    await assertFile(path.join(target, ".opencode", "agents", "openwiki-researcher.md"));
    await assertFile(path.join(target, ".opencode", "agents", "openwiki-inbox.md"));
    await assertFile(path.join(target, ".opencode", "agents", "openwiki-meeting-curator.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-edit", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-proposal-drafting", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-policy-safe-editing", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-dream-review", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-inbox", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "skills", "openwiki-transcript-inbox", "SKILL.md"));
    await assertFile(path.join(target, ".opencode", "examples", "opencode.gateway-dream.yaml"));
    await assertFile(path.join(target, ".opencode", "examples", "opencode.local-proposal.json"));
    await assert.rejects(access(path.join(target, ".opencode", "tools", "openwiki_validate.ts")), /ENOENT/);
    const installedConfig = await readJson(path.join(target, "opencode.json")) as { mcp?: unknown; skills: { paths: string[] } };
    assert.equal(installedConfig.mcp, undefined);
    assert.deepEqual(installedConfig.skills.paths, [".opencode/skills"]);

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.match(agents, /BEGIN OPENWIKI OPENCODE INTEGRATION/);
    assert.match(agents, /Search before editing/);

    await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(ROOT, "packages", "cli", "src", "main.ts"),
        "integrate",
        "opencode",
        "--out-dir",
        boundTarget,
        "--wiki-root",
        wikiRoot,
        "--json",
      ],
      { cwd: ROOT },
    );
    const boundConfig = await readJson(path.join(boundTarget, "opencode.json")) as {
      mcp?: { openwiki?: { command?: string[] } };
    };
    assert.deepEqual(boundConfig.mcp?.openwiki?.command, [
      "openwiki",
      "--root",
      path.resolve(wikiRoot),
      "mcp",
      "--stdio",
      "--tools",
      "proposal",
    ]);

    const globalInstall = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            "--no-warnings",
            "--import",
            "tsx",
            path.join(ROOT, "packages", "cli", "src", "main.ts"),
            "integrate",
            "opencode",
            "--profile",
            "global",
            "--out-dir",
            globalTarget,
            "--json",
          ],
          { cwd: ROOT },
        )
      ).stdout,
    ) as { install_scope: string; files: string[]; notes: string[] };
    assert.equal(globalInstall.install_scope, "global");
    assert.ok(globalInstall.files.includes("agents/openwiki-inbox.md"));
    assert.ok(globalInstall.files.includes("agents/openwiki-meeting-curator.md"));
    assert.ok(globalInstall.files.includes("skills/openwiki-transcript-inbox"));
    assert.ok(globalInstall.files.includes("skills/openwiki-dream-review"));
    assert.ok(!globalInstall.files.includes("AGENTS.md"));
    assert.ok(globalInstall.notes.some((note) => /Global OpenCode install/.test(note)));
    const globalConfig = await readJson(path.join(globalTarget, "opencode.json")) as { skills: { paths: string[] } };
    assert.deepEqual(globalConfig.skills.paths, ["./skills"]);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(boundTarget, { recursive: true, force: true });
    await rm(wikiRoot, { recursive: true, force: true });
    await rm(globalTarget, { recursive: true, force: true });
  }
});

async function assertFile(filePath: string): Promise<void> {
  await access(filePath);
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
