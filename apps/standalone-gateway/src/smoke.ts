import { FakeChannelProvider } from "@open-cowork/gateway-testing";

import { FakeStandaloneOpenCodeAdapter } from "./opencode.js";
import { InMemoryStandaloneGatewayRepository } from "./repository.js";
import { createStandaloneGatewayRuntime } from "./runtime.js";

export async function runStandaloneGatewaySmoke(): Promise<{ ok: true; sessionCount: number; promptCount: number }> {
  const repository = new InMemoryStandaloneGatewayRepository();
  await repository.upsertChannelIdentity({
    provider: "cli-standalone",
    externalUserId: "smoke-user",
    role: "member",
  });
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });
  await runtime.handleMessage(provider, {
    id: "cli-standalone",
    kind: "cli",
    channelBindingId: "cli",
    enabled: true,
    credentials: {},
    settings: {},
  }, {
    id: "message-1",
    provider: "cli-standalone",
    providerKind: "cli",
    providerInstanceId: "cli-standalone",
    providerEventId: "event-1",
    providerMessageId: "message-1",
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "smoke", threadId: "smoke" },
    sender: { providerUserId: "smoke-user" },
    text: "hello from standalone smoke",
    rawText: "hello from standalone smoke",
    isCommand: false,
    attachments: [],
    receivedAt: new Date(),
    raw: {},
  });
  return {
    ok: true,
    sessionCount: (await repository.listSessions()).length,
    promptCount: opencode.prompts.length,
  };
}
