import type {
  ChannelCapabilities,
  ChannelProviderId,
  ChannelProviderKind
} from "@open-cowork/gateway-channel";
import { WebhookProvider, type WebhookProviderConfig } from "./webhook-provider.js";

export type BridgeProviderConfig = Omit<
  WebhookProviderConfig,
  "providerKind" | "capabilities" | "sharedSecret"
> & {
  sharedSecret: string;
};

export type BridgeProviderDefinition<Kind extends ChannelProviderKind = ChannelProviderKind> = Readonly<{
  providerKind: Kind;
  defaultProviderId: Extract<ChannelProviderId, Kind>;
  displayName: string;
  capabilities: ChannelCapabilities;
  securityWarning: string;
}>;

export type BridgeProviderConstructor<Kind extends ChannelProviderKind = ChannelProviderKind> = {
  readonly definition: BridgeProviderDefinition<Kind>;
  new (config: BridgeProviderConfig): WebhookProvider;
};

export function createBridgeProvider<Kind extends ChannelProviderKind>(
  definition: BridgeProviderDefinition<Kind>,
): BridgeProviderConstructor<Kind> {
  return class BridgeProvider extends WebhookProvider {
    static readonly definition = definition;

    constructor(config: BridgeProviderConfig) {
      if (!config.sharedSecret.trim()) {
        throw new Error(`${definition.displayName} bridge sharedSecret is required`);
      }
      super({
        ...config,
        providerKind: definition.providerKind,
        providerId: config.providerId ?? definition.defaultProviderId,
        capabilities: definition.capabilities
      });
    }
  };
}
