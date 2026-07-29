import type { ChannelCapabilities } from "@open-cowork/gateway-channel";
import {
  createBridgeProvider,
  type BridgeProviderConfig,
  type BridgeProviderDefinition
} from "@open-cowork/gateway-provider-webhook";

export type WhatsAppProviderConfig = BridgeProviderConfig;

const whatsappBridgeProviderDefinition: BridgeProviderDefinition<"whatsapp"> = {
  providerKind: "whatsapp",
  defaultProviderId: "whatsapp",
  displayName: "WhatsApp",
  securityWarning: "Bridge-mode only: a trusted WhatsApp/Meta relay must verify native platform webhook signatures first, then re-sign the normalized payload with this shared secret. Do not point Meta webhooks directly at Gateway.",
  capabilities: {
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
    inboundFileModes: ["provider_file_id", "download_url", "inline_buffer"],
    outboundFileModes: ["inline_buffer"],
    editSemantics: "none",
    interactionAcknowledgement: "optional",
    rateLimitStrategy: "fixed_backoff",
    supportsEphemeralResponses: false
  } satisfies ChannelCapabilities
};

export const whatsappCapabilities = whatsappBridgeProviderDefinition.capabilities;

const WhatsAppBridgeProvider = createBridgeProvider(whatsappBridgeProviderDefinition);

export class WhatsAppProvider extends WhatsAppBridgeProvider {}
