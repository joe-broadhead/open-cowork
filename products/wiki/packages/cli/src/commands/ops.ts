import { readFile } from "node:fs/promises";
import { createMaintainerJob, runMaintainerJob } from "@openwiki/harness-opencode";
import { startHttpApi, validateTrustedHeaderRuntime } from "@openwiki/http-api";
import { runMcpStdioServer } from "@openwiki/mcp-server";
import type { CliOptions } from "../args.ts";
import { printJson, printMaybeJson } from "../output.ts";
import { registerHttpApiShutdown } from "../process-lifecycle.ts";
import { resolveRoot } from "../utils.ts";
import { configureAgentForRoot, printAgentSummary, writeAgentSetupMetadata } from "./agent.ts";
import { integrateOpenCode } from "./integrations.ts";

export async function maintainerCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, pageId] = args;
  if (!pageId || !options.task) {
    throw new Error(
      "Usage: openwiki [--root <path>] maintainer prepare|run <page-id> --task text [--agent-command cmd --agent-arg arg] [--json]",
    );
  }
  const root = await resolveRoot(options);
  if (subcommand === "prepare") {
    const result = await createMaintainerJob({
      root,
      targetPageId: pageId,
      task: options.task,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    printMaybeJson(result, options, `Prepared maintainer job ${result.run_id}`);
    return;
  }
  if (subcommand === "run") {
    const result = await runMaintainerJob({
      root,
      targetPageId: pageId,
      task: options.task,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.agentCommand === undefined
        ? {}
        : {
            agentCommand: {
              command: options.agentCommand,
              args: options.agentArgs,
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            },
          }),
    });
    printMaybeJson(result, options, `Completed maintainer job ${result.run_id}`);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] maintainer prepare|run <page-id> --task text");
}

export async function integrateCommand(args: string[], options: CliOptions): Promise<void> {
  const [target] = args;
  if (target !== "opencode") {
    throw new Error("Usage: openwiki integrate opencode [--profile wiki-curator|developer|global] [--out-dir <path>] [--wiki-root <path>] [--json]");
  }
  const result = await integrateOpenCode(options.outDir, {
    profile: options.profile,
    installScope: options.profile === "global" ? "global" : "project",
    wikiRoot: options.wikiRoot ?? options.root,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Installed OpenWiki OpenCode integration profile ${result.profile} into ${result.target}`);
  for (const file of result.files) {
    console.log(file);
  }
  if (result.notes.length > 0) {
    for (const note of result.notes) {
      console.log(`note: ${note}`);
    }
  }
}

export async function mcpCommand(args: string[], options: CliOptions): Promise<void> {
  const [transport, clientArg] = args;
  if (transport === "install") {
    if (clientArg !== "opencode" && clientArg !== "generic") {
      throw new Error("Usage: openwiki [--root <path>] mcp install opencode|generic --mode read|proposal|write [--output path] [--json]");
    }
    const root = await resolveRoot(options);
    const result = await configureAgentForRoot(root, clientArg, {
      toolMode: options.mcpToolMode ?? "proposal",
      transport: options.agentTransport ?? "stdio",
      serverUrl: options.serverUrl,
      configOut: options.configOut,
      tokenEnv: options.tokenEnv,
      tokenFile: options.tokenFile,
      tokenOut: options.tokenOut,
      createToken: options.createToken || options.tokenOut !== undefined,
      confirmWriteTools: options.confirmWriteTools,
      profile: options.authTokenProfile,
    });
    await writeAgentSetupMetadata(root, result);
    if (options.json) {
      printJson(result);
      return;
    }
    printAgentSummary(result);
    return;
  }
  if (transport !== "--stdio" && transport !== "stdio") {
    throw new Error("Usage: openwiki [--root <path>] mcp --stdio [--tools read|proposal|write] [--token-env ENV|--token-file path|--role role|--scope scope]\n       openwiki [--root <path>] mcp install opencode|generic --mode read|proposal|write [--output path] [--json]");
  }
  const token = await resolveCliToken(options);
  await runMcpStdioServer({
    root: await resolveRoot(options),
    ...(options.mcpToolMode === undefined ? {} : { toolMode: options.mcpToolMode }),
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.mcpRole === undefined ? {} : { role: options.mcpRole }),
    ...(options.mcpScopes.length === 0 ? {} : { scopes: options.mcpScopes }),
    ...(options.principals.length === 0 ? {} : { principals: options.principals }),
    ...(token === undefined ? {} : { token }),
  });
}

export async function serveCommand(args: string[], options: CliOptions): Promise<void> {
  if (args.length > 1 || (args.length === 1 && options.root !== undefined)) {
    throw new Error("Usage: openwiki [--root <path>] serve [--host 127.0.0.1] [--port 3030] or openwiki serve <wiki-root>");
  }
  const positionalRoot = options.root === undefined ? args[0] : undefined;
  const resolvedOptions: CliOptions = positionalRoot === undefined ? options : { ...options, root: positionalRoot };
  const serverOptions = { root: await resolveRoot(resolvedOptions) };
  const token = await resolveCliToken(options);
  const defaultPolicy = {
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.mcpRole === undefined ? {} : { role: options.mcpRole }),
    ...(options.mcpScopes.length === 0 ? {} : { scopes: options.mcpScopes }),
    ...(options.principals.length === 0 ? {} : { principals: options.principals }),
    ...(token === undefined ? {} : { token }),
    ...(options.trustHeaders ? { trustHeaders: true } : {}),
    ...(options.trustedHeaderSecret === undefined ? {} : { trustedHeaderSecret: options.trustedHeaderSecret }),
  };
  validateTrustedHeaderRuntime(defaultPolicy);
  const started = await startHttpApi({
    ...serverOptions,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(Object.keys(defaultPolicy).length === 0 ? {} : { defaultPolicy }),
  });
  registerHttpApiShutdown(started);
  console.log(`OpenWiki API listening at ${started.url}`);
}

async function resolveCliToken(options: CliOptions): Promise<string | undefined> {
  const sources = [
    options.token === undefined ? undefined : "--token",
    options.tokenEnv === undefined ? undefined : "--token-env",
    options.tokenFile === undefined ? undefined : "--token-file",
  ].filter((source): source is string => source !== undefined);
  if (sources.length > 1) {
    throw new Error("Use only one token source: --token-env, --token-file, or OPENWIKI_TOKEN");
  }
  if (options.token !== undefined) {
    throw new Error("--token is disabled because command-line secrets are visible to other local processes; use --token-env, --token-file, or OPENWIKI_TOKEN");
  }
  if (options.tokenEnv !== undefined) {
    const envName = options.tokenEnv.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error("--token-env must name an environment variable");
    }
    const value = process.env[envName]?.trim();
    if (!value) {
      throw new Error(`Token environment variable ${envName} is not set`);
    }
    return value;
  }
  if (options.tokenFile !== undefined) {
    const value = (await readFile(options.tokenFile, "utf8")).trim();
    if (!value) {
      throw new Error(`Token file is empty: ${options.tokenFile}`);
    }
    return value;
  }
  const envToken = process.env.OPENWIKI_TOKEN?.trim();
  return envToken || undefined;
}
