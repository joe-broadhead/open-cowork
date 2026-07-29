import type { IncomingHttpHeaders } from "node:http";

import {
  ChannelStackTelemetry,
  type ChannelProvider,
  type IncomingChannelMessage,
  WebhookProviderNotFoundError,
} from "@open-cowork/gateway-channel";
import { TelegramProvider } from "@open-cowork/gateway-provider-telegram";
import { WebhookProvider } from "@open-cowork/gateway-provider-webhook";

import type {
  StandaloneGatewayConfig,
  StandaloneGatewayProviderConfig,
  StandaloneInboundDeliveryContext,
} from "./types.js";

export interface StandaloneProviderRegistration {
  config: StandaloneGatewayProviderConfig;
  provider: ChannelProvider;
  started: boolean;
}

export interface StandaloneProviderRegistry {
  readonly registrations: StandaloneProviderRegistration[];
  readonly telemetry?: ChannelStackTelemetry;
  start(handler: (
    config: StandaloneGatewayProviderConfig,
    message: IncomingChannelMessage,
    delivery: StandaloneInboundDeliveryContext,
  ) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  refreshTelemetry(): void;
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
  const telemetry = new ChannelStackTelemetry("standalone-gateway", ["monorepo-provider"]);
  const syncTelemetry = () => {
    const kinds = new Set(registrations.map((registration) => registration.config.kind));
    for (const kind of kinds) {
      telemetry.setBindingCount(
        "monorepo-provider",
        kind,
        "configured",
        registrations.filter((registration) => registration.config.kind === kind).length,
      );
      telemetry.setBindingCount(
        "monorepo-provider",
        kind,
        "active",
        registrations.filter((registration) =>
          registration.config.kind === kind && isActive(registration)).length,
      );
    }
  };
  syncTelemetry();
  let lifecycleTail = Promise.resolve();
  const runLifecycleOperation = (operation: () => Promise<void>) => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.catch(() => undefined);
    return result;
  };

  return {
    registrations,
    telemetry,
    refreshTelemetry: syncTelemetry,
    start(handler) {
      return runLifecycleOperation(async () => {
        const liveProviderIds = registrations
          .filter((registration) => registration.started)
          .map((registration) => registration.config.id);
        if (liveProviderIds.length > 0) {
          throw new Error(
            `Standalone provider registry is already started for ${liveProviderIds.join(", ")}. Call stop() and retry start().`,
          );
        }
        for (const registration of registrations) {
          const delivery = inboundDeliveryContext(registration.config);
          await registration.provider.start((message) =>
            handler(registration.config, message, delivery));
          registration.started = true;
          syncTelemetry();
          try {
            if (registration.config.kind === "telegram") {
              await (registration.provider as TelegramProvider).configureWebhook();
            }
          } catch (configureError) {
            try {
              await registration.provider.stop();
              registration.started = false;
            } catch (cleanupError) {
              throw new AggregateError(
                [configureError, cleanupError],
                `Standalone provider ${registration.config.id} configuration and cleanup both failed.`,
                { cause: cleanupError },
              );
            } finally {
              syncTelemetry();
            }
            throw configureError;
          }
        }
      });
    },
    stop() {
      return runLifecycleOperation(async () => {
        const failures: unknown[] = [];
        for (const registration of [...registrations].reverse()) {
          if (!registration.started) continue;
          try {
            await registration.provider.stop();
            registration.started = false;
          } catch (error) {
            failures.push(error);
          } finally {
            syncTelemetry();
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `Failed to stop ${failures.length} standalone provider(s).`);
        }
      });
    },
    get(id) {
      return registrations.find((registration) => registration.config.id === id) || null;
    },
    async handleWebhook(id, payload, headers, rawBody) {
      const registration = this.get(id);
      if (!registration) throw new WebhookProviderNotFoundError(`Unknown standalone gateway provider ${id}.`);
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
      throw new WebhookProviderNotFoundError(`Standalone provider ${id} does not expose webhook ingress.`);
    },
  };
}

function inboundDeliveryContext(
  config: StandaloneGatewayProviderConfig,
): StandaloneInboundDeliveryContext {
  const webhookIngress = config.kind === "webhook"
    || (config.kind === "telegram" && config.settings.mode === "webhook");
  return {
    failureHandoff: webhookIngress ? "provider-redelivery" : "none",
  };
}

function isActive(registration: StandaloneProviderRegistration): boolean {
  if (!registration.started) return false;
  try {
    return registration.provider.health?.().ok ?? true;
  } catch {
    return false;
  }
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
