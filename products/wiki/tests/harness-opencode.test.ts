import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createMaintainerJob, runMaintainerJob } from "@openwiki/harness-opencode";
import { createWorkspace, loadRepository, readPage } from "@openwiki/repo";

const execFileAsync = promisify(execFile);

test("creates an isolated maintainer job packet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-prepare-"));
  try {
    await createWorkspace(root, "Harness Prepare Wiki");
    const job = await createMaintainerJob({
      root,
      targetPageId: "page:concept:agent-memory",
      task: "Inspect the agent memory page.",
      actorId: "actor:agent:opencode",
    });

    assert.equal(job.changed, false);
    assert.match(job.run_id, /^run:\d{4}-\d{2}-\d{2}-001$/);
    const taskPacket = JSON.parse(await readFile(job.task_packet_path, "utf8")) as {
      run_id: string;
      target_ids: string[];
      worktree_path: string;
    };
    assert.equal(taskPacket.run_id, job.run_id);
    assert.deepEqual(taskPacket.target_ids, ["page:concept:agent-memory"]);
    assert.equal(taskPacket.worktree_path, job.worktree_path);

    const copiedPage = await readPage(job.worktree_path, "page:concept:agent-memory");
    assert.equal(copiedPage.title, "Agent Memory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allocates concurrent maintainer jobs without run ID collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-concurrent-"));
  try {
    await createWorkspace(root, "Harness Concurrent Wiki");
    const jobs = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createMaintainerJob({
          root,
          targetPageId: "page:concept:agent-memory",
          task: `Inspect the agent memory page ${index}.`,
        }),
      ),
    );
    assert.equal(new Set(jobs.map((job) => job.run_id)).size, jobs.length);
    assert.equal(new Set(jobs.map((job) => job.run_dir)).size, jobs.length);
    assert.equal(new Set(jobs.map((job) => job.worktree_path)).size, jobs.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copy-mode maintainer jobs reject workspace symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-symlink-"));
  try {
    await createWorkspace(root, "Harness Symlink Wiki");
    await symlink(os.tmpdir(), path.join(root, "outside-link"));
    await assert.rejects(
      createMaintainerJob({
        root,
        targetPageId: "page:concept:agent-memory",
        task: "Prepare a copy-mode workspace.",
      }),
      /refuses symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintainer jobs use a Git worktree when the workspace is a Git repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-git-worktree-"));
  try {
    await createWorkspace(root, "Harness Git Wiki");
    await execFileAsync("git", ["-C", root, "init", "--initial-branch", "master"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "OpenWiki Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "openwiki@example.com"]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Initial wiki"]);

    const job = await createMaintainerJob({
      root,
      targetPageId: "page:concept:agent-memory",
      task: "Use a real Git worktree.",
    });
    const taskPacket = JSON.parse(await readFile(job.task_packet_path, "utf8")) as {
      workspace_mode: string;
      base_commit?: string;
      branch_name: string;
    };
    assert.equal(taskPacket.workspace_mode, "git_worktree");
    assert.ok(taskPacket.base_commit);
    assert.match(taskPacket.branch_name, /^openwiki\/run_/);
    assert.match(await readFile(path.join(job.worktree_path, ".git"), "utf8"), /gitdir:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs a bounded maintainer command and turns page changes into a proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-run-"));
  const scriptPath = path.join(root, "agent-edit.mjs");
  const previousSecret = process.env.OPENWIKI_AGENT_TEST_SECRET;
  try {
    process.env.OPENWIKI_AGENT_TEST_SECRET = "should-not-leak";
    await createWorkspace(root, "Harness Run Wiki");
    await writeFile(
      scriptPath,
      `import { promises as fs } from 'node:fs';
const file = 'wiki/concepts/agent-memory.md';
const raw = await fs.readFile(file, 'utf8');
const next = raw.replace(/# Agent Memory[\\s\\S]*/, '# Agent Memory\\n\\nMaintainer harness generated this OpenWiki proposal.');
await fs.writeFile(file, next);
console.log('updated page from', process.env.OPENWIKI_TASK_PACKET);
console.log('secret', process.env.OPENWIKI_AGENT_TEST_SECRET ?? 'not-set');
`,
    );

    const result = await runMaintainerJob({
      root,
      targetPageId: "page:concept:agent-memory",
      task: "Rewrite the page body through the maintainer harness.",
      actorId: "actor:agent:opencode",
      agentCommand: {
        command: process.execPath,
        args: [scriptPath],
        timeoutMs: 5000,
        allowedCommands: [process.execPath],
      },
    });

    assert.equal(result.changed, true);
    assert.equal(result.command?.exit_code, 0);
    assert.equal(result.command?.timed_out, false);
    assert.match(result.command?.stdout ?? "", /secret not-set/);
    assert.doesNotMatch(result.command?.stdout ?? "", /should-not-leak/);
    assert.ok(result.proposal);
    assert.equal(result.proposal?.status, "open");
    assert.equal(result.proposal?.actor_id, "actor:agent:opencode");

    const originalPage = await readPage(root, "page:concept:agent-memory");
    assert.doesNotMatch(originalPage.body, /Maintainer harness generated/);

    const repo = await loadRepository(root);
    assert.equal(repo.proposals.length, 1);
    assert.equal(repo.proposals[0]?.id, result.proposal?.id);

    const snapshot = await readFile(path.join(root, result.proposal?.snapshot_path ?? ""), "utf8");
    assert.match(snapshot, /Maintainer harness generated this OpenWiki proposal/);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.OPENWIKI_AGENT_TEST_SECRET;
    } else {
      process.env.OPENWIKI_AGENT_TEST_SECRET = previousSecret;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("maintainer commands must be explicitly allowlisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-harness-allowlist-"));
  try {
    await createWorkspace(root, "Harness Allowlist Wiki");
    await assert.rejects(
      runMaintainerJob({
        root,
        targetPageId: "page:concept:agent-memory",
        task: "Attempt a non-allowlisted maintainer command.",
        agentCommand: {
          command: process.execPath,
          args: ["--version"],
          timeoutMs: 5000,
          allowedCommands: ["opencode"],
        },
      }),
      /not allowlisted/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
