import { MCP_PROTOCOL_VERSION, type McpToolMode } from "@openwiki/mcp-server";
import type { AgentClient, AgentTransport } from "./arg-values.ts";

type BuiltInAgentProviderId = "opencode" | "generic-mcp";
type AgentProviderId = BuiltInAgentProviderId | (string & {});
export type AgentProviderInstallProfile =
  | "personal-curator"
  | "researcher"
  | "reviewer"
  | "maintainer"
  | "wiki-curator"
  | "developer"
  | "global";

type AgentProviderConfigShape = "opencode-mcp" | "generic-mcp-servers";
type AgentProviderInstallKind = "opencode-pack" | "config-only";
type AgentProviderInstallScope = "project" | "global" | "none";

export interface AgentProvider {
  id: AgentProviderId;
  aliases: readonly string[];
  client: Exclude<AgentClient, "none">;
  displayName: string;
  description: string;
  transports: readonly AgentTransport[];
  configShape: AgentProviderConfigShape;
  install: {
    kind: AgentProviderInstallKind;
    defaultProfile?: AgentProviderInstallProfile;
    profiles: readonly AgentProviderInstallProfile[];
    defaultScope: AgentProviderInstallScope;
    supportsGlobal: boolean;
  };
  localRunnerCommand?: string;
  toolModes: readonly McpToolMode[];
  features: {
    skills: boolean;
    agents: boolean;
    plugins: boolean;
    commands: boolean;
    modelOverride: boolean;
  };
  model: {
    default: "client-default" | "user-configured";
    override: string;
    evalPinning: string;
  };
  writeModeSecurity: readonly string[];
}

export type AgentProviderConfigInput =
  | { transport: "stdio"; mcpArgs: string[] }
  | { transport: "http"; url: string; tokenEnv?: string | undefined };

interface AgentProviderSummary {
  id: AgentProviderId;
  aliases: string[];
  client: Exclude<AgentClient, "none">;
  display_name: string;
  description: string;
  transports: AgentTransport[];
  config_shape: AgentProviderConfigShape;
  install_kind: AgentProviderInstallKind;
  install_profiles: AgentProviderInstallProfile[];
  default_install_scope: AgentProviderInstallScope;
  supports_global_install: boolean;
  local_runner_command?: string;
  tool_modes: McpToolMode[];
  features: AgentProvider["features"];
  model: AgentProvider["model"];
  write_mode_security: string[];
}

const AGENT_PROVIDERS: readonly AgentProvider[] = [
  {
    id: "opencode",
    aliases: [],
    client: "opencode",
    displayName: "OpenCode",
    description: "First-class OpenWiki agent runtime with project-local skills, agents, tools, and plugins.",
    transports: ["stdio", "http"],
    configShape: "opencode-mcp",
    install: {
      kind: "opencode-pack",
      defaultProfile: "personal-curator",
      profiles: ["personal-curator", "researcher", "reviewer", "maintainer", "wiki-curator", "developer", "global"],
      defaultScope: "project",
      supportsGlobal: true,
    },
    localRunnerCommand: "opencode run --agent <agent-name> <task>",
    toolModes: ["read", "proposal", "write"],
    features: {
      skills: true,
      agents: true,
      plugins: true,
      commands: true,
      modelOverride: true,
    },
    model: {
      default: "client-default",
      override: "Set the model in OpenCode user/project config or pass --model to opencode run.",
      evalPinning: "OpenWiki eval scripts pin their model independently with OPENWIKI_OPENCODE_MODEL.",
    },
    writeModeSecurity: [
      "Write-mode configs require --confirm-write-tools.",
      "Hosted HTTP configs use environment-secret bearer references rather than raw tokens.",
      "Project-local installs keep OpenCode rules and guardrails with the wiki project by default.",
    ],
  },
  {
    id: "generic-mcp",
    aliases: ["generic"],
    client: "generic",
    displayName: "Generic MCP",
    description: "Provider-neutral MCP config for clients that understand the mcpServers convention.",
    transports: ["stdio", "http"],
    configShape: "generic-mcp-servers",
    install: {
      kind: "config-only",
      profiles: [],
      defaultScope: "none",
      supportsGlobal: false,
    },
    toolModes: ["read", "proposal", "write"],
    features: {
      skills: false,
      agents: false,
      plugins: false,
      commands: false,
      modelOverride: true,
    },
    model: {
      default: "client-default",
      override: "Configure the model in the chosen MCP client.",
      evalPinning: "Generic MCP clients are not pinned by OpenWiki installs.",
    },
    writeModeSecurity: [
      "Write-mode configs require --confirm-write-tools.",
      "Hosted HTTP configs use environment-secret bearer references rather than raw tokens.",
    ],
  },
];

