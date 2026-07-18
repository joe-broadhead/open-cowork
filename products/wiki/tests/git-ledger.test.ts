import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { configureGitRemote, diffVersions, getHistory, getHistoryForPath, gitPull, gitPush, gitRemoteReachability, gitRemoteStatus, InvalidGitRevisionError, listRecentChanges, readCommit } from "@openwiki/git";
import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace, listEvents } from "@openwiki/repo";
import { buildSearchIndex, searchWiki } from "@openwiki/search";
import { withWriteCoordination } from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("reads Git-backed history, diffs, and recent changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-ledger-"));
  try {
    await createWorkspace(root, "Git Ledger Wiki");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    const initial = await git(root, ["rev-parse", "HEAD"]);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nGit history smoke coverage keeps the canonical ledger inspectable.\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Update agent memory"]);
    const updated = await git(root, ["rev-parse", "HEAD"]);

    const history = await getHistory(root, "page:concept:agent-memory");
    assert.equal(history.is_git_repo, true);
    assert.equal(history.path, "wiki/concepts/agent-memory.md");
    assert.equal(history.commits.length, 2);
    assert.equal(history.commits[0]?.subject, "Update agent memory");
    const pathHistory = await getHistoryForPath(root, "page:concept:agent-memory", "wiki/concepts/agent-memory.md");
    assert.equal(pathHistory.path, "wiki/concepts/agent-memory.md");
    assert.equal(pathHistory.commits[0]?.subject, "Update agent memory");

    const diff = await diffVersions({
      root,
      id: "page:concept:agent-memory",
      from: initial.trim(),
      to: updated.trim(),
    });
    assert.match(diff.diff, /Git history smoke coverage/);

    const changes = await listRecentChanges(root, 2);
    assert.equal(changes.changes[0]?.subject, "Update agent memory");
    assert.ok(changes.changes[0]?.files.some((file) => file.path === "wiki/concepts/agent-memory.md"));

    await buildSearchIndex(root);
    const changeSearch = await searchWiki(root, { query: "Update agent memory", types: ["recent_change"], limit: 5 });
    assert.equal(changeSearch.results[0]?.type, "recent_change");
    assert.equal(changeSearch.results[0]?.id, `commit:${changes.changes[0]?.short_sha}`);

    const httpHistory = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/pages/page%3Aconcept%3Aagent-memory/history?limit=2",
    );
    assert.equal(httpHistory.status, 200);
    assert.equal((httpHistory.body as { commits: Array<{ subject: string }> }).commits[0]?.subject, "Update agent memory");
    const firstHttpHistoryPage = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/pages/page%3Aconcept%3Aagent-memory/history?limit=1",
    );
    assert.equal(firstHttpHistoryPage.status, 200);
    const firstHttpHistoryBody = firstHttpHistoryPage.body as { commits: Array<{ subject: string }>; next_cursor?: string };
    assert.equal(firstHttpHistoryBody.commits.length, 1);
    assert.ok(firstHttpHistoryBody.next_cursor);
    const secondHttpHistoryPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/pages/page%3Aconcept%3Aagent-memory/history?limit=1&cursor=${encodeURIComponent(firstHttpHistoryBody.next_cursor ?? "")}`,
    );
    assert.equal(secondHttpHistoryPage.status, 200);
    assert.notEqual(
      (secondHttpHistoryPage.body as { commits: Array<{ subject: string }> }).commits[0]?.subject,
      firstHttpHistoryBody.commits[0]?.subject,
    );
    const firstRecentChangePage = await routeHttpRequest(root, "GET", "/api/v1/recent-changes?limit=1");
    assert.equal(firstRecentChangePage.status, 200);
    const firstRecentChangeBody = firstRecentChangePage.body as { changes: Array<{ short_sha: string }>; next_cursor?: string };
    assert.equal(firstRecentChangeBody.changes.length, 1);
    assert.ok(firstRecentChangeBody.next_cursor);
    const secondRecentChangePage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/recent-changes?limit=1&cursor=${encodeURIComponent(firstRecentChangeBody.next_cursor ?? "")}`,
    );
    assert.equal(secondRecentChangePage.status, 200);
    assert.notEqual(
      (secondRecentChangePage.body as { changes: Array<{ short_sha: string }> }).changes[0]?.short_sha,
      firstRecentChangeBody.changes[0]?.short_sha,
    );

    const httpDiff = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/pages/page%3Aconcept%3Aagent-memory/diff?from=${initial.trim()}&to=${updated.trim()}`,
    );
    assert.equal(httpDiff.status, 200);
    assert.match((httpDiff.body as { diff: string }).diff, /Git history smoke coverage/);

    const mcpHistory = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wiki.get_history",
        arguments: { id: "page:concept:agent-memory", limit: 2 },
      },
    });
    assert.equal(
      (mcpHistory as { structuredContent: { commits: Array<{ subject: string }> } }).structuredContent.commits[0]
        ?.subject,
      "Update agent memory",
    );

    const mcpChanges = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wiki.list_recent_changes",
        arguments: { limit: 1 },
      },
    });
    assert.equal(
      (mcpChanges as { structuredContent: { changes: Array<{ subject: string }> } }).structuredContent.changes[0]
        ?.subject,
      "Update agent memory",
    );

    const mcpResources = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    const resourceUris = (mcpResources as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri);
    assert.ok(resourceUris.includes(`openwiki://commit/${updated.trim()}`));

    const commitResource = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: {
        uri: `openwiki://commit/${updated.trim()}`,
      },
    });
    const commitText = (commitResource as { contents: Array<{ text: string }> }).contents[0]?.text ?? "";
    assert.match(commitText, /Update agent memory/);
    assert.match(commitText, /wiki\/concepts\/agent-memory\.md/);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nHTTP commit_changes records OpenWiki-managed changes in Git.\n",
    );
    const deniedCommit = await routeHttpRequest(root, "POST", "/api/v1/commit", {
      message: "Denied commit",
      all: true,
    });
    assert.equal(deniedCommit.status, 403);

    await writeFile(path.join(root, "outside-openwiki.txt"), "HTTP commit must reject unmanaged files.\n");
    await git(root, ["add", "outside-openwiki.txt"]);
    const deniedUnmanagedCommit = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/commit",
      {
        message: "Denied unmanaged commit",
        actor_id: "actor:user:maintainer",
      },
      { scopes: ["wiki:commit"] },
    );
    assert.equal(deniedUnmanagedCommit.status, 403);
    await git(root, ["reset", "--", "outside-openwiki.txt"]);
    await rm(path.join(root, "outside-openwiki.txt"), { force: true });

    const httpCommit = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/commit",
      {
        message: "Commit via HTTP",
        actor_id: "actor:user:maintainer",
        all: true,
      },
      { scopes: ["wiki:commit"] },
    );
    assert.equal(httpCommit.status, 201);
    const httpCommitBody = httpCommit.body as {
      committed: boolean;
      status: string;
      short_sha: string;
      staged_paths: string[];
      event: { type: string; operation: string; record_id?: string; data?: { sha?: string; short_sha?: string } };
    };
    assert.equal(httpCommitBody.committed, true);
    assert.equal(httpCommitBody.status, "committed");
    assert.ok(httpCommitBody.staged_paths.includes("wiki/concepts/agent-memory.md"));
    assert.equal(httpCommitBody.event.type, "git.committed");
    assert.equal(httpCommitBody.event.operation, "wiki.commit_changes");
    assert.equal(httpCommitBody.event.record_id, `commit:${httpCommitBody.short_sha}`);
    assert.equal(httpCommitBody.event.data?.short_sha, httpCommitBody.short_sha);
    assert.match(httpCommitBody.event.data?.sha ?? "", /^[0-9a-f]{40}$/);
    const eventsAfterHttpCommit = await listEvents(root, 20);
    const persistedHttpCommitEvent = eventsAfterHttpCommit.events.find(
      (event) => event.type === "git.committed" && event.record_id === `commit:${httpCommitBody.short_sha}`,
    );
    assert.equal(persistedHttpCommitEvent?.data?.short_sha, httpCommitBody.short_sha);
    assert.equal(persistedHttpCommitEvent?.data?.sha, httpCommitBody.event.data?.sha);
    assert.doesNotMatch(await git(root, ["status", "--short"]), /events\/events\.jsonl/);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nCLI commit_changes can commit the same managed path set.\n",
    );
    const { stdout: cliCommitStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "commit",
        "--message",
        "Commit via CLI",
        "--all",
        "--actor",
        "actor:user:cli",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliCommit = JSON.parse(cliCommitStdout) as { committed: boolean; staged_paths: string[] };
    assert.equal(cliCommit.committed, true);
    assert.ok(cliCommit.staged_paths.includes("wiki/concepts/agent-memory.md"));
    assert.doesNotMatch(await git(root, ["status", "--short"]), /events\/events\.jsonl/);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nCLI commit --path stages only the requested OpenWiki path.\n",
    );
    await appendFile(
      path.join(root, "sources", "manifests", "source_0001.yaml"),
      "\nnotes: left intentionally dirty by selective commit test\n",
    );
    const { stdout: selectedCliCommitStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "commit",
        "--message",
        "Commit selected path via CLI",
        "--path",
        "wiki/concepts/agent-memory.md",
        "--actor",
        "actor:user:cli",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const selectedCliCommit = JSON.parse(selectedCliCommitStdout) as { committed: boolean; staged_paths: string[] };
    assert.equal(selectedCliCommit.committed, true);
    assert.ok(selectedCliCommit.staged_paths.includes("wiki/concepts/agent-memory.md"));
    assert.equal(selectedCliCommit.staged_paths.includes("sources/manifests/source_0001.yaml"), false);
    const statusAfterSelectedCommit = await git(root, ["status", "--short"]);
    assert.match(statusAfterSelectedCommit, /sources\/manifests\/source_0001\.yaml/);
    assert.doesNotMatch(statusAfterSelectedCommit, /events\/events\.jsonl/);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nCLI commit accepts --path before the command token.\n",
    );
    const { stdout: preCommandPathCommitStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "--path",
        "wiki/concepts/agent-memory.md",
        "commit",
        "--message",
        "Commit selected path with pre-command option",
        "--actor",
        "actor:user:cli",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const preCommandPathCommit = JSON.parse(preCommandPathCommitStdout) as { committed: boolean; staged_paths: string[] };
    assert.equal(preCommandPathCommit.committed, true);
    assert.ok(preCommandPathCommit.staged_paths.includes("wiki/concepts/agent-memory.md"));
    assert.equal(preCommandPathCommit.staged_paths.includes("sources/manifests/source_0001.yaml"), false);
    assert.match(await git(root, ["status", "--short"]), /sources\/manifests\/source_0001\.yaml/);

    const mcpCommit = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "wiki.commit_changes",
          arguments: {
            message: "No page changes",
            paths: ["wiki/concepts/agent-memory.md"],
            actor_id: "actor:user:mcp",
          },
        },
      },
      { toolMode: "write" },
    );
    assert.equal(
      (mcpCommit as { structuredContent: { committed: boolean; status: string } }).structuredContent.committed,
      false,
    );
    assert.equal(
      (mcpCommit as { structuredContent: { committed: boolean; status: string } }).structuredContent.status,
      "no_changes",
    );

    const changesAfterCommit = await listRecentChanges(root, 10);
    const subjectsAfterCommit = changesAfterCommit.changes.map((change) => change.subject);
    assert.ok(subjectsAfterCommit.includes("Commit selected path via CLI"));
    assert.ok(subjectsAfterCommit.includes("Commit via CLI"));
    assert.ok(subjectsAfterCommit.includes("Commit via HTTP"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects Git option-looking revisions before invoking diff or show", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-revision-"));
  const output = path.join(os.tmpdir(), `openwiki-git-revision-${Date.now()}.txt`);
  try {
    await createWorkspace(root, "Git Revision Wiki");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nUnsafe revision inputs must never become Git options.\n",
    );

    const injectedRevision = `--output=${output}`;
    await assert.rejects(
      diffVersions({ root, id: "page:concept:agent-memory", from: injectedRevision }),
      InvalidGitRevisionError,
    );
    await assert.rejects(readCommit(root, injectedRevision), InvalidGitRevisionError);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);

    const httpDiff = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/pages/page%3Aconcept%3Aagent-memory/diff?from=${encodeURIComponent(injectedRevision)}`,
    );
    assert.equal(httpDiff.status, 400);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);

    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "wiki.diff_versions",
          arguments: { id: "page:concept:agent-memory", from: injectedRevision },
        },
      }),
      InvalidGitRevisionError,
    );
    await assert.rejects(
      handleMcpRequest(root, {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: `openwiki://commit/${injectedRevision}` },
      }),
      InvalidGitRevisionError,
    );
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  } finally {
    await rm(output, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs OpenWiki Git workspaces with a configured remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-remote-"));
  const peer = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-peer-"));
  const remote = path.join(os.tmpdir(), "openwiki-git-remote-" + Date.now() + ".git");
  const restoreLocalGitRemotes = allowLocalGitRemotesForTest();
  try {
    await execFileAsync("git", ["init", "--bare", remote]);
    await createWorkspace(root, "Remote Wiki");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    await git(root, ["branch", "-M", "main"]);
    await git(root, ["remote", "add", "origin", remote]);

    const statusBeforePush = await gitRemoteStatus(root);
    assert.equal(statusBeforePush.is_git_repo, true);
    assert.equal(statusBeforePush.branch, "main");
    assert.equal(statusBeforePush.remote, "origin");
    assert.equal(statusBeforePush.clean, true);
    assert.equal(statusBeforePush.remote_url, remote);

    const pushed = await gitPush(root, { remote: "origin", branch: "main" });
    assert.equal(pushed.status, "pushed");
    assert.equal(pushed.remote, "origin");
    assert.equal(pushed.branch, "main");
    await assert.rejects(gitPull(root, { remote: "--upload-pack=/tmp/pwn", branch: "main" }), /Git remote name/);
    await assert.rejects(gitPush(root, { remote: "origin", branch: "--output=/tmp/pwn" }), /Git branch name/);

    const cliStatusOutput = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "git",
        "status",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliStatus = JSON.parse(cliStatusOutput.stdout) as { branch: string; remote: string; clean: boolean };
    assert.equal(cliStatus.branch, "main");
    assert.equal(cliStatus.remote, "origin");
    assert.equal(cliStatus.clean, true);

    const httpStatus = await routeHttpRequest(root, "GET", "/api/v1/git/status");
    assert.equal(httpStatus.status, 200);
    assert.equal((httpStatus.body as { branch: string; remote: string }).branch, "main");
    assert.equal((httpStatus.body as { branch: string; remote: string }).remote, "origin");

    const deniedPush = await routeHttpRequest(root, "POST", "/api/v1/git/push", { remote: "origin", branch: "main" });
    assert.equal(deniedPush.status, 403);

    const httpPush = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/git/push",
      { remote: "origin", branch: "main" },
      { scopes: ["wiki:publish"] },
    );
    assert.equal(httpPush.status, 200);
    assert.equal((httpPush.body as { status: string }).status, "pushed");

    const mcpStatus = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "wiki.git_status",
        arguments: {},
      },
    });
    assert.equal(
      (mcpStatus as { structuredContent: { branch: string; clean: boolean } }).structuredContent.branch,
      "main",
    );

    const mcpPush = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "wiki.git_push",
          arguments: { remote: "origin", branch: "main" },
        },
      },
      { toolMode: "write" },
    );
    assert.equal((mcpPush as { structuredContent: { status: string } }).structuredContent.status, "pushed");

    await execFileAsync("git", ["clone", "--branch", "main", remote, peer]);
    await git(peer, ["config", "user.name", "OpenWiki Peer"]);
    await git(peer, ["config", "user.email", "peer@example.com"]);
    await appendFile(
      path.join(peer, "wiki", "concepts", "agent-memory.md"),
      "\nPeer edits can be fast-forward pulled into the deployed wiki.\n",
    );
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "Peer update"]);
    await git(peer, ["push", "origin", "HEAD:main"]);

    const pulled = await gitPull(root, { remote: "origin", branch: "main" });
    assert.equal(pulled.status, "pulled");
    const pulledPage = await readFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "utf8");
    assert.match(pulledPage, /Peer edits can be fast-forward pulled/);

    await appendFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "\nDirty worktrees should not sync with remotes.\n",
    );
    await assert.rejects(gitPull(root, { remote: "origin", branch: "main" }), /uncommitted OpenWiki workspace changes/);
    await assert.rejects(gitPush(root, { remote: "origin", branch: "main" }), /uncommitted OpenWiki workspace changes/);
  } finally {
    restoreLocalGitRemotes();
    await rm(root, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("git remote status reports renamed porcelain paths as current paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-status-rename-"));
  try {
    await createWorkspace(root, "Git Rename Wiki");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    await git(root, ["mv", "wiki/concepts/agent-memory.md", "wiki/concepts/agent-memory-renamed.md"]);

    const status = await gitRemoteStatus(root);
    assert.ok(status.staged_paths.includes("wiki/concepts/agent-memory-renamed.md"));
    assert.equal(status.staged_paths.includes("wiki/concepts/agent-memory.md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configures Git remote metadata without storing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-configure-"));
  const remote = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-configure-remote-"));
  const restoreLocalGitRemotes = allowLocalGitRemotesForTest();
  try {
    await createWorkspace(root, "Git Configure Wiki");
    await execFileAsync("git", ["init", "--bare", remote]);

    const defaultConfigured = await configureGitRemote(root, {
      remote: "origin",
      remote_url: remote,
    });
    assert.equal(defaultConfigured.branch, "main");

    const configured = await configureGitRemote(root, {
      remote: "origin",
      branch: "master",
      remote_url: remote,
      credential_ref: "cred:github-wiki",
    });
    assert.equal(configured.is_git_repo, true);
    assert.equal(configured.remote, "origin");
    assert.equal(configured.branch, "master");
    assert.equal(configured.remote_url, remote);

    const config = JSON.parse(await readFile(path.join(root, "openwiki.json"), "utf8")) as {
      runtime?: { git?: { remote?: string; branch?: string; remote_url?: string; credential_ref?: string } };
    };
    assert.equal(config.runtime?.git?.remote, "origin");
    assert.equal(config.runtime?.git?.branch, "master");
    assert.equal(config.runtime?.git?.remote_url, remote);
    assert.equal(config.runtime?.git?.credential_ref, "cred:github-wiki");

    const denied = await routeHttpRequest(root, "POST", "/api/v1/git/configure", { remote: "origin", branch: "master" });
    assert.equal(denied.status, 403);

    const httpConfigured = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/git/configure",
      { remote: "upstream", branch: "master", remote_url: remote, credential_ref: "cred:upstream" },
      { scopes: ["wiki:admin"] },
    );
    assert.equal(httpConfigured.status, 200);
    assert.equal((httpConfigured.body as { credential_ref?: string }).credential_ref, "cred:upstream");

    let release!: () => void;
    let ready!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = withWriteCoordination(
      {
        root,
        operation: "test.hold_git_configure_lock",
        actorId: "actor:user:locker",
        waitMs: 0,
      },
      async () => {
        ready();
        await releasePromise;
      },
    );
    await readyPromise;
    await assert.rejects(
      routeHttpRequest(
        root,
        "POST",
        "/api/v1/git/configure",
        { remote: "busy", branch: "master", remote_url: remote },
        { scopes: ["wiki:admin"] },
      ),
      /OpenWiki write in progress: test\.hold_git_configure_lock/,
    );
    await assert.rejects(
      routeHttpRequest(
        root,
        "POST",
        "/api/v1/workspaces/connect",
        { remote: "busy-workspace", branch: "master", remote_url: remote },
        { scopes: ["wiki:admin"] },
      ),
      /OpenWiki write in progress: test\.hold_git_configure_lock/,
    );
    release();
    await holder;

    const connected = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/workspaces/connect",
      { remote: "workspace", branch: "master", remote_url: remote, credential_ref: "cred:workspace-git" },
      { scopes: ["wiki:admin"] },
    );
    assert.equal(connected.status, 200);
    assert.equal(
      (connected.body as { connection: { credential_ref?: string }; registry: { repos: Array<{ credential_ref?: string }> } }).connection
        .credential_ref,
      "cred:workspace-git",
    );
    assert.equal(
      (connected.body as { connection: { credential_ref?: string }; registry: { repos: Array<{ credential_ref?: string }> } }).registry.repos[0]
        ?.credential_ref,
      "cred:workspace-git",
    );

    await assert.rejects(
      configureGitRemote(root, { remote_url: "https://user:secret@example.com/org/wiki.git" }),
      /must not include credentials/,
    );
  } finally {
    restoreLocalGitRemotes();
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("rejects dangerous git remote URL transports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-remote-guard-"));
  const remote = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-remote-bare-"));
  try {
    await createWorkspace(root, "Remote Guard Wiki");

    // ext:: would execute an arbitrary shell command on a later pull/push.
    await assert.rejects(
      configureGitRemote(root, { remote_url: "ext::sh -c 'touch /tmp/openwiki-pwned'" }),
      /transport helpers/,
    );
    // file:// enables local file/repository disclosure.
    await assert.rejects(
      configureGitRemote(root, { remote_url: "file:///etc/passwd" }),
      /scheme "file" is not allowed/,
    );
    // git:// is unauthenticated.
    await assert.rejects(
      configureGitRemote(root, { remote_url: "git://example.com/org/wiki.git" }),
      /scheme "git" is not allowed/,
    );

    // Legitimate https remotes are still accepted.
    const https = await configureGitRemote(root, { remote_url: "https://example.com/org/wiki.git" });
    assert.equal(https.remote_url, "https://example.com/org/wiki.git");

    // Local filesystem path remotes are rejected by default for hosted safety.
    await execFileAsync("git", ["init", "--bare", remote]);
    await assert.rejects(
      configureGitRemote(root, { remote_url: remote }),
      /local filesystem remotes require OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1/,
    );

    // Local-only development and test remotes require an explicit opt-in.
    const restoreLocalGitRemotes = allowLocalGitRemotesForTest();
    let local: Awaited<ReturnType<typeof configureGitRemote>>;
    try {
      local = await configureGitRemote(root, { remote_url: remote });
    } finally {
      restoreLocalGitRemotes();
    }
    assert.equal(local.remote_url, remote);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("revalidates out-of-band Git remote URLs before remote operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-remote-revalidate-"));
  try {
    await createWorkspace(root, "Remote Revalidate Wiki");
    await git(root, ["init", "--initial-branch", "master"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    await git(root, ["remote", "add", "origin", "file:///tmp/openwiki-unsafe.git"]);

    await assert.rejects(gitPull(root), /scheme "file" is not allowed/);
    await assert.rejects(gitPush(root), /scheme "file" is not allowed/);
    await assert.rejects(gitRemoteReachability(root), /scheme "file" is not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

function allowLocalGitRemotesForTest(): () => void {
  const previous = process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
  process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
      return;
    }
    process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = previous;
  };
}
