import test from "node:test";
import assert from "node:assert/strict";

import { loadStandaloneGatewayConfig } from "../dist/config.js";
import { createStandaloneProviderRegistry } from "../dist/provider-registry.js";

function providerConfig(input: {
  webhook?: boolean;
  telegramMode?: "webhook" | "polling";
} = {}) {
  const telegramMode = input.telegramMode || "webhook";
  return loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_STORE: "memory",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-test-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: "/var/lib/open-cowork/standalone-gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN: "telegram-test-token",
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_MODE: telegramMode,
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_PUBLIC_URL: "https://gateway.example.test",
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-test-secret",
    ...(input.webhook
      ? {
          OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-test-secret",
          OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
        }
      : {}),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("provider registry stops a live provider after concurrent webhook configuration", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig());
  const registration = registry.registrations[0];
  assert.ok(registration);

  const configureEntered = deferred();
  const releaseConfigure = deferred();
  let configureExited = false;
  let stopEnteredBeforeConfigureExit = false;
  let providerLive = false;
  let providerStarts = 0;
  let providerStops = 0;
  registration.provider.start = async () => {
    providerStarts += 1;
    providerLive = true;
  };
  const telegram = registration.provider as typeof registration.provider & {
    configureWebhook(): Promise<void>;
  };
  telegram.configureWebhook = async () => {
    configureEntered.resolve();
    await releaseConfigure.promise;
    configureExited = true;
  };
  registration.provider.stop = async () => {
    stopEnteredBeforeConfigureExit = !configureExited;
    providerStops += 1;
    providerLive = false;
  };

  const start = registry.start(async () => undefined);
  await configureEntered.promise;
  const stop = registry.stop();
  releaseConfigure.resolve();
  await Promise.all([start, stop]);

  assert.equal(providerStarts, 1);
  assert.equal(providerStops, 1);
  assert.equal(stopEnteredBeforeConfigureExit, false);
  assert.equal(providerLive, false);
  assert.equal(registration.started, false);
});

test("provider registry preserves retryable live state when webhook cleanup fails", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig());
  const registration = registry.registrations[0];
  assert.ok(registration);
  const configureError = new Error("configure failed");
  const cleanupError = new Error("cleanup failed");
  let startAttempts = 0;
  let stopAttempts = 0;
  registration.provider.start = async () => {
    startAttempts += 1;
  };
  const telegram = registration.provider as typeof registration.provider & {
    configureWebhook(): Promise<void>;
  };
  telegram.configureWebhook = async () => {
    throw configureError;
  };
  registration.provider.stop = async () => {
    stopAttempts += 1;
    if (stopAttempts === 1) throw cleanupError;
  };

  await assert.rejects(
    registry.start(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [configureError, cleanupError]);
      return true;
    },
  );

  assert.equal(registration.started, true);
  await assert.rejects(
    registry.start(async () => undefined),
    /already started.*stop.*retry/i,
  );
  assert.equal(startAttempts, 1);
  await registry.stop();
  assert.equal(stopAttempts, 2);
  assert.equal(registration.started, false);
});

test("provider registry attempts every live stop and retries aggregated failures", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig({ webhook: true }));
  const telegramRegistration = registry.registrations.find((registration) => registration.config.kind === "telegram");
  const webhookRegistration = registry.registrations.find((registration) => registration.config.kind === "webhook");
  assert.ok(telegramRegistration);
  assert.ok(webhookRegistration);
  for (const registration of registry.registrations) {
    registration.provider.start = async () => undefined;
  }
  const telegram = telegramRegistration.provider as typeof telegramRegistration.provider & {
    configureWebhook(): Promise<void>;
  };
  telegram.configureWebhook = async () => undefined;
  await registry.start(async () => undefined);

  const telegramStopError = new Error("telegram stop failed");
  const webhookStopError = new Error("webhook stop failed");
  let telegramStopAttempts = 0;
  let webhookStopAttempts = 0;
  telegramRegistration.provider.stop = async () => {
    telegramStopAttempts += 1;
    if (telegramStopAttempts === 1) throw telegramStopError;
  };
  webhookRegistration.provider.stop = async () => {
    webhookStopAttempts += 1;
    if (webhookStopAttempts === 1) throw webhookStopError;
  };

  await assert.rejects(
    registry.stop(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [webhookStopError, telegramStopError]);
      return true;
    },
  );
  assert.equal(webhookStopAttempts, 1);
  assert.equal(telegramStopAttempts, 1);
  assert.equal(webhookRegistration.started, true);
  assert.equal(telegramRegistration.started, true);

  await registry.stop();
  assert.equal(webhookStopAttempts, 2);
  assert.equal(telegramStopAttempts, 2);
  assert.equal(webhookRegistration.started, false);
  assert.equal(telegramRegistration.started, false);
});