export function listAgentProviderSummaries(): AgentProviderSummary[] {
  return AGENT_PROVIDERS.map(agentProviderSummary);
}

function agentProviderSummary(provider: AgentProvider): AgentProviderSummary {
  return {
    id: provider.id,
    aliases: [...provider.aliases],
    client: provider.client,
    display_name: provider.displayName,
    description: provider.description,
    transports: [...provider.transports],
    config_shape: provider.configShape,
    install_kind: provider.install.kind,
    install_profiles: [...provider.install.profiles],
    default_install_scope: provider.install.defaultScope,
    supports_global_install: provider.install.supportsGlobal,
    ...(provider.localRunnerCommand === undefined ? {} : { local_runner_command: provider.localRunnerCommand }),
    tool_modes: [...provider.toolModes],
    features: provider.features,
    model: provider.model,
    write_mode_security: [...provider.writeModeSecurity],
  };
}

export function resolveAgentProvider(value: string | undefined, fallback: BuiltInAgentProviderId = "generic-mcp"): AgentProvider {
  return resolveAgentProviderFromRegistry(AGENT_PROVIDERS, value ?? fallback);
}

export function resolveAgentProviderFromRegistry(providers: readonly AgentProvider[], value: string): AgentProvider {
  const normalized = value.trim().toLowerCase();
  const provider = providers.find((candidate) => candidate.id === normalized || candidate.aliases.includes(normalized));
  if (provider === undefined) {
    const names = providers.flatMap((candidate) => [candidate.id, ...candidate.aliases]).join(", ");
    throw new Error(`Invalid agent provider '${value}'. Expected ${names}.`);
  }
  return provider;
}

export function agentProviderForClient(client: Exclude<AgentClient, "none">): AgentProvider {
  return resolveAgentProvider(client === "generic" ? "generic-mcp" : client);
}

export function normalizeAgentInstallProfile(
  provider: AgentProvider,
  profile: string | undefined,
  fallback?: AgentProviderInstallProfile,
): AgentProviderInstallProfile {
  const selected = profile ?? fallback ?? provider.install.defaultProfile;
  if (selected === undefined) {
    throw new Error(`Provider ${provider.id} does not install integration packs.`);
  }
  if (isAgentProviderInstallProfile(selected) && provider.install.profiles.includes(selected)) {
    return selected;
  }
  throw new Error(
    `Invalid ${provider.id} install profile '${selected}'. Expected ${provider.install.profiles.join("|")}.`,
  );
}

function isAgentProviderInstallProfile(value: string): value is AgentProviderInstallProfile {
  return (
    value === "personal-curator" ||
    value === "researcher" ||
    value === "reviewer" ||
    value === "maintainer" ||
    value === "wiki-curator" ||
    value === "developer" ||
    value === "global"
  );
}

export function generateAgentProviderConfig(provider: AgentProvider, serverName: string, input: AgentProviderConfigInput): unknown {
  if (input.transport === "http") {
    const headers = agentHttpHeaders(input.tokenEnv);
    if (provider.configShape === "opencode-mcp") {
      return {
        mcp: {
          [serverName]: {
            type: "remote",
            enabled: true,
            url: input.url,
            headers,
          },
        },
      };
    }
    return {
      mcpServers: {
        [serverName]: {
          type: "http",
          url: input.url,
          headers,
        },
      },
    };
  }

  if (provider.configShape === "opencode-mcp") {
    return {
      mcp: {
        [serverName]: {
          type: "local",
          enabled: true,
          command: ["openwiki", ...input.mcpArgs],
        },
      },
    };
  }
  return {
    mcpServers: {
      [serverName]: {
        command: "openwiki",
        args: input.mcpArgs,
      },
    },
  };
}

export function agentHttpHeaders(tokenEnv: string | undefined): Record<string, string> {
  return {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(tokenEnv === undefined ? {} : { Authorization: `Bearer \${${tokenEnv}}` }),
  };
}

export function mcpHttpUrl(serverUrl: string | undefined, toolMode: McpToolMode): string {
  if (serverUrl === undefined || !serverUrl.trim()) {
    throw new Error("--server-url is required when --transport http is used");
  }
  const url = new URL(serverUrl);
  const trimmedPath = url.pathname.replace(/\/+$/g, "");
  if (trimmedPath === "") {
    url.pathname = "/mcp";
  } else if (trimmedPath.endsWith("/mcp")) {
    url.pathname = trimmedPath;
  } else {
    url.pathname = `${trimmedPath}/mcp`;
  }
  url.searchParams.set("tools", toolMode);
  return url.toString();
}
