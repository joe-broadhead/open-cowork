import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "@open-cowork/gateway-provider-webhook";

export type WhatsAppProviderConfig = Omit<WebhookProviderConfig, "providerKind" | "capabilities" | "sharedSecret"> & {
  sharedSecret: string;
};

export const whatsappCapabilities: ChannelCapabilities = {
  threads: false,
  messageEditing: false,
  inlineButtons: true,
  fileUploads: true,
  fileDownloads: true,
  typingIndicator: true,
  maxTextLength: 4096,
  preferredParseMode: "plain",
  parseModes: ["plain"],
  maxButtonsPerMessage: 3,
  maxButtonRowsPerMessage: 1,
  maxButtonTokenBytes: 64,
  maxFileBytes: 16 * 1024 * 1024,
  maxFileSizeBytes: 16 * 1024 * 1024,
  inboundFileModes: ["provider_file_id", "download_url", "inline_buffer"],
  outboundFileModes: ["inline_buffer"],
  editSemantics: "none",
  interactionAcknowledgement: "optional",
  rateLimitStrategy: "fixed_backoff",
  supportsEphemeralResponses: false
};

export class WhatsAppProvider extends WebhookProvider {
  constructor(config: WhatsAppProviderConfig) {
    if (!config.sharedSecret.trim()) {
      throw new Error("WhatsApp bridge sharedSecret is required");
    }
    super({
      ...config,
      providerKind: "whatsapp",
      providerId: config.providerId ?? "whatsapp",
      capabilities: whatsappCapabilities
    });
  }
}
