import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";

const execFileAsync = promisify(execFile);

test("CLI sync connects, commits, pushes, reports state, and refuses dirty workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-"));
  const remote = path.join(os.tmpdir(), "openwiki-cli-sync-" + Date.now() + ".git");
  try {
    await execFileAsync("git", ["init", "--bare", remote]);
    await createWorkspace(root, "CLI Sync Wiki");

    const connected = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "connect", "git", "--remote-url", remote, "--branch", "main", "--json"])).stdout) as {
      remote: string;
      branch: string;
      sync?: { remote?: string; branch?: string; mode?: string };
    };
    assert.equal(connected.remote, "origin");
    assert.equal(connected.branch, "main");
    assert.equal(connected.sync?.remote, "origin");
    assert.equal(connected.sync?.branch, "main");
    assert.equal(connected.sync?.mode, "manual");

    const missingBranch = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "check-remote", "--json"])).stdout) as {
      remote_check?: { status?: string };
      diagnostic?: { state?: string };
    };
    assert.equal(missingBranch.remote_check?.status, "missing_branch");
    assert.equal(missingBranch.diagnostic?.state, "remote-branch-missing");

    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);

    const enabled = JSON.parse((await runOpenWikiCli([
      "--root",
      root,
      "sync",
      "enable",
      "--every",
      "15m",
      "--pull-on-start",
      "--push-after-commit",
      "--json",
    ])).stdout) as { sync?: { mode?: string; interval_seconds?: number; pull_on_start?: boolean; push_after_commit?: boolean } };
    assert.equal(enabled.sync?.mode, "auto");
    assert.equal(enabled.sync?.interval_seconds, 900);
    assert.equal(enabled.sync?.pull_on_start, true);
    assert.equal(enabled.sync?.push_after_commit, true);

    const pushed = JSON.parse((await runOpenWikiCli([
      "--root",
      root,
      "sync",
      "now",
      "--push",
      "--message",
      "Initial private wiki sync",
      "--json",
    ])).stdout) as { status: string; operations: string[]; committed?: { committed?: boolean }; push?: { status?: string }; state?: { last_success?: { status?: string } } };
    assert.equal(pushed.status, "synced");
    assert.deepEqual(pushed.operations, ["push"]);
    assert.equal(pushed.committed?.committed, true);
    assert.equal(pushed.push?.status, "pushed");
    assert.equal(pushed.state?.last_success?.status, "synced");

    const watched = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "watch", "--every", "15m", "--once", "--json"])).stdout) as { kind: string; runs: Array<{ status: string; message: string }>; state: { last_success?: { status?: string } } };
    assert.deepEqual([watched.kind, watched.runs[0]?.status, watched.state.last_success?.status], ["sync", "success", "success"]);
    assert.match(watched.runs[0]?.message ?? "", /synced/);

    const status = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "status", "--json"])).stdout) as {
      branch?: string;
      remote?: string;
      clean?: boolean;
      sync_state?: string;
      provider?: string;
      diagnostic?: { state?: string };
      state?: { last_success?: { status?: string } };
    };
    assert.equal(status.branch, "main");
    assert.equal(status.remote, "origin");
    assert.equal(status.clean, true);
    assert.equal(status.sync_state, "clean");
    assert.equal(status.provider, "local");
    assert.equal(status.diagnostic?.state, "clean");
    assert.equal(status.state?.last_success?.status, "synced");

    const reachable = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "check-remote", "--json"])).stdout) as {
      remote_check?: { status?: string };
      diagnostic?: { state?: string };
    };
    assert.equal(reachable.remote_check?.status, "reachable");
    assert.equal(reachable.diagnostic?.state, "clean");

    const doctor = JSON.parse((await runOpenWikiCli(["--root", root, "doctor", "--json"])).stdout) as {
      checks: Array<{ name: string; status: string }>;
    };
    assert.ok(doctor.checks.some((check) => check.name === "sync-config" && check.status === "pass"));
    assert.ok(doctor.checks.some((check) => check.name === "sync-state" && check.status === "pass"));

    await appendFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "\nDirty sync attempts must be explicit.\n");
    const dirtyFailure = await runOpenWikiCliExpectFailure(["--root", root, "sync", "now", "--push", "--json"]);
    const dirtyJson = JSON.parse(dirtyFailure.stdout) as { status: string; error?: string; recovery?: string[] };
    assert.equal(dirtyJson.status, "failed");
    assert.match(dirtyJson.error ?? "", /uncommitted changes/);
    assert.ok((dirtyJson.recovery ?? []).some((line) => line.includes("--message")));

    await assert.rejects(
      runOpenWikiCli(["--root", root, "sync", "connect", "git", "--remote-url", "ext::sh -c 'touch /tmp/openwiki-pwned'", "--json"]),
      /transport helpers/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("CLI sync status distinguishes ahead, behind, and diverged histories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-states-"));
  const peer = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-states-peer-"));
  const remote = path.join(os.tmpdir(), "openwiki-cli-sync-states-" + Date.now() + ".git");
  try {
    await execFileAsync("git", ["init", "--bare", remote]);
    await createWorkspace(root, "CLI Sync State Wiki");
    await runOpenWikiCli(["--root", root, "sync", "connect", "git", "--remote-url", remote, "--branch", "main", "--json"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await runOpenWikiCli(["--root", root, "sync", "now", "--push", "--message", "Initial sync", "--json"]);

    await appendFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "\nAhead state.\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Ahead state"]);
    const ahead = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "status", "--json"])).stdout) as {
      sync_state?: string;
      diagnostic?: { commands?: string[] };
    };
    assert.equal(ahead.sync_state, "ahead");
    assert.ok(ahead.diagnostic?.commands?.includes("openwiki sync now --push"));

    await git(root, ["push", "origin", "HEAD:main"]);
    await rm(peer, { recursive: true, force: true });
    await execFileAsync("git", ["clone", "--branch", "main", remote, peer]);
    await git(peer, ["config", "user.name", "OpenWiki Test"]);
    await git(peer, ["config", "user.email", "openwiki@example.com"]);
    await appendFile(path.join(peer, "wiki", "concepts", "agent-memory.md"), "\nBehind state.\n");
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "Behind state"]);
    await git(peer, ["push", "origin", "main"]);
    await git(root, ["fetch", "origin", "main"]);
    const behind = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "status", "--json"])).stdout) as {
      sync_state?: string;
      diagnostic?: { commands?: string[] };
    };
    assert.equal(behind.sync_state, "behind");
    assert.ok(behind.diagnostic?.commands?.includes("openwiki sync now --pull"));

    await appendFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "\nDiverged state.\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Diverged state"]);
    const diverged = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "status", "--json"])).stdout) as {
      sync_state?: string;
      diagnostic?: { recommended_action?: string };
    };
    assert.equal(diverged.sync_state, "diverged");
    assert.match(diverged.diagnostic?.recommended_action ?? "", /will not merge or overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("CLI sync now reports missing remotes as an actionable failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-no-remote-"));
  try {
    await createWorkspace(root, "CLI Sync No Remote Wiki");
    await git(root, ["init", "--initial-branch", "main"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    const failed = await runOpenWikiCliExpectFailure(["--root", root, "sync", "now", "--push", "--json"]);
    const body = JSON.parse(failed.stdout) as { status: string; error?: string; state?: { last_failure?: { status?: string } } };
    assert.equal(body.status, "failed");
    assert.match(body.error ?? "", /no_remote/);
    assert.equal(body.state?.last_failure?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI sync status and repair report inspectable Git conflict state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-conflict-"));
  try {
    await createWorkspace(root, "CLI Sync Conflict Wiki");
    await git(root, ["init", "--initial-branch", "main"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    const pagePath = path.join(root, "wiki", "concepts", "agent-memory.md");
    await git(root, ["checkout", "-b", "conflicting-edit"]);
    await writeFile(pagePath, "# Agent Memory\n\nBranch edit.\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Branch edit"]);
    await git(root, ["checkout", "main"]);
    await writeFile(pagePath, "# Agent Memory\n\nMain edit.\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Main edit"]);
    await assert.rejects(git(root, ["merge", "conflicting-edit"]), /conflict|CONFLICT/i);

    const status = JSON.parse((await runOpenWikiCli(["--root", root, "sync", "status", "--json"])).stdout) as {
      conflict_state?: string;
      conflict_paths?: string[];
    };
    assert.equal(status.conflict_state, "conflicted");
    assert.ok(status.conflict_paths?.includes("wiki/concepts/agent-memory.md"));

    const repair = await runOpenWikiCliExpectFailure(["--root", root, "sync", "repair", "--json"]);
    const repairJson = JSON.parse(repair.stdout) as { status: string; conflict?: { has_conflicts?: boolean; paths?: string[] }; recovery?: string[] };
    assert.equal(repairJson.status, "manual_intervention_required");
    assert.equal(repairJson.conflict?.has_conflicts, true);
    assert.ok(repairJson.conflict?.paths?.includes("wiki/concepts/agent-memory.md"));
    assert.ok((repairJson.recovery ?? []).some((line) => line.includes("git status")));

    const explained = await runOpenWikiCliExpectFailure(["--root", root, "sync", "explain-conflict", "--json"]);
    const explanation = JSON.parse(explained.stdout) as { diagnostic?: { state?: string; commands?: string[] }; conflict_paths?: string[] };
    assert.equal(explanation.diagnostic?.state, "conflicted");
    assert.ok(explanation.conflict_paths?.includes("wiki/concepts/agent-memory.md"));
    assert.ok(explanation.diagnostic?.commands?.includes("git status"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI sync remote checks distinguish auth failures without leaking credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-auth-"));
  const server = createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"OpenWiki\"" });
    response.end("auth required");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const remoteUrl = `http://127.0.0.1:${address.port}/private-openwiki.git`;
    await createWorkspace(root, "CLI Sync Auth Wiki");
    await runOpenWikiCli(["--root", root, "sync", "connect", "git", "--remote-url", remoteUrl, "--branch", "main", "--json"]);
    await git(root, ["config", "credential.helper", ""]);

    const checked = await runOpenWikiCliExpectFailure(["--root", root, "sync", "check-remote", "--timeout-ms", "3000", "--json"]);
    const checkJson = JSON.parse(checked.stdout) as {
      remote_check?: { status?: string; error?: string; remote_url?: string };
      diagnostic?: { state?: string; recommended_action?: string };
    };
    assert.equal(checkJson.remote_check?.status, "auth_failed");
    assert.equal(checkJson.diagnostic?.state, "auth-failed");
    assert.match(checkJson.diagnostic?.recommended_action ?? "", /credential/);
    assert.equal(checkJson.remote_check?.remote_url, remoteUrl);
    assert.doesNotMatch(checkJson.remote_check?.error ?? "", /token|secret/i);
  } finally {
    await closeHttpServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI sync remote checks classify timed-out probes as network failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sync-timeout-"));
  const sockets = new Set<Socket>();
  const server = createServer((_request, _response) => {
    // Keep the request open until git's exec timeout kills the probe.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const remoteUrl = `http://127.0.0.1:${address.port}/slow-openwiki.git`;
    await createWorkspace(root, "CLI Sync Timeout Wiki");
    await runOpenWikiCli(["--root", root, "sync", "connect", "git", "--remote-url", remoteUrl, "--branch", "main", "--json"]);
    await git(root, ["config", "credential.helper", ""]);

    const checked = await runOpenWikiCliExpectFailure(["--root", root, "sync", "check-remote", "--timeout-ms", "50", "--json"]);
    const checkJson = JSON.parse(checked.stdout) as {
      remote_check?: { status?: string; error?: string; remote_url?: string };
      diagnostic?: { state?: string; recommended_action?: string };
    };
    assert.equal(checkJson.remote_check?.status, "network_failed");
    assert.equal(checkJson.diagnostic?.state, "network-failed");
    assert.match(checkJson.diagnostic?.recommended_action ?? "", /network|DNS|remote/i);
    assert.equal(checkJson.remote_check?.remote_url, remoteUrl);
    assert.doesNotMatch(checkJson.remote_check?.error ?? "", /token|secret/i);
  } finally {
    await closeHttpServer(server, sockets);
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

async function runOpenWikiCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", path.join(process.cwd(), "packages", "cli", "src", "main.ts"), ...args],
    { cwd: process.cwd(), env: { ...process.env, OPENWIKI_ALLOW_LOCAL_GIT_REMOTE: "1" }, maxBuffer: 1024 * 1024 },
  );
}

async function runOpenWikiCliExpectFailure(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    await runOpenWikiCli(args);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
  assert.fail(`Expected openwiki ${args.join(" ")} to fail`);
}

async function closeHttpServer(server: ReturnType<typeof createServer>, sockets: Set<Socket> = new Set()): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
