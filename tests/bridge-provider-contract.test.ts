import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelCapabilities } from "../packages/gateway-channel/dist/index.js";
import {
  DiscordProvider,
  discordCapabilities
} from "../packages/gateway-provider-discord/dist/index.js";
import {
  SignalProvider,
  signalCapabilities
} from "../packages/gateway-provider-signal/dist/index.js";
import {
  WhatsAppProvider,
  whatsappCapabilities
} from "../packages/gateway-provider-whatsapp/dist/index.js";
import type { BridgeProviderConstructor, BridgeProviderDefinition } from "../packages/gateway-provider-webhook/dist/index.js";

type BridgeProviderContract = {
  Provider: BridgeProviderConstructor;
  capabilities: ChannelCapabilities;
  expectedDefinition: Pick<
    BridgeProviderDefinition,
    "providerKind" | "defaultProviderId" | "displayName"
  >;
  expectedCapabilities: readonly unknown[];
  expectedInheritedCapabilities?: Partial<ChannelCapabilities>;
  warningPattern: RegExp;
};

const capabilityKeys = [
  "threads", "messageEditing", "inlineButtons", "fileUploads", "fileDownloads",
  "typingIndicator", "maxTextLength", "preferredParseMode", "parseModes",
  "maxButtonsPerMessage", "maxButtonRowsPerMessage", "maxButtonTokenBytes",
  "maxFileBytes", "inboundFileModes", "outboundFileModes", "editSemantics",
  "interactionAcknowledgement", "rateLimitStrategy", "supportsEphemeralResponses"
] as const satisfies readonly (keyof ChannelCapabilities)[];

const contracts: BridgeProviderContract[] = [
  {
    Provider: DiscordProvider,
    capabilities: discordCapabilities,
    expectedDefinition: {
      providerKind: "discord",
      defaultProviderId: "discord",
      displayName: "Discord"
    },
    expectedCapabilities: [
      true, true, true, true, true, true, 2000, "markdown", ["plain", "markdown"],
      25, 5, 64, 8 * 1024 * 1024, ["provider_file_id", "download_url", "inline_buffer"],
      ["inline_buffer"], "message", "optional", "fixed_backoff", true
    ],
    warningPattern: /verify native Discord signatures\/interactions.*Do not point Discord's Interactions URL directly at Gateway/
  },
  {
    Provider: WhatsAppProvider,
    capabilities: whatsappCapabilities,
    expectedDefinition: {
      providerKind: "whatsapp",
      defaultProviderId: "whatsapp",
      displayName: "WhatsApp"
    },
    expectedCapabilities: [
      false, false, true, true, true, true, 4096, "plain", ["plain"],
      3, 1, 64, 16 * 1024 * 1024, ["provider_file_id", "download_url", "inline_buffer"],
      ["inline_buffer"], "none", "optional", "fixed_backoff", false
    ],
    warningPattern: /verify native platform webhook signatures.*Do not point Meta webhooks directly at Gateway/
  },
  {
    Provider: SignalProvider,
    capabilities: signalCapabilities,
    expectedDefinition: {
      providerKind: "signal",
      defaultProviderId: "signal",
      displayName: "Signal"
    },
    expectedCapabilities: [
      false, false, false, true, true, true, 4096, "plain", ["plain"],
      undefined, undefined, undefined, 100 * 1024 * 1024,
      ["provider_file_id", "download_url", "inline_buffer"],
      ["inline_buffer"], "none", "none", "fixed_backoff", false
    ],
    expectedInheritedCapabilities: {
      maxButtonsPerMessage: 8,
      maxButtonRowsPerMessage: 4,
      maxButtonTokenBytes: 64
    },
    warningPattern: /authenticate its upstream channel.*Do not expose this adapter as an unauthenticated public endpoint/
  }
];

describe("bridge provider contract", () => {
  for (const contract of contracts) {
    it(`keeps ${contract.expectedDefinition.displayName} defaults, capabilities, and security guidance exact`, () => {
      const { Provider, capabilities, expectedDefinition, expectedCapabilities, warningPattern } = contract;
      const definition = Provider.definition;
      const provider = new Provider({
        deliveryUrl: `https://bridge.example.test/${expectedDefinition.providerKind}`,
        sharedSecret: "secret"
      });
      const expectedProviderCapabilities = {
        ...capabilities,
        ...contract.expectedInheritedCapabilities
      };

      assert.deepEqual({
        providerKind: definition.providerKind,
        defaultProviderId: definition.defaultProviderId,
        displayName: definition.displayName
      }, expectedDefinition);
      assert.equal(capabilities, definition.capabilities);
      assert.deepEqual(capabilitySnapshot(capabilities), expectedCapabilities);
      assert.equal(
        Object.keys(capabilities).length,
        expectedCapabilities.filter((value) => value !== undefined).length,
      );
      assert.equal(provider.id, expectedDefinition.defaultProviderId);
      assert.equal(provider.kind, expectedDefinition.providerKind);
      assert.deepEqual(capabilitySnapshot(provider.capabilities), capabilitySnapshot(expectedProviderCapabilities));
      assert.match(definition.securityWarning, /^Bridge-mode only:/);
      assert.match(definition.securityWarning, warningPattern);
      assert.throws(() => new Provider({
        deliveryUrl: `https://bridge.example.test/${expectedDefinition.providerKind}`,
        sharedSecret: " "
      }), {
        name: "Error",
        message: `${expectedDefinition.displayName} bridge sharedSecret is required`
      });
    });
  }
});

function capabilitySnapshot(capabilities: ChannelCapabilities) {
  return capabilityKeys.map((key) => capabilities[key]);
}
