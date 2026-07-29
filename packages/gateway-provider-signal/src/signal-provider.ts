import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import {
  createBridgeProvider,
  type BridgeProviderConfig,
  type BridgeProviderDefinition
} from "@open-cowork/gateway-provider-webhook";

export type SignalProviderConfig = BridgeProviderConfig;

const signalBridgeProviderDefinition: BridgeProviderDefinition<"signal"> = {
  providerKind: "signal",
  defaultProviderId: "signal",
  displayName: "Signal",
  securityWarning: "Bridge-mode only: a trusted Signal bridge process must authenticate its upstream channel first, then re-sign the normalized payload with this shared secret. Do not expose this adapter as an unauthenticated public endpoint.",
  capabilities: {
    threads: false,
    messageEditing: false,
    inlineButtons: false,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: true,
    maxTextLength: 4096,
    preferredParseMode: "plain",
    parseModes: ["plain"],
    maxFileBytes: 100 * 1024 * 1024,
    inboundFileModes: ["provider_file_id", "download_url", "inline_buffer"],
    outboundFileModes: ["inline_buffer"],
    editSemantics: "none",
    interactionAcknowledgement: "none",
    rateLimitStrategy: "fixed_backoff",
    supportsEphemeralResponses: false
  } satisfies ChannelCapabilities
};

export const signalCapabilities = signalBridgeProviderDefinition.capabilities;

const SignalBridgeProvider = createBridgeProvider(signalBridgeProviderDefinition);

export class SignalProvider extends SignalBridgeProvider {}
