import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "@open-cowork/gateway-provider-webhook";

export type DiscordProviderConfig = Omit<WebhookProviderConfig, "providerId" | "capabilities" | "sharedSecret"> & {
  sharedSecret: string;
};

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
  supportsEphemeralResponses: true
};

export class DiscordProvider extends WebhookProvider {
  constructor(config: DiscordProviderConfig) {
    if (!config.sharedSecret.trim()) {
      throw new Error("Discord bridge sharedSecret is required");
    }
    super({
      ...config,
      providerId: "discord",
      capabilities: discordCapabilities
    });
  }
}
