import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import {
  createBridgeProvider,
  type BridgeProviderConfig,
  type BridgeProviderDefinition
} from "@open-cowork/gateway-provider-webhook";

export type DiscordProviderConfig = BridgeProviderConfig;

const discordBridgeProviderDefinition: BridgeProviderDefinition<"discord"> = {
  providerKind: "discord",
  defaultProviderId: "discord",
  displayName: "Discord",
  securityWarning: "Bridge-mode only: a trusted Discord relay must verify native Discord signatures/interactions first, then re-sign the normalized payload with this shared secret. Do not point Discord's Interactions URL directly at Gateway.",
  capabilities: {
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: true,
    maxTextLength: 2000,
    preferredParseMode: "markdown",
    parseModes: ["plain", "markdown"],
    maxButtonsPerMessage: 25,
    maxButtonRowsPerMessage: 5,
    maxButtonTokenBytes: 64,
    maxFileBytes: 8 * 1024 * 1024,
    inboundFileModes: ["provider_file_id", "download_url", "inline_buffer"],
    outboundFileModes: ["inline_buffer"],
    editSemantics: "message",
    interactionAcknowledgement: "optional",
    rateLimitStrategy: "fixed_backoff",
    supportsEphemeralResponses: true
  } satisfies ChannelCapabilities
};

export const discordCapabilities = discordBridgeProviderDefinition.capabilities;

const DiscordBridgeProvider = createBridgeProvider(discordBridgeProviderDefinition);

export class DiscordProvider extends DiscordBridgeProvider {}