test("provider registry rejects duplicate start until a successful stop", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig());
  const registration = registry.registrations[0];
  assert.ok(registration);
  let startAttempts = 0;
  let configureAttempts = 0;
  let stopAttempts = 0;
  registration.provider.start = async () => {
    startAttempts += 1;
  };
  const telegram = registration.provider as typeof registration.provider & {
    configureWebhook(): Promise<void>;
  };
  telegram.configureWebhook = async () => {
    configureAttempts += 1;
  };
  registration.provider.stop = async () => {
    stopAttempts += 1;
  };

  await registry.start(async () => undefined);
  await assert.rejects(
    registry.start(async () => undefined),
    /already started.*stop.*retry/i,
  );
  assert.equal(startAttempts, 1);
  assert.equal(configureAttempts, 1);

  await registry.stop();
  await registry.start(async () => undefined);
  assert.equal(startAttempts, 2);
  assert.equal(configureAttempts, 2);
  assert.equal(stopAttempts, 1);
  await registry.stop();
  assert.equal(stopAttempts, 2);
});

test("provider registry blocks restart after partial startup without double invocation", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig({ webhook: true }));
  const telegramRegistration = registry.registrations.find((registration) => registration.config.kind === "telegram");
  const webhookRegistration = registry.registrations.find((registration) => registration.config.kind === "webhook");
  assert.ok(telegramRegistration);
  assert.ok(webhookRegistration);
  const webhookStartError = new Error("webhook start failed");
  let telegramStarts = 0;
  let webhookStarts = 0;
  let telegramStops = 0;
  let webhookStops = 0;
  telegramRegistration.provider.start = async () => {
    telegramStarts += 1;
  };
  const telegram = telegramRegistration.provider as typeof telegramRegistration.provider & {
    configureWebhook(): Promise<void>;
  };
  telegram.configureWebhook = async () => undefined;
  webhookRegistration.provider.start = async () => {
    webhookStarts += 1;
    if (webhookStarts === 1) throw webhookStartError;
  };
  telegramRegistration.provider.stop = async () => {
    telegramStops += 1;
  };
  webhookRegistration.provider.stop = async () => {
    webhookStops += 1;
  };

  await assert.rejects(
    registry.start(async () => undefined),
    (error: unknown) => error === webhookStartError,
  );
  assert.equal(telegramRegistration.started, true);
  assert.equal(webhookRegistration.started, false);
  await assert.rejects(
    registry.start(async () => undefined),
    /already started.*stop.*retry/i,
  );
  assert.equal(telegramStarts, 1);
  assert.equal(webhookStarts, 1);

  await registry.stop();
  assert.equal(telegramStops, 1);
  assert.equal(webhookStops, 0);
  await registry.start(async () => undefined);
  assert.equal(telegramStarts, 2);
  assert.equal(webhookStarts, 2);
  assert.equal(telegramRegistration.started, true);
  assert.equal(webhookRegistration.started, true);
  await registry.stop();
  assert.equal(telegramStops, 2);
  assert.equal(webhookStops, 1);
});

test("provider registry marks webhook ingress for redelivery but not Telegram polling", async () => {
  for (const mode of ["webhook", "polling"] as const) {
    const registry = createStandaloneProviderRegistry(providerConfig({ telegramMode: mode }));
    const registration = registry.registrations[0];
    assert.ok(registration);
    let providerHandler: ((message: unknown) => Promise<void>) | null = null;
    registration.provider.start = async (handler) => {
      providerHandler = handler;
    };
    registration.provider.stop = async () => undefined;
    const telegram = registration.provider as typeof registration.provider & {
      configureWebhook(): Promise<void>;
    };
    telegram.configureWebhook = async () => undefined;
    const contexts: unknown[] = [];

    await registry.start(async (_config, _message, context) => {
      contexts.push(context);
    });
    assert.ok(providerHandler);
    await providerHandler({} as never);

    assert.deepEqual(contexts, [{
      failureHandoff: mode === "webhook" ? "provider-redelivery" : "none",
    }], mode);
    await registry.stop();
  }
});

test("provider registry marks signed generic webhooks for provider redelivery", async () => {
  const registry = createStandaloneProviderRegistry(providerConfig({ webhook: true }));
  const handlers = new Map<string, (message: unknown) => Promise<void>>();
  for (const registration of registry.registrations) {
    registration.provider.start = async (handler) => {
      handlers.set(registration.config.id, handler);
    };
    registration.provider.stop = async () => undefined;
    if (registration.config.kind === "telegram") {
      const telegram = registration.provider as typeof registration.provider & {
        configureWebhook(): Promise<void>;
      };
      telegram.configureWebhook = async () => undefined;
    }
  }
  const contexts = new Map<string, unknown>();

  await registry.start(async (config, _message, context) => {
    contexts.set(config.kind, context);
  });
  const webhook = registry.registrations.find((registration) => registration.config.kind === "webhook");
  assert.ok(webhook);
  const webhookHandler = handlers.get(webhook.config.id);
  assert.ok(webhookHandler);
  await webhookHandler({} as never);

  assert.deepEqual(contexts.get("webhook"), {
    failureHandoff: "provider-redelivery",
  });
  await registry.stop();
});
