import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "@open-cowork/gateway-provider-webhook";

export type SignalProviderConfig = Omit<WebhookProviderConfig, "providerId" | "capabilities" | "sharedSecret"> & {
  sharedSecret: string;
};

export const signalCapabilities: ChannelCapabilities = {
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
  supportsEphemeralResponses: false
};

export class SignalProvider extends WebhookProvider {
  constructor(config: SignalProviderConfig) {
    if (!config.sharedSecret.trim()) {
      throw new Error("Signal bridge sharedSecret is required");
    }
    super({
      ...config,
      providerId: "signal",
      capabilities: signalCapabilities
    });
  }
}
