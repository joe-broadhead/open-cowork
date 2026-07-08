import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "@open-cowork/gateway-provider-webhook";

export type DiscordProviderConfig = Omit<WebhookProviderConfig, "providerKind" | "capabilities" | "sharedSecret"> & {
  sharedSecret: string;
};

// Bridge-mode only: a trusted Discord relay must verify native Discord
// signatures/interactions first, then re-sign the normalized payload with this
// shared secret. Do not point Discord's Interactions URL directly at Gateway.
export const discordCapabilities: ChannelCapabilities = {
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
};

export class DiscordProvider extends WebhookProvider {
  constructor(config: DiscordProviderConfig) {
    if (!config.sharedSecret.trim()) {
      throw new Error("Discord bridge sharedSecret is required");
    }
    super({
      ...config,
      providerKind: "discord",
      providerId: config.providerId ?? "discord",
      capabilities: discordCapabilities
    });
  }
}
