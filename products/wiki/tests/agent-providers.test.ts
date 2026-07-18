import assert from "node:assert/strict";
import test from "node:test";
import {
  agentHttpHeaders,
  agentProviderForClient,
  generateAgentProviderConfig,
  listAgentProviderSummaries,
  mcpHttpUrl,
  resolveAgentProvider,
  resolveAgentProviderFromRegistry,
  type AgentProvider,
} from "../packages/cli/src/agent-providers.ts";

test("agent provider registry resolves OpenCode, generic MCP aliases, and future providers", () => {
  const providers = listAgentProviderSummaries();
  assert.ok(providers.some((provider) => provider.id === "opencode" && provider.install_kind === "opencode-pack"));
  assert.ok(providers.some((provider) => provider.id === "generic-mcp" && provider.aliases.includes("generic")));

  assert.equal(resolveAgentProvider("opencode").id, "opencode");
  assert.equal(resolveAgentProvider("generic").id, "generic-mcp");
  assert.equal(resolveAgentProvider("generic-mcp").client, "generic");
  assert.equal(agentProviderForClient("generic").id, "generic-mcp");

  const fakeProvider: AgentProvider = {
    id: "fake-provider",
    aliases: ["fake-provider"],
    client: "generic",
    displayName: "Fake Provider",
    description: "Test-only provider contract fixture.",
    transports: ["stdio"],
    configShape: "generic-mcp-servers",
    install: {
      kind: "config-only",
      profiles: [],
      defaultScope: "none",
      supportsGlobal: false,
    },
    toolModes: ["read"],
    features: {
      skills: false,
      agents: false,
      plugins: false,
      commands: false,
      modelOverride: true,
    },
    model: {
      default: "client-default",
      override: "Configured by the fake client.",
      evalPinning: "None.",
    },
    writeModeSecurity: ["No write tools in this fixture."],
  };
  assert.equal(resolveAgentProviderFromRegistry([fakeProvider], "fake-provider").displayName, "Fake Provider");
});

test("agent provider config generation covers OpenCode stdio and HTTP without raw tokens", () => {
  const opencode = resolveAgentProvider("opencode");
  const stdio = generateAgentProviderConfig(opencode, "openwiki", {
    transport: "stdio",
    mcpArgs: ["--root", "/tmp/wiki", "mcp", "--stdio", "--tools", "proposal", "--token-file", "/tmp/token"],
  }) as { mcp: { openwiki: { type: string; command: string[] } } };
  assert.equal(stdio.mcp.openwiki.type, "local");
  assert.deepEqual(stdio.mcp.openwiki.command, [
    "openwiki",
    "--root",
    "/tmp/wiki",
    "mcp",
    "--stdio",
    "--tools",
    "proposal",
    "--token-file",
    "/tmp/token",
  ]);

  const http = generateAgentProviderConfig(opencode, "openwiki", {
    transport: "http",
    url: "https://wiki.example.com/mcp?tools=proposal",
    tokenEnv: "OPENWIKI_AGENT_TOKEN",
  }) as { mcp: { openwiki: { type: string; url: string; headers: Record<string, string> } } };
  assert.equal(http.mcp.openwiki.type, "remote");
  assert.equal(http.mcp.openwiki.url, "https://wiki.example.com/mcp?tools=proposal");
  assert.equal(http.mcp.openwiki.headers.Authorization, "Bearer ${OPENWIKI_AGENT_TOKEN}");
  assert.doesNotMatch(JSON.stringify(http), /owk_agent_/);
});

test("generic MCP config generation and HTTP helpers are provider-neutral", () => {
  const generic = resolveAgentProvider("generic-mcp");
  const stdio = generateAgentProviderConfig(generic, "openwiki", {
    transport: "stdio",
    mcpArgs: ["--root", "/tmp/wiki", "mcp", "--stdio", "--tools", "read"],
  }) as { mcpServers: { openwiki: { command: string; args: string[] } } };
  assert.equal(stdio.mcpServers.openwiki.command, "openwiki");
  assert.deepEqual(stdio.mcpServers.openwiki.args, ["--root", "/tmp/wiki", "mcp", "--stdio", "--tools", "read"]);

  const httpUrl = mcpHttpUrl("https://wiki.example.com/base/", "write");
  assert.equal(httpUrl, "https://wiki.example.com/base/mcp?tools=write");
  assert.deepEqual(agentHttpHeaders("OPENWIKI_TOKEN"), {
    "MCP-Protocol-Version": "2025-11-25",
    Authorization: "Bearer ${OPENWIKI_TOKEN}",
  });
});
