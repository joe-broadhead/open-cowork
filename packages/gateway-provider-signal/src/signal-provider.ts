import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "@open-cowork/gateway-provider-webhook";

export type SignalProviderConfig = Omit<WebhookProviderConfig, "providerKind" | "capabilities" | "sharedSecret"> & {
  sharedSecret: string;
};

// Bridge-mode only: a trusted Signal bridge process must authenticate its
// upstream channel first, then re-sign the normalized payload with this shared
// secret. Do not expose this adapter as an unauthenticated public endpoint.
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
  maxFileSizeBytes: 100 * 1024 * 1024,
  inboundFileModes: ["provider_file_id", "download_url", "inline_buffer"],
  outboundFileModes: ["inline_buffer"],
  editSemantics: "none",
  interactionAcknowledgement: "none",
  rateLimitStrategy: "fixed_backoff",
  supportsEphemeralResponses: false
};

export class SignalProvider extends WebhookProvider {
  constructor(config: SignalProviderConfig) {
    if (!config.sharedSecret.trim()) {
      throw new Error("Signal bridge sharedSecret is required");
    }
    super({
      ...config,
      providerKind: "signal",
      providerId: config.providerId ?? "signal",
      capabilities: signalCapabilities
    });
  }
}
