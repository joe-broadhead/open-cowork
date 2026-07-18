import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const SOURCE_CLI = [process.execPath, ["--no-warnings", "--import", "tsx", "packages/cli/src/main.ts"]] as const;

test("CLI setup personal prepares a wiki and OpenCode MCP config", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-setup-personal-"));
  try {
    const wikiRoot = path.join(temp, "wiki");
    const configOut = path.join(temp, "opencode.json");
    const backupPath = path.join(temp, "backups");
    const gitRemote = path.join(temp, "remote.git");
    await execFileAsync("git", ["init", "--bare", gitRemote], { cwd: temp });
    const { stdout } = await runSourceCli([
      "setup",
      "personal",
      wikiRoot,
      "--title",
      "Personal Test Wiki",
      "--agent",
      "opencode",
      "--tools",
      "proposal",
      "--git-remote",
      gitRemote,
      "--branch",
      "main",
      "--backup-path",
      backupPath,
      "--config-out",
      configOut,
      "--json",
    ], { OPENWIKI_ALLOW_LOCAL_GIT_REMOTE: "1" });
    const result = JSON.parse(stdout) as {
      profile: string;
      root: string;
      template: string;
      search_index: { recordCount: number };
      index_store: { recordCount: number };
      git_sync: { remote: string; branch: string; remote_url: string };
      backup: { destination: { id: string; path: string } };
      agent: { config_path: string; config: { mcp: { openwiki: { command: string[] } } }; token_value?: string };
      opencode_integration: { provider: string; profile: string; target: string; files: string[] };
      doctor: { status: string; checks: Array<{ name: string; status: string }> };
      actions: Array<{ kind: string; status: string }>;
    };
    assert.equal(result.profile, "personal");
    assert.equal(result.root, wikiRoot);
    assert.equal(result.template, "personal-wiki");
    assert.ok(result.search_index.recordCount > 0);
    assert.ok(result.index_store.recordCount > 0);
    assert.equal(result.git_sync.remote, "origin");
    assert.equal(result.git_sync.branch, "main");
    assert.equal(result.backup.destination.id, "local-backups");
    assert.equal(result.backup.destination.path, backupPath);
    assert.equal(result.agent.config_path, configOut);
    assert.equal(result.agent.token_value, undefined);
    assert.deepEqual(result.agent.config.mcp.openwiki.command, ["openwiki", "--root", wikiRoot, "mcp", "--stdio", "--tools", "proposal"]);
    assert.equal(result.opencode_integration.provider, "opencode");
    assert.equal(result.opencode_integration.profile, "personal-curator");
    assert.equal(result.opencode_integration.target, wikiRoot);
    assert.ok(result.opencode_integration.files.includes(".opencode/agents/openwiki-meeting-curator.md"));
    assert.ok(result.opencode_integration.files.includes("opencode.json"));
    await stat(path.join(wikiRoot, ".openwiki", "index", "openwiki.sqlite"));
    await stat(path.join(wikiRoot, ".openwiki", "index-store", "openwiki.sqlite"));
    await stat(path.join(wikiRoot, ".opencode", "agents", "openwiki-meeting-curator.md"));
    await stat(path.join(wikiRoot, "opencode.json"));
    const writtenConfig = JSON.parse(await readFile(configOut, "utf8")) as { mcp: { openwiki: { command: string[] } } };
    assert.deepEqual(writtenConfig.mcp.openwiki.command, result.agent.config.mcp.openwiki.command);
    const openCodeConfig = JSON.parse(await readFile(path.join(wikiRoot, "opencode.json"), "utf8")) as {
      mcp: { openwiki: { command: string[] } };
      skills: { paths: string[] };
    };
    assert.deepEqual(openCodeConfig.mcp.openwiki.command, ["openwiki", "--root", wikiRoot, "mcp", "--stdio", "--tools", "proposal"]);
    assert.deepEqual(openCodeConfig.skills.paths, [".opencode/skills"]);
    const agentMetadata = JSON.parse(await readFile(path.join(wikiRoot, ".openwiki", "agents", "setup.json"), "utf8")) as {
      client: string;
      tool_mode: string;
      config_path: string;
    };
    assert.equal(agentMetadata.client, "opencode");
    assert.equal(agentMetadata.tool_mode, "proposal");
    assert.equal(agentMetadata.config_path, configOut);
    assert.ok(result.doctor.checks.some((check) => check.name === "agent-mcp-config" && check.status === "pass"));
    assert.ok(result.actions.some((action) => action.kind === "workspace" && action.status === "created"));
    assert.ok(result.actions.some((action) => action.kind === "integration" && action.status === "configured"));

    const rerun = JSON.parse(
      (
        await runSourceCli([
          "setup",
          "personal",
          wikiRoot,
          "--agent",
          "opencode",
          "--tools",
          "proposal",
          "--backup-path",
          backupPath,
          "--config-out",
          configOut,
          "--json",
        ])
      ).stdout,
    ) as { actions: Array<{ kind: string; status: string }> };
    assert.ok(rerun.actions.some((action) => action.kind === "workspace" && action.status === "existing"));
    assert.ok(rerun.actions.some((action) => action.kind === "integration" && action.status === "configured"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("agent configure creates token files and never accepts raw token CLI secrets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-agent-configure-"));
  try {
    const wikiRoot = path.join(temp, "wiki");
    await runSourceCli(["init", wikiRoot, "--template", "personal-wiki"]);
    const providers = JSON.parse((await runSourceCli(["agent", "providers", "list", "--json"])).stdout) as {
      providers: Array<{ id: string; install_profiles: string[]; transports: string[] }>;
    };
    assert.ok(providers.providers.some((provider) => provider.id === "opencode" && provider.install_profiles.includes("personal-curator")));
    assert.ok(providers.providers.some((provider) => provider.id === "generic-mcp" && provider.transports.includes("http")));

    const integrationTarget = path.join(temp, "opencode-project");
    const providerInstall = JSON.parse(
      (
        await runSourceCli([
          "agent",
          "install",
          "--provider",
          "opencode",
          "--profile",
          "researcher",
          "--out-dir",
          integrationTarget,
          "--json",
        ])
      ).stdout,
    ) as { provider: string; profile: string; target: string; files: string[] };
    assert.equal(providerInstall.provider, "opencode");
    assert.equal(providerInstall.profile, "researcher");
    assert.equal(providerInstall.target, integrationTarget);
    assert.deepEqual(providerInstall.files.sort(), [
      ".opencode/agents/openwiki-monitor.md",
      ".opencode/agents/openwiki-researcher.md",
      ".opencode/plugins/openwiki_guardrails.ts",
      ".opencode/skills/openwiki-dream-review",
      ".opencode/skills/openwiki-operator",
      ".opencode/skills/openwiki-research",
      "AGENTS.md",
      "opencode.json",
    ].sort());

    const tokenOut = path.join(temp, "agent.token");
    const configOut = path.join(temp, "mcp.json");
    const { stdout } = await runSourceCli([
      "--root",
      wikiRoot,
      "agent",
      "configure",
      "--client",
      "generic",
      "--tools",
      "proposal",
      "--create-token",
      "--token-out",
      tokenOut,
      "--config-out",
      configOut,
      "--json",
    ]);
    const token = (await readFile(tokenOut, "utf8")).trim();
    assert.match(token, /^owk_agent_/);
    assert.doesNotMatch(stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const config = JSON.parse(await readFile(configOut, "utf8")) as { mcpServers: { openwiki: { args: string[] } } };
    assert.deepEqual(config.mcpServers.openwiki.args, ["--root", wikiRoot, "mcp", "--stdio", "--tools", "proposal", "--token-file", tokenOut]);

    const installedConfigOut = path.join(temp, "installed-mcp.json");
    const install = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "mcp",
          "install",
          "generic",
          "--mode",
          "proposal",
          "--output",
          installedConfigOut,
          "--json",
        ])
      ).stdout,
    ) as { config_path: string; config: { mcpServers: { openwiki: { command: string; args: string[] } } } };
    assert.equal(install.config_path, installedConfigOut);
    assert.equal(install.config.mcpServers.openwiki.command, "openwiki");
    assert.deepEqual(install.config.mcpServers.openwiki.args, ["--root", wikiRoot, "mcp", "--stdio", "--tools", "proposal"]);

    const opencodeInstall = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "mcp",
          "install",
          "opencode",
          "--mode",
          "proposal",
          "--json",
        ])
      ).stdout,
    ) as { config: { mcp: { openwiki: { type: string; command: string[] } } } };
    assert.equal(opencodeInstall.config.mcp.openwiki.type, "local");
    assert.deepEqual(opencodeInstall.config.mcp.openwiki.command, ["openwiki", "--root", wikiRoot, "mcp", "--stdio", "--tools", "proposal"]);

    await assert.rejects(
      runSourceCli(["--root", wikiRoot, "mcp", "install", "generic", "--mode", "write", "--json"]),
      /--confirm-write-tools/,
    );

    await assert.rejects(
      runSourceCli(["--root", wikiRoot, "mcp", "--stdio", "--token", "owk_agent_raw"]),
      /--token is disabled/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("user-facing command aliases cover pages, spaces, deploy profiles, and upgrade guidance", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-surface-"));
  try {
    const wikiRoot = path.join(temp, "wiki");
    await runSourceCli(["setup", "personal", wikiRoot, "--agent", "none"]);

    const pages = JSON.parse((await runSourceCli(["--root", wikiRoot, "pages", "list", "--json"])).stdout) as {
      pages: Array<{ id: string; title: string; path: string }>;
      total: number;
    };
    assert.ok(pages.total > 0);
    const firstPage = pages.pages[0];
    assert.ok(firstPage);
    assert.match(firstPage.id, /^page:/);

    const page = JSON.parse((await runSourceCli(["--root", wikiRoot, "pages", "read", firstPage.id, "--json"])).stdout) as {
      id: string;
      title: string;
    };
    assert.equal(page.id, firstPage.id);
    assert.equal(page.title, firstPage.title);

    const proposalBody = path.join(temp, "proposal-body.md");
    await writeFile(
      proposalBody,
      [
        "---",
        `title: ${firstPage.title}`,
        'summary: "CLI JSON output with quote \\" tab \\t and backslash \\\\"',
        "---",
        "",
        `# ${firstPage.title}`,
        "",
        'CLI JSON output must stay parseable with quote ", tab \t, and backslash \\ content.',
      ].join("\n"),
      "utf8",
    );
    const proposedRaw = await runSourceCli(["--root", wikiRoot, "propose-edit", firstPage.id, "--body-file", proposalBody, "--json"]);
    const proposed = JSON.parse(proposedRaw.stdout) as { proposal: { id: string; target_ids: string[] }; validation: { status: string } };
    assert.match(proposed.proposal.id, /^proposal:/);
    assert.deepEqual(proposed.proposal.target_ids, [firstPage.id]);
    assert.equal(proposed.validation.status, "passed");

    const search = JSON.parse((await runSourceCli(["--root", wikiRoot, "pages", "search", "personal", "--json"])).stdout) as {
      results: Array<{ id: string; type: string }>;
    };
    assert.ok(search.results.length > 0);
    assert.ok(search.results.every((result) => result.type === "page"));

    const spaces = JSON.parse((await runSourceCli(["--root", wikiRoot, "spaces", "list", "--json"])).stdout) as {
      spaces: Array<{ id: string; path_coverage: string[]; viewers: string[] }>;
      total: number;
    };
    assert.ok(spaces.total > 0);
    assert.ok(spaces.spaces.some((space) => space.id.startsWith("section:")));
    assert.ok(spaces.spaces.every((space) => Array.isArray(space.path_coverage) && Array.isArray(space.viewers)));

    const profileList = JSON.parse((await runSourceCli(["deploy", "profile", "list", "--json"])).stdout) as {
      profiles: Array<{ name: string; trust_boundary: string }>;
    };
    assert.ok(profileList.profiles.some((profile) => profile.name === "local-personal"));
    assert.ok(profileList.profiles.some((profile) => profile.name === "cloud-run-readmostly"));

    const upgrade = JSON.parse((await runSourceCli(["upgrade", "--json"])).stdout) as {
      latest_command: string;
      upgrade_command: string;
    };
    assert.equal(upgrade.latest_command, "npm view @openwiki/cli version");
    assert.equal(upgrade.upgrade_command, "npm install -g @openwiki/cli@latest");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("agent configure generates hosted Streamable HTTP MCP configs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-agent-http-configure-"));
  try {
    const wikiRoot = path.join(temp, "wiki");
    await runSourceCli(["init", wikiRoot, "--template", "team-wiki"]);
    const configOut = path.join(temp, "remote-mcp.json");
    const { stdout } = await runSourceCli([
      "--root",
      wikiRoot,
      "agent",
      "configure",
      "--client",
      "generic",
      "--transport",
      "http",
      "--server-url",
      "https://wiki.example.com",
      "--tools",
      "proposal",
      "--token-env",
      "OPENWIKI_PROPOSAL_TOKEN",
      "--config-out",
      configOut,
      "--json",
    ]);
    const result = JSON.parse(stdout) as {
      transport: string;
      server_url: string;
      config: {
        mcpServers: {
          openwiki: {
            type: string;
            url: string;
            headers: Record<string, string>;
          };
        };
      };
      notes: string[];
    };
    assert.equal(result.transport, "http");
    assert.equal(result.server_url, "https://wiki.example.com/mcp?tools=proposal");
    assert.equal(result.config.mcpServers.openwiki.type, "http");
    assert.equal(result.config.mcpServers.openwiki.url, result.server_url);
    assert.equal(result.config.mcpServers.openwiki.headers["MCP-Protocol-Version"], "2025-11-25");
    assert.equal(result.config.mcpServers.openwiki.headers.Authorization, "Bearer ${OPENWIKI_PROPOSAL_TOKEN}");
    assert.ok(result.notes.some((note) => /environment secret/.test(note)));

    const opencodeRemote = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "agent",
          "configure",
          "--client",
          "opencode",
          "--transport",
          "http",
          "--server-url",
          "https://wiki.example.com",
          "--tools",
          "proposal",
          "--token-env",
          "OPENWIKI_PROPOSAL_TOKEN",
          "--json",
        ])
      ).stdout,
    ) as {
      config: {
        mcp: {
          openwiki: {
            type: string;
            enabled: boolean;
            url: string;
            headers: Record<string, string>;
          };
        };
      };
    };
    assert.equal(opencodeRemote.config.mcp.openwiki.type, "remote");
    assert.equal(opencodeRemote.config.mcp.openwiki.enabled, true);
    assert.equal(opencodeRemote.config.mcp.openwiki.url, "https://wiki.example.com/mcp?tools=proposal");
    assert.equal(opencodeRemote.config.mcp.openwiki.headers["MCP-Protocol-Version"], "2025-11-25");
    assert.equal(opencodeRemote.config.mcp.openwiki.headers.Authorization, "Bearer ${OPENWIKI_PROPOSAL_TOKEN}");

    const writtenConfig = JSON.parse(await readFile(configOut, "utf8")) as typeof result.config;
    assert.deepEqual(writtenConfig, result.config);

    await assert.rejects(
      runSourceCli(["--root", wikiRoot, "agent", "configure", "--client", "generic", "--transport", "http"]),
      /--server-url is required/,
    );

    const trailingSlash = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "agent",
          "configure",
          "--client",
          "generic",
          "--transport",
          "http",
          "--server-url",
          "https://wiki.example.com/mcp/",
          "--tools",
          "read",
          "--json",
        ])
      ).stdout,
    ) as { server_url: string };
    assert.equal(trailingSlash.server_url, "https://wiki.example.com/mcp?tools=read");

    const hostedTokenOut = path.join(temp, "hosted-proposal.token");
    const createdHostedToken = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "agent",
          "configure",
          "--client",
          "generic",
          "--transport",
          "http",
          "--server-url",
          "https://wiki.example.com",
          "--tools",
          "proposal",
          "--create-token",
          "--token-out",
          hostedTokenOut,
          "--json",
        ])
      ).stdout,
    ) as { token_id: string; token_file: string };
    assert.match(createdHostedToken.token_id, /^token:/);
    assert.equal(createdHostedToken.token_file, hostedTokenOut);
    const serviceAccounts = JSON.parse((await runSourceCli(["--root", wikiRoot, "auth", "token", "list", "--json"])).stdout) as {
      service_accounts: Array<{ id: string; tokens: unknown[] }>;
    };
    assert.ok(serviceAccounts.service_accounts.some((account) => account.id === "service:proposal-agent" && account.tokens.length > 0));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("doctor and deploy preflight expose JSON diagnostics", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-diagnostics-"));
  try {
    const wikiRoot = path.join(temp, "wiki");
    await runSourceCli(["setup", "personal", wikiRoot, "--agent", "none"]);
    const doctor = JSON.parse((await runSourceCli(["--root", wikiRoot, "doctor", "--json"])).stdout) as { command: string; checks: Array<{ name: string }> };
    assert.equal(doctor.command, "doctor");
    assert.ok(doctor.checks.some((check) => check.name === "node"));
    assert.ok(doctor.checks.some((check) => check.name === "node:sqlite"));
    assert.ok(doctor.checks.some((check) => check.name === "readyz-prerequisites"));
    assert.ok(doctor.checks.some((check) => check.name === "sync-config"));
    assert.ok(doctor.checks.some((check) => check.name === "backup-config"));
    assert.ok(doctor.checks.some((check) => check.name === "sync-automation"));
    assert.ok(doctor.checks.some((check) => check.name === "backup-automation"));

    const configPath = path.join(wikiRoot, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown> & {
      runtime?: Record<string, unknown>;
    };
    config.runtime = {
      ...(config.runtime ?? {}),
      sync: { remote: "origin", branch: "main", mode: "manual", conflict_policy: "stop" },
      backups: {
        enabled: true,
        schedule: "manual",
        retention: { keep_last: 10, keep_days: 90 },
        destinations: [{ id: "local", kind: "local", path: path.join(temp, "backups") }],
      },
      storage: { backend: "s3", bucket: "openwiki-hosted-test", region: "us-east-1", prefix: "test/wiki" },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const configuredDoctor = JSON.parse((await runSourceCli(["--root", wikiRoot, "doctor", "--json"])).stdout) as {
      command: string;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(configuredDoctor.command, "doctor");
    assert.ok(configuredDoctor.checks.some((check) => check.name === "workspace-config" && check.status === "pass"));
    assert.ok(configuredDoctor.checks.some((check) => check.name === "sync-config" && check.status === "pass"));
    assert.ok(configuredDoctor.checks.some((check) => check.name === "backup-config" && check.status === "pass"));
    assert.ok(configuredDoctor.checks.some((check) => check.name === "backup-state" && check.status === "warn"));

    const createdAndVerified = JSON.parse(
      (await runSourceCli(["--root", wikiRoot, "backup", "create", "--destination", "local", "--verify", "--json"])).stdout,
    ) as { backup_id: string; verification: { backup_id: string } };
    assert.equal(createdAndVerified.verification.backup_id, createdAndVerified.backup_id);
    const verifiedDoctor = JSON.parse((await runSourceCli(["--root", wikiRoot, "doctor", "--json"])).stdout) as {
      command: string;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(verifiedDoctor.command, "doctor");
    assert.ok(verifiedDoctor.checks.some((check) => check.name === "backup-state" && check.status === "pass"));
    assert.ok(verifiedDoctor.checks.some((check) => check.name === "postgres-backup"));
    assert.ok(verifiedDoctor.checks.some((check) => check.name === "object-storage-backup"));

    await runSourceCli([
      "--root",
      wikiRoot,
      "auth",
      "token",
      "create",
      "--id",
      "service:proposal-agent",
      "--profile",
      "proposal-agent",
      "--actor",
      "actor:agent:proposal-agent",
      "--expires-in-days",
      "30",
      "--json",
    ]);

    const personalDoctor = JSON.parse((await runSourceCli(["--root", wikiRoot, "doctor", "--profile", "personal", "--json"])).stdout) as {
      profile: string;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(personalDoctor.profile, "personal");
    assert.ok(personalDoctor.checks.some((check) => check.name === "agent-mcp-config"));

    const hostedDoctor = JSON.parse((await runSourceCli(["--root", wikiRoot, "doctor", "--profile", "hosted", "--json"])).stdout) as {
      profile: string;
      checks: Array<{ name: string; status: string }>;
    };
    assert.equal(hostedDoctor.profile, "hosted");
    assert.ok(hostedDoctor.checks.some((check) => check.name === "public-origin"));
    assert.ok(hostedDoctor.checks.some((check) => check.name === "backup-provider:local"));

    const kubernetesDoctorResult = await runSourceCliAllowFailure(
      [
        "--root",
        wikiRoot,
        "doctor",
        "--profile",
        "kubernetes",
        "--public-origin",
        "https://wiki.example.com",
        "--image",
        "ghcr.io/joe-broadhead/open-wiki@sha256:abc123",
        "--json",
      ],
      {
        OPENWIKI_RATE_LIMIT_ENABLED: "1",
        OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
        OPENWIKI_TRUST_AUTH_HEADERS_SECRET: "trusted-header-secret",
      },
    );
    const kubernetesDoctor = JSON.parse(kubernetesDoctorResult.stdout) as { profile: string; status: string; checks: Array<{ name: string; status: string }> };
    assert.equal(kubernetesDoctorResult.code, kubernetesDoctor.status === "fail" ? 1 : 0);
    assert.equal(kubernetesDoctor.profile, "kubernetes");
    assert.ok(kubernetesDoctor.checks.some((check) => check.name === "write-coordinator" && check.status === "pass"));
    assert.ok(kubernetesDoctor.checks.some((check) => check.name === "postgres"));

    const preflight = JSON.parse((await runSourceCli(["--root", wikiRoot, "deploy", "preflight", "--deploy-profile", "local-personal", "--json"])).stdout) as {
      command: string;
      deployment_profile: { name: string; trust_boundary: string };
      checks: Array<{ name: string }>;
    };
    assert.equal(preflight.command, "deploy-preflight");
    assert.equal(preflight.deployment_profile.name, "local-personal");
    assert.match(preflight.deployment_profile.trust_boundary, /local machine/);
    assert.ok(preflight.checks.some((check) => check.name === "public-origin"));
    assert.ok(preflight.checks.some((check) => check.name === "write-coordinator"));
    assert.ok(preflight.checks.some((check) => check.name === "backup-state"));
    assert.ok(preflight.checks.some((check) => check.name === "postgres-backup"));
    assert.ok(preflight.checks.some((check) => check.name === "object-storage-backup"));

    const hostedPreflight = JSON.parse(
      (
        await runSourceCliAllowFailure(
          [
            "--root", wikiRoot, "deploy", "preflight", "--deploy-profile", "hosted-enterprise",
            "--public-origin", "https://wiki.example.com",
            "--image", "ghcr.io/joe-broadhead/open-wiki@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--json",
          ],
          {
            OPENWIKI_TRUST_AUTH_HEADERS: "1",
            OPENWIKI_TRUST_AUTH_HEADERS_SECRET: "hosted-trusted-header-secret",
            OPENWIKI_TRUST_PROXY_ORIGIN: "1",
            OPENWIKI_TRUST_PROXY_ORIGIN_SECRET: "hosted-proxy-origin-secret",
            OPENWIKI_RATE_LIMIT_ENABLED: "1",
            OPENWIKI_DATABASE_URL: "postgres://openwiki:openwiki@127.0.0.1:5432/openwiki",
            OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
            OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
            OPENWIKI_OBJECT_STORAGE_BACKUP_CONFIGURED: "1",
            OPENWIKI_POSTGRES_BACKUP_CONFIGURED: "1",
          },
        )
      ).stdout,
    ) as { status: string; deployment_profile: { name: string }; checks: Array<{ name: string; status: string }> };
    assert.equal(hostedPreflight.status, "fail");
    assert.equal(hostedPreflight.deployment_profile.name, "hosted-enterprise");
    for (const [name, status] of [
      ["public-origin", "pass"], ["image-digest", "pass"], ["trusted-headers", "pass"], ["rate-limits", "pass"],
      ["operational-state", "pass"], ["object-storage-backup", "pass"], ["hosted-mcp-tokens", "pass"], ["backup-state", "pass"],
      ["git-remote", "fail"],
    ] as const) {
      assert.ok(hostedPreflight.checks.some((check) => check.name === name && check.status === status));
    }

    const hostedWeakPreflight = JSON.parse(
      (
        await runSourceCli(
          [
            "--root",
            wikiRoot,
            "deploy",
            "preflight",
            "--deploy-profile",
            "docker-private",
            "--public-origin",
            "https://wiki.example.com",
            "--json",
          ],
          {
            OPENWIKI_TRUST_AUTH_HEADERS: "1",
            OPENWIKI_TRUST_AUTH_HEADERS_SECRET: "hosted-trusted-header-secret",
            OPENWIKI_TRUST_PROXY_ORIGIN: "1",
            OPENWIKI_TRUST_PROXY_ORIGIN_SECRET: "hosted-proxy-origin-secret",
            OPENWIKI_RATE_LIMIT_ENABLED: "0",
            OPENWIKI_OPERATIONAL_STATE_BACKEND: "memory",
            OPENWIKI_WRITE_COORDINATOR_BACKEND: "memory",
            OPENWIKI_POSTGRES_BACKUP_CONFIGURED: "1",
          },
        )
      ).stdout,
    ) as { status: string; checks: Array<{ name: string; status: string }> };
    assert.equal(hostedWeakPreflight.status, "warn");
    assert.ok(hostedWeakPreflight.checks.some((check) => check.name === "rate-limits" && check.status === "warn"));
    assert.ok(hostedWeakPreflight.checks.some((check) => check.name === "operational-state" && check.status === "warn"));

    const staticOut = path.join(wikiRoot, "public");
    await mkdir(staticOut);
    await mkdir(path.join(staticOut, "agents"));
    await Promise.all([
      writeFile(path.join(staticOut, "index.html"), "<!doctype html>\n"),
      writeFile(path.join(staticOut, "search-index.json"), "{}\n"),
      writeFile(path.join(staticOut, "graph.json"), "{}\n"),
      writeFile(path.join(staticOut, "graph-report.json"), "{}\n"),
      writeFile(path.join(staticOut, "agents", "index.md"), "# Agent Guide\n"),
      writeFile(path.join(staticOut, "static-export-report.json"), "{}\n"),
    ]);
    const staticPreflight = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "deploy",
          "preflight",
          "--deploy-profile",
          "public-static",
          "--public-origin",
          "https://docs.example.com",
          "--out-dir",
          "public",
          "--json",
        ])
      ).stdout,
    ) as { deployment_profile: { name: string }; checks: Array<{ name: string; status: string }> };
    assert.equal(staticPreflight.deployment_profile.name, "public-static");
    assert.ok(staticPreflight.checks.some((check) => check.name === "static-artifacts" && check.status === "pass"));

    const cloudRunPreflight = JSON.parse(
      (
        await runSourceCli([
          "--root",
          wikiRoot,
          "deploy",
          "preflight",
          "--deploy-profile",
          "cloud-run",
          "--public-origin",
          "https://wiki.example.com",
          "--image",
          "ghcr.io/joe-broadhead/open-wiki@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--json",
        ])
      ).stdout,
    ) as { status: string; deployment_profile: { name: string }; checks: Array<{ name: string; status: string; message: string }> };
    assert.equal(cloudRunPreflight.status, "warn");
    assert.equal(cloudRunPreflight.deployment_profile.name, "cloud-run-readmostly");
    assert.ok(cloudRunPreflight.checks.some((check) => check.name === "profile-preview" && check.status === "warn"));

    let unsafeTrustedHeadersStdout = "";
    await assert.rejects(
      async () => {
        try {
          await runSourceCli(
            ["--root", wikiRoot, "deploy", "preflight", "--deploy-profile", "kubernetes", "--public-origin", "https://wiki.example.com", "--json"],
            {
              OPENWIKI_TRUST_AUTH_HEADERS: "1",
              OPENWIKI_TRUST_AUTH_HEADERS_SECRET: "short",
              OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
              OPENWIKI_IMAGE: "ghcr.io/openwiki/openwiki@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          );
        } catch (error) {
          unsafeTrustedHeadersStdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
          throw error;
        }
      },
      /Command failed/,
    );
    const unsafeTrustedHeaders = JSON.parse(unsafeTrustedHeadersStdout) as { status: string; checks: Array<{ name: string; status: string; message: string }> };
    assert.equal(unsafeTrustedHeaders.status, "fail");
    assert.ok(
      unsafeTrustedHeaders.checks.some(
        (check) => check.name === "trusted-headers" && check.status === "fail" && /at least 16 characters/.test(check.message),
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("setup personal rejects unsafe paths and unconfirmed write-mode agents", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-setup-negative-"));
  try {
    await assert.rejects(
      runSourceCli(["setup", "personal", path.join(temp, "Google Drive", "Wiki"), "--agent", "none", "--json"]),
      /Refusing to create a live OpenWiki workspace inside Google Drive/,
    );
    await assert.rejects(
      runSourceCli(["setup", "personal", path.join(temp, "wiki"), "--agent", "generic", "--tools", "write", "--json"]),
      /--confirm-write-tools/,
    );
    await assert.rejects(
      runSourceCli([
        "setup",
        "personal",
        path.join(temp, "invalid-remote-wiki"),
        "--agent",
        "none",
        "--git-remote",
        "file:///etc/passwd",
        "--json",
      ]),
      /scheme "file" is not allowed/,
    );

    const noAgentWiki = path.join(temp, "no-agent-wiki");
    const noAgent = JSON.parse(
      (
        await runSourceCli([
          "setup",
          "personal",
          noAgentWiki,
          "--agent",
          "none",
          "--json",
        ])
      ).stdout,
    ) as { opencode_integration?: unknown; actions: Array<{ kind: string; status: string }> };
    assert.equal(noAgent.opencode_integration, undefined);
    assert.ok(noAgent.actions.some((action) => action.kind === "integration" && action.status === "skipped"));
    await assert.rejects(stat(path.join(noAgentWiki, ".opencode")), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function runSourceCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(SOURCE_CLI[0], [...SOURCE_CLI[1], ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 16,
  });
}

async function runSourceCliAllowFailure(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await runSourceCli(args, env);
    return { ...result, code: 0 };
  } catch (error: unknown) {
    if (error && typeof error === "object") {
      const record = error as Record<string, unknown>;
      if (typeof record.stdout === "string" && typeof record.stderr === "string" && typeof record.code === "number") {
        return { stdout: record.stdout, stderr: record.stderr, code: record.code };
      }
    }
    throw error;
  }
}
