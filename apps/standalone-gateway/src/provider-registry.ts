import type { IncomingHttpHeaders } from "node:http";

import type { ChannelProvider, IncomingChannelMessage } from "@open-cowork/gateway-channel";
import { TelegramProvider } from "@open-cowork/gateway-provider-telegram";
import { WebhookProvider } from "@open-cowork/gateway-provider-webhook";

import type { StandaloneGatewayConfig, StandaloneGatewayProviderConfig } from "./types.js";

export interface StandaloneProviderRegistration {
  config: StandaloneGatewayProviderConfig;
  provider: ChannelProvider;
  started: boolean;
}

export interface StandaloneProviderRegistry {
  readonly registrations: StandaloneProviderRegistration[];
  start(handler: (config: StandaloneGatewayProviderConfig, message: IncomingChannelMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  get(id: string): StandaloneProviderRegistration | null;
  handleWebhook(id: string, payload: unknown, headers: IncomingHttpHeaders, rawBody?: string): Promise<void>;
}

export function createStandaloneProviderRegistry(config: StandaloneGatewayConfig): StandaloneProviderRegistry {
  const registrations = config.providers
    .filter((provider) => provider.enabled)
    .map((provider): StandaloneProviderRegistration => ({
      config: provider,
      provider: createProvider(provider),
      started: false,
    }));

  return {
    registrations,
    async start(handler) {
      for (const registration of registrations) {
        await registration.provider.start((message) => handler(registration.config, message));
        registration.started = true;
        if (registration.config.kind === "telegram") {
          await (registration.provider as TelegramProvider).configureWebhook();
        }
      }
    },
    async stop() {
      for (const registration of [...registrations].reverse()) {
        if (!registration.started) continue;
        await registration.provider.stop();
        registration.started = false;
      }
    },
    get(id) {
      return registrations.find((registration) => registration.config.id === id) || null;
    },
    async handleWebhook(id, payload, headers, rawBody) {
      const registration = this.get(id);
      if (!registration) throw new Error(`Unknown standalone gateway provider ${id}.`);
      if (registration.config.kind === "telegram") {
        await (registration.provider as TelegramProvider).handleWebhookUpdate(payload, {
          headers,
          secretToken: registration.config.credentials.webhookSecret || null,
        });
        return;
      }
      if (registration.config.kind === "webhook") {
        await (registration.provider as WebhookProvider).handleWebhookPayload(payload, {
          headers,
          rawBody,
        });
        return;
      }
      throw new Error(`Standalone provider ${id} does not expose webhook ingress.`);
    },
  };
}

function createProvider(config: StandaloneGatewayProviderConfig): ChannelProvider {
  if (config.kind === "telegram") {
    const mode = config.settings.mode === "webhook" ? "webhook" : "polling";
    return new TelegramProvider({
      providerId: config.id,
      botToken: requiredCredential(config, "botToken"),
      mode,
      webhook: mode === "webhook"
        ? {
            publicBaseUrl: requiredSetting(config, "publicBaseUrl"),
            path: `/webhooks/${encodeURIComponent(config.id)}`,
            secretToken: requiredCredential(config, "webhookSecret"),
          }
        : undefined,
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
    });
  }
  if (config.kind === "webhook") {
    return new WebhookProvider({
      providerId: config.id,
      deliveryUrl: requiredSetting(config, "deliveryUrl"),
      sharedSecret: requiredCredential(config, "sharedSecret"),
    });
  }
  throw new Error(`Standalone provider kind ${config.kind} is not supported yet.`);
}

function requiredCredential(config: StandaloneGatewayProviderConfig, key: string): string {
  const value = config.credentials[key];
  if (!value) throw new Error(`Standalone provider ${config.id} requires credential ${key}.`);
  return value;
}

function requiredSetting(config: StandaloneGatewayProviderConfig, key: string): string {
  const value = config.settings[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Standalone provider ${config.id} requires setting ${key}.`);
  return value.trim();
}
