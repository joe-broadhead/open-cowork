import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import {
  isCloudMetadataHost,
  mapWebhookPayload,
  resolveWebhookDeliveryAddresses,
  signWebhookDeliveryPayload,
  signWebhookIngressPayload,
  validateWebhookButtons,
  validateWebhookDeliveryUrl,
  WebhookProvider
} from "@open-cowork/gateway-provider-webhook";

describe("webhook delivery URL policy", () => {
  it("blocks cloud metadata endpoints even when private delivery is allowed", () => {
    const policy = { allowPrivateDelivery: true };
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "https://[64:ff9b::169.254.169.254]/",
    ]) {
      expect(() => validateWebhookDeliveryUrl(url, policy)).toThrow();
    }
    expect(isCloudMetadataHost("169.254.169.254")).toBe(true);
    expect(isCloudMetadataHost("metadata.google.internal")).toBe(true);
    expect(isCloudMetadataHost("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64-embedded 169.254.169.254
    expect(isCloudMetadataHost("8.8.8.8")).toBe(false);
  });

  it("blocks NAT64-embedded private targets by default and allows public ones", () => {
    expect(() => validateWebhookDeliveryUrl("https://[64:ff9b::127.0.0.1]/")).toThrow();
    expect(() => validateWebhookDeliveryUrl("https://[64:ff9b::8.8.8.8]/")).not.toThrow();
  });

  it("accepts string DNS resolver records from Node-compatible resolvers", async () => {
    const url = validateWebhookDeliveryUrl("https://bridge.example.test/gateway");

    const addresses = await resolveWebhookDeliveryAddresses(url, {
      resolveHostname: async () => ["93.184.216.34"]
    });
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("WebhookProvider", () => {
  function signedAuth(payload: unknown, sharedSecret = "secret", timestamp = "1772280000") {
    const rawBody = JSON.stringify(payload);
    return {
      rawBody,
      headers: {
        "x-open-cowork-gateway-webhook-timestamp": timestamp,
        "x-open-cowork-gateway-webhook-signature": signWebhookIngressPayload(rawBody, sharedSecret, timestamp)
      }
    };
  }

  async function resolvePublicBridgeHostname() {
    return [{ address: "93.184.216.34", family: 4 }];
  }

  async function resolvePrivateBridgeHostname() {
    return [{ address: "10.1.2.3", family: 4 }];
  }

  it("advertises only the attachment capabilities implemented by the generic bridge", () => {
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway"
    });

    expect(provider.capabilities.fileUploads).toBe(true);
    expect(provider.capabilities.fileDownloads).toBe(false);
  });

  it("fails unsafe bridge delivery configuration before runtime delivery", () => {
    expect(() => new WebhookProvider({
      deliveryUrl: "not a url"
    })).toThrow("Webhook delivery URL is not a valid URL");

    expect(() => new WebhookProvider({
      deliveryUrl: "file:///tmp/bridge"
    })).toThrow("Webhook delivery URL must use http or https");

    expect(() => new WebhookProvider({
      deliveryUrl: "http://bridge.example.test/gateway"
    })).toThrow("Webhook delivery URL must use https unless it targets localhost");

    expect(() => new WebhookProvider({
      deliveryUrl: "http://127.0.0.1:3000/gateway"
    })).not.toThrow();

    expect(() => new WebhookProvider({
      deliveryUrl: "https://user:password@bridge.example.test/gateway"
    })).toThrow("Webhook delivery URL must not include embedded credentials");

    expect(() => new WebhookProvider({
      deliveryUrl: "https://10.1.2.3/gateway"
    })).toThrow("Webhook delivery URL must not target a private or reserved IP literal");

    expect(() => new WebhookProvider({
      deliveryUrl: "https://[::ffff:127.0.0.1]/gateway"
    })).toThrow("Webhook delivery URL must not target a private or reserved IP literal");

    expect(() => new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      deliveryUrlAllowedHosts: ["*.example.com"]
    })).toThrow("Webhook delivery URL host is not allowed");

    expect(() => new WebhookProvider({
      deliveryUrl: "https://bridge.example.com/gateway",
      deliveryUrlAllowedHosts: ["*.example.com"]
    })).not.toThrow();

    expect(() => new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret\nvalue"
    })).toThrow("Webhook shared secret cannot contain control characters");
  });

  it("rejects private or rebound DNS resolutions before bridge delivery", async () => {
    let calls = 0;
    const privateProvider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePrivateBridgeHostname,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    });

    await expect(privateProvider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery URL resolved to a private or reserved address",
    );
    expect(calls).toBe(0);

    const mixedProvider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 }
      ],
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    });
    await expect(mixedProvider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery URL resolved to a private or reserved address",
    );
    expect(calls).toBe(0);

    const reboundLocalhostProvider = new WebhookProvider({
      deliveryUrl: "http://localhost:3000/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    });
    await expect(reboundLocalhostProvider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery URL localhost resolved to a public address",
    );
    expect(calls).toBe(0);
  });

  it("treats transient DNS resolver failures as retryable network errors", async () => {
    let calls = 0;
    const error = new Error("temporary DNS failure") as Error & { code: string };
    error.code = "EAI_AGAIN";
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      retryAttempts: 1,
      resolveDeliveryHostname: async () => {
        throw error;
      },
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery network error",
    );
    expect(calls).toBe(0);
  });

  it("bounds DNS resolution by the delivery timeout", async () => {
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      deliveryTimeoutMs: 10,
      retryAttempts: 1,
      resolveDeliveryHostname: async () => new Promise(() => {}),
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery timed out after 100ms",
    );
    expect(calls).toBe(0);
  });

  it("allows explicit private delivery mode without weakening the default policy", async () => {
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.internal.example/gateway",
      allowPrivateDelivery: true,
      resolveDeliveryHostname: resolvePrivateBridgeHostname,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ messageId: "internal-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).resolves.toMatchObject({
      messageId: "internal-message-id"
    });
    expect(calls).toBe(1);
  });

  it("maps signed bridge payloads to provider-neutral messages", () => {
    const mapped = mapWebhookPayload({
      id: "msg-1",
      target: {
        chatId: "team-chat",
        threadId: "roadmap",
        messageId: "m-1"
      },
      sender: {
        userId: "alice",
        username: "alice",
        displayName: "Alice"
      },
      text: "/status now",
      attachments: [
        {
          providerFileId: "file-1",
          filename: "error.log",
          mimeType: "text/plain",
          sizeBytes: 7,
          bufferBase64: Buffer.from("payload").toString("base64")
        }
      ],
      receivedAt: "2026-05-27T12:00:00.000Z"
    });

    expect(mapped).toMatchObject({
      id: "msg-1",
      provider: "webhook",
      target: {
        provider: "webhook",
        chatId: "team-chat",
        threadId: "roadmap",
        userId: "alice",
        messageId: "m-1"
      },
      sender: {
        providerUserId: "alice",
        username: "alice",
        displayName: "Alice",
        isBot: false
      },
      text: "/status now",
      isCommand: true,
      command: "status",
      commandArgs: "now"
    });
    expect(mapped.receivedAt.toISOString()).toBe("2026-05-27T12:00:00.000Z");
    expect(new TextDecoder().decode(mapped.attachments[0]?.buffer)).toBe("payload");
  });

  it("parses bridge slash commands consistently with provider-neutral command rules", () => {
    expect(mapWebhookPayload({
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "/status@GatewayBot now"
    })).toMatchObject({
      isCommand: true,
      command: "status",
      commandArgs: "now"
    });

    expect(mapWebhookPayload({
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "/123-invalid now"
    })).toMatchObject({
      isCommand: false,
      command: undefined,
      commandArgs: undefined
    });
  });

  it("can map a signed bridge as a future provider id", () => {
    const mapped = mapWebhookPayload({
      target: {
        chatId: "C123",
        threadId: "roadmap"
      },
      sender: {
        userId: "U123"
      },
      text: "/status"
    }, new Date("2026-05-27T12:00:00.000Z"), "slack");

    expect(mapped).toMatchObject({
      provider: "slack",
      target: {
        provider: "slack",
        chatId: "C123",
        threadId: "roadmap",
        userId: "U123"
      },
      sender: {
        providerUserId: "U123"
      }
    });
  });

  it("preserves explicit direct-message targets for future bridge providers", () => {
    const mapped = mapWebhookPayload({
      target: {
        chatId: "D123",
        userId: "U123",
        isDirect: true
      },
      sender: {
        userId: "U123"
      },
      text: "hello"
    }, new Date("2026-05-27T12:00:00.000Z"), "slack");

    expect(mapped.target).toMatchObject({
      provider: "slack",
      chatId: "D123",
      userId: "U123",
      isDirect: true
    });
  });

  it("maps callback-style interactions to messages", () => {
    const mapped = mapWebhookPayload({
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      interaction: {
        id: "interaction-id",
        token: "p:abc123"
      }
    });

    expect(mapped).toMatchObject({
      text: "p:abc123",
      rawText: "p:abc123",
      isCommand: false,
      interaction: {
        id: "interaction-id",
        token: "p:abc123",
        kind: "button"
      }
    });
  });

  it("delivers outgoing gateway messages to the bridge endpoint", async () => {
    const deliveries: Array<{ url: string; headers: Record<string, string>; rawBody: string; body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "whatsapp",
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async (input, init) => {
        const rawBody = String(init?.body);
        deliveries.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          rawBody,
          body: JSON.parse(rawBody)
        });
        return new Response(JSON.stringify({ messageId: "bridge-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const sent = await provider.sendButtons(
      { provider: "whatsapp", chatId: "team-chat", threadId: "roadmap" },
      "Approve?",
      [[{ label: "Approve", token: "p:abc123" }]],
    );

    expect(sent).toMatchObject({
      provider: "whatsapp",
      chatId: "team-chat",
      threadId: "roadmap",
      messageId: "bridge-message-id"
    });
    expect(deliveries).toEqual([
      {
        url: "https://93.184.216.34/gateway",
        headers: expect.objectContaining({
          "content-type": "application/json",
          host: "bridge.example.test",
          "x-open-cowork-gateway-delivery-id": expect.any(String),
          "x-open-cowork-gateway-webhook-signature": expect.any(String),
          "x-open-cowork-gateway-webhook-timestamp": expect.any(String)
        }),
        body: expect.objectContaining({
          deliveryId: expect.any(String),
          idempotencyKey: expect.any(String),
          provider: "whatsapp",
          providerInstanceId: "whatsapp",
          providerKind: "whatsapp",
          type: "buttons",
          target: {
            provider: "whatsapp",
            chatId: "team-chat",
            isDirect: false,
            threadId: "roadmap",
            userId: null,
            messageId: null
          },
          text: "Approve?",
          buttons: [[{ label: "Approve", token: "p:abc123" }]]
        })
      }
    ]);
    expect((deliveries[0]?.body as { deliveryId?: string }).deliveryId).toBe(
      deliveries[0]?.headers["x-open-cowork-gateway-delivery-id"],
    );
    expect((deliveries[0]?.body as { idempotencyKey?: string }).idempotencyKey).toBe(
      deliveries[0]?.headers["x-open-cowork-gateway-delivery-id"],
    );
    expect(deliveries[0]?.headers["x-open-cowork-gateway-webhook-secret"]).toBe(undefined);
    expect(deliveries[0]?.headers["x-open-cowork-gateway-webhook-signature"]).toBe(
      signWebhookDeliveryPayload(
        deliveries[0]?.rawBody || "",
        "secret",
        deliveries[0]?.headers["x-open-cowork-gateway-webhook-timestamp"] || "",
      ),
    );
  });

  it("uses caller supplied delivery ids as downstream idempotency keys", async () => {
    const deliveries: Array<{ headers: Record<string, string>; rawBody: string; body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "webhook-support",
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async (_input, init) => {
        const rawBody = String(init?.body);
        deliveries.push({
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          rawBody,
          body: JSON.parse(rawBody)
        });
        return new Response(JSON.stringify({ messageId: "bridge-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const sent = await provider.sendText(
      { provider: "webhook-support", chatId: "team-chat" },
      "hello",
      { deliveryId: "cloud-delivery-1" },
    );

    expect(sent).toMatchObject({
      providerDeliveryId: "cloud-delivery-1",
      messageId: "bridge-message-id"
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.headers["x-open-cowork-gateway-delivery-id"]).toBe("cloud-delivery-1");
    expect(deliveries[0]?.body).toMatchObject({
      deliveryId: "cloud-delivery-1",
      idempotencyKey: "cloud-delivery-1",
      provider: "webhook-support",
      providerInstanceId: "webhook-support",
      providerKind: "webhook",
      type: "text"
    });
    expect(deliveries[0]?.headers["x-open-cowork-gateway-webhook-signature"]).toBe(
      signWebhookDeliveryPayload(
        deliveries[0]?.rawBody || "",
        "secret",
        deliveries[0]?.headers["x-open-cowork-gateway-webhook-timestamp"] || "",
      ),
    );
  });

  it("delivers files as inline data without exposing gateway local paths", async () => {
    const deliveries: Array<{ body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "slack",
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async (_input, init) => {
        deliveries.push({
          body: JSON.parse(String(init?.body))
        });
        return new Response(JSON.stringify({ messageId: "bridge-file-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendFile(
      { provider: "slack", chatId: "team-chat" },
      {
        filename: "diff.patch",
        mimeType: "text/x-diff",
        localPath: "/srv/repos/private-app/diff.patch",
        data: Buffer.from("patch")
      },
    )).resolves.toMatchObject({
      messageId: "bridge-file-id"
    });
    expect(deliveries).toEqual([
      {
        body: expect.objectContaining({
          type: "file",
          file: {
            filename: "diff.patch",
            mimeType: "text/x-diff",
            dataBase64: Buffer.from("patch").toString("base64")
          }
        })
      }
    ]);
    expect(JSON.stringify(deliveries)).not.toContain("/srv/repos/private-app");
  });

  it("rejects webhook file delivery when only a local path is available", async () => {
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ messageId: "bridge-file-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendFile(
      { provider: "webhook", chatId: "team-chat" },
      {
        filename: "diff.patch",
        localPath: "/srv/repos/private-app/diff.patch"
      },
    )).rejects.toThrow("Webhook file delivery requires inline data; local paths are not exposed to bridge providers");
    expect(calls).toBe(0);
  });

  it("rejects outbound targets for a different bridge provider id", async () => {
    const provider = new WebhookProvider({
      providerId: "slack",
      deliveryUrl: "https://bridge.example.test/gateway"
    });

    await expect(provider.sendText({ provider: "whatsapp", chatId: "chat" }, "hello")).rejects.toThrow(
      "Webhook bridge slack cannot deliver target for provider whatsapp",
    );
  });

  it("normalizes outbound bridge targets and rejects unsafe delivery identifiers", async () => {
    const deliveries: Array<{ body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "slack",
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async (_input, init) => {
        deliveries.push({
          body: JSON.parse(String(init?.body))
        });
        return new Response(JSON.stringify({ messageId: " bridge-message-id " }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendText({
      provider: "slack",
      chatId: " team-chat ",
      threadId: " roadmap ",
      userId: " alice "
    }, "hello")).resolves.toMatchObject({
      chatId: "team-chat",
      threadId: "roadmap",
      messageId: "bridge-message-id"
    });
    expect(deliveries).toEqual([
      {
        body: expect.objectContaining({
          target: {
            provider: "slack",
            chatId: "team-chat",
            isDirect: false,
            threadId: "roadmap",
            userId: "alice",
            messageId: null
          }
        })
      }
    ]);

    await expect(provider.sendText({ provider: "slack", chatId: "team\nchat" }, "hello")).rejects.toThrow(
      "Webhook delivery target.chatId cannot contain control characters",
    );
    await expect(provider.editText({ provider: "slack", chatId: "team-chat" }, "bad\nid", "hello")).rejects.toThrow(
      "Webhook delivery messageId cannot contain control characters",
    );
    await expect(provider.answerInteraction("bad\nid")).rejects.toThrow(
      "Webhook interaction response id cannot contain control characters",
    );
  });

  it("rejects unsafe bridge delivery response ids before they enter gateway state", async () => {
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async () => new Response(JSON.stringify({ messageId: "bridge\nmessage" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery response.messageId cannot contain control characters",
    );
  });

  it("retries transient bridge delivery failures with the same delivery id", async () => {
    const sleeps: number[] = [];
    const deliveryIds: string[] = [];
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async (_input, init) => {
        calls += 1;
        deliveryIds.push(new Headers(init?.headers).get("x-open-cowork-gateway-delivery-id") ?? "");
        if (calls === 1) {
          return new Response("", {
            status: 429,
            headers: { "retry-after": "2" }
          });
        }
        return new Response(JSON.stringify({ messageId: "bridge-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).resolves.toMatchObject({
      messageId: "bridge-message-id"
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(deliveryIds[0]).toBeTruthy();
    expect(deliveryIds[1]).toBe(deliveryIds[0]);
  });

  it("pins the resolved bridge address for production HTTP delivery", async () => {
    const lookups: Array<{ address?: string; family?: number; addresses?: Array<{ address: string; family: number }>; error?: Error | null }> = [];
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      deliveryRequestForTests: (_url, options, callback) => ({
        on() {
          return this;
        },
        end() {
          const lookup = options.lookup as unknown as {
            (
              hostname: string,
              options: unknown,
              callback: (error: Error | null, address?: string, family?: number) => void,
            ): void;
            (
              hostname: string,
              options: unknown,
              callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void,
            ): void;
          };
          lookup("bridge.example.test", {}, (error, address, family) => {
            lookups.push({ error, address, family });
          });
          lookup("bridge.example.test", { all: true }, (error, addresses) => {
            lookups.push({ error, addresses });
          });
          callback({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            resume() {},
            destroy() {},
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(JSON.stringify({ messageId: "bridge-message-id" }));
            }
          } as never);
        }
      } as never)
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).resolves.toMatchObject({
      messageId: "bridge-message-id"
    });
    expect(lookups).toEqual([
      { error: null, address: "93.184.216.34", family: 4 },
      { error: null, addresses: [{ address: "93.184.216.34", family: 4 }] }
    ]);
  });

  it("retries network and timeout delivery failures with bounded jitter", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      retryInitialDelayMs: 1000,
      retryJitterRatio: 0.2,
      random: () => 0.75,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("ECONNRESET");
        }
        if (calls === 2) {
          throw { name: "AbortError" };
        }
        return new Response(JSON.stringify({ messageId: "bridge-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).resolves.toMatchObject({
      messageId: "bridge-message-id"
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1100, 2200]);
  });

  it("caps bridge retry attempts and retry-after delays", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      retryAttempts: 99,
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls += 1;
        return new Response("", {
          status: 429,
          headers: { "retry-after": "3600" }
        });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery failed: 429",
    );

    expect(calls).toBe(5);
    expect(sleeps).toEqual([10000, 10000, 10000, 10000]);
  });

  it("does not retry non-transient bridge delivery failures", async () => {
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      sleep: async () => {
        throw new Error("sleep should not be called");
      },
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 400 });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery failed: 400",
    );
    expect(calls).toBe(1);
  });

  it("opens and recovers a bridge circuit after repeated transient delivery failures", async () => {
    let nowMs = 0;
    let healthy = false;
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      retryAttempts: 1,
      circuitBreakerFailureThreshold: 2,
      circuitBreakerCooldownMs: 5000,
      now: () => new Date(nowMs),
      fetch: async () => {
        calls += 1;
        return healthy
          ? new Response(JSON.stringify({ messageId: "bridge-message-id" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
          : new Response("", { status: 500 });
      }
    });

    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery failed: 500",
    );
    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery failed: 500",
    );
    expect(calls).toBe(2);
    expect(provider.health()).toMatchObject({
      ok: false,
      state: "degraded",
      error: "Webhook delivery circuit is open for 5000ms"
    });

    healthy = true;
    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).rejects.toThrow(
      "Webhook delivery circuit is open for 5000ms",
    );
    expect(calls).toBe(2);

    nowMs = 6000;
    await expect(provider.sendText({ provider: "webhook", chatId: "team-chat" }, "hello")).resolves.toMatchObject({
      messageId: "bridge-message-id"
    });
    expect(calls).toBe(3);
    expect(provider.health()).toMatchObject({ ok: true, state: "ready", error: null });
  });

  it("dispatches incoming payloads through the started handler", async () => {
    const seen: string[] = [];
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z")
    });
    await provider.start(async (message) => {
      seen.push(message.text);
    });
    const payload = {
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "hello"
    };
    await provider.handleWebhookPayload(payload, signedAuth(payload));
    await provider.stop();

    expect(seen).toEqual(["hello"]);
  });

  it("requires signed timestamp ingress before dispatch", async () => {
    const seen: string[] = [];
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z")
    });
    await provider.start(async (message) => {
      seen.push(message.text);
    });

    const payload = {
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "hello"
    };
    await expect(provider.handleWebhookPayload(payload, {})).rejects.toThrow(
      "Webhook timestamp signature is required for ingress",
    );
    await expect(provider.handleWebhookPayload(payload, {
      ...signedAuth(payload, "wrong"),
    })).rejects.toThrow(
      "Webhook signature verification failed",
    );
    await provider.handleWebhookPayload(payload, signedAuth(payload));

    expect(seen).toEqual(["hello"]);
    await provider.stop();
  });

  it("rejects stale or replayed signed ingress payloads", async () => {
    const payload = {
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "hello"
    };
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z")
    });
    const seen: string[] = [];
    await provider.start(async (message) => {
      seen.push(message.id);
    });

    await expect(provider.handleWebhookPayload(payload, signedAuth(payload, "secret", "1772279000"))).rejects.toThrow(
      "Webhook timestamp is outside the allowed window",
    );

    const auth = signedAuth(payload);
    await provider.handleWebhookPayload(payload, auth);
    await expect(provider.handleWebhookPayload(payload, auth)).rejects.toThrow(
      "Webhook signature replay rejected",
    );
    expect(seen).toHaveLength(1);
    await provider.stop();
  });

  it("releases signed ingress replay claims when handler dispatch fails", async () => {
    const payload = {
      id: "retry-message",
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "hello"
    };
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z")
    });
    const seen: string[] = [];
    let attempts = 0;
    await provider.start(async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("store offline");
      seen.push(message.id);
    });

    const auth = signedAuth(payload);
    await expect(provider.handleWebhookPayload(payload, auth)).rejects.toThrow("store offline");
    await provider.handleWebhookPayload(payload, auth);
    await expect(provider.handleWebhookPayload(payload, auth)).rejects.toThrow(
      "Webhook signature replay rejected",
    );

    expect(attempts).toBe(2);
    expect(seen).toEqual(["retry-message"]);
    await provider.stop();
  });

  it("does not release newer signed ingress replay claims from older handler failures", async () => {
    const firstPayload = {
      id: "first-message",
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "first"
    };
    const secondPayload = {
      id: "second-message",
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "second"
    };
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z"),
      maxSeenIngressSignatures: 1
    });
    const seen: string[] = [];
    let firstAttempts = 0;
    let failOriginalFirst: (error: Error) => void = () => {};
    await provider.start(async (message) => {
      if (message.id === "first-message") {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          await new Promise<void>((_, reject) => {
            failOriginalFirst = reject;
          });
          return;
        }
      }
      seen.push(message.id);
    });

    const firstAuth = signedAuth(firstPayload);
    const originalFirst = provider.handleWebhookPayload(firstPayload, firstAuth);
    await new Promise((resolve) => setImmediate(resolve));

    await provider.handleWebhookPayload(secondPayload, signedAuth(secondPayload, "secret", "1772280001"));
    await provider.handleWebhookPayload(firstPayload, firstAuth);
    failOriginalFirst(new Error("store offline"));
    await expect(originalFirst).rejects.toThrow("store offline");
    await expect(provider.handleWebhookPayload(firstPayload, firstAuth)).rejects.toThrow(
      "Webhook signature replay rejected",
    );

    expect(seen).toEqual(["second-message", "first-message"]);
    await provider.stop();
  });

  it("keeps signed ingress replay eviction scoped by bridge target", async () => {
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z"),
      maxSeenIngressSignatures: 10,
      maxSeenIngressSignaturesPerScope: 2
    });
    const seen: string[] = [];
    await provider.start(async (message) => {
      seen.push(message.id);
    });

    const preservedPayload = {
      id: "team-b-first",
      target: { chatId: "team-b" },
      sender: { userId: "bob" },
      text: "preserve replay claim"
    };
    const preservedAuth = signedAuth(preservedPayload, "secret", "1772280001");
    await provider.handleWebhookPayload(preservedPayload, preservedAuth);

    let newestFloodPayload: { id: string, target: { chatId: string }, sender: { userId: string }, text: string } | null = null;
    let newestFloodAuth: ReturnType<typeof signedAuth> | null = null;
    for (let index = 0; index < 3; index += 1) {
      const payload = {
        id: `team-a-${index}`,
        target: { chatId: "team-a" },
        sender: { userId: "alice" },
        text: `flood ${index}`
      };
      const auth = signedAuth(payload, "secret", String(1772280002 + index));
      await provider.handleWebhookPayload(payload, auth);
      newestFloodPayload = payload;
      newestFloodAuth = auth;
    }

    if (!newestFloodPayload || !newestFloodAuth) throw new Error("missing newest flood request");
    await expect(provider.handleWebhookPayload(newestFloodPayload, newestFloodAuth)).rejects.toThrow(
      "Webhook signature replay rejected",
    );
    await expect(provider.handleWebhookPayload(preservedPayload, preservedAuth)).rejects.toThrow(
      "Webhook signature replay rejected",
    );
    expect(seen).toHaveLength(4);
    await provider.stop();
  });

  it("rejects ingress when no shared secret has been configured", async () => {
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway"
    });
    await provider.start(async () => {});

    await expect(provider.handleWebhookPayload({
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "hello"
    }, {})).rejects.toThrow("Webhook shared secret is required for ingress");

    await provider.stop();
  });

  it("validates required incoming and outgoing fields", () => {
    expect(() => mapWebhookPayload({})).toThrow("Webhook target must be an object");
    expect(() => mapWebhookPayload({ target: {}, sender: { userId: "alice" } })).toThrow("Webhook target.chatId is required");
    expect(() => validateWebhookButtons([[{ label: "", token: "p:abc123" }]])).toThrow("Webhook button label cannot be empty");
    expect(() => validateWebhookButtons([[{ label: "Approve", token: "" }]])).toThrow("Webhook button token cannot be empty");
  });

  it("normalizes and rejects unsafe bridge identity fields at ingress", () => {
    expect(mapWebhookPayload({
      target: {
        chatId: " team-chat ",
        threadId: " roadmap ",
        userId: " alice "
      },
      sender: {
        userId: " alice ",
        username: " alice "
      },
      text: "hello"
    })).toMatchObject({
      target: {
        chatId: "team-chat",
        threadId: "roadmap",
        userId: "alice"
      },
      sender: {
        providerUserId: "alice",
        username: "alice"
      }
    });

    expect(() =>
      mapWebhookPayload({
        target: { chatId: "team\nchat" },
        sender: { userId: "alice" },
        text: "hello"
      }),
    ).toThrow("Webhook target.chatId cannot contain control characters");

    expect(() =>
      mapWebhookPayload({
        target: { chatId: "team-chat" },
        sender: { userId: `u_${"a".repeat(600)}` },
        text: "hello"
      }),
    ).toThrow("Webhook sender.userId cannot exceed 512 bytes");
  });

  it("rejects callback tokens that cannot survive provider bridges", () => {
    const longToken = `p:${"a".repeat(63)}`;
    expect(() => validateWebhookButtons([[{ label: "Approve", token: longToken }]])).toThrow(
      "Webhook button token cannot exceed 64 bytes",
    );
    expect(() =>
      mapWebhookPayload({
        target: { chatId: "team-chat" },
        sender: { userId: "alice" },
        interaction: {
          id: "interaction-id",
          token: "p:abc\n123"
        }
      }),
    ).toThrow("Webhook interaction.token cannot contain control characters");
  });

  it("rejects malformed attachment payloads at the bridge boundary", () => {
    const basePayload = {
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "see attached"
    };

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: [{ filename: "error.log", bufferBase64: "not-valid!" }]
      }),
    ).toThrow("Webhook attachment.bufferBase64 must be valid base64");

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: [
          {
            filename: "error.log",
            sizeBytes: 99,
            bufferBase64: Buffer.from("payload").toString("base64")
          }
        ]
      }),
    ).toThrow("Webhook attachment.sizeBytes does not match decoded buffer length");

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: [{ filename: "error.log", sizeBytes: -1 }]
      }),
    ).toThrow("Webhook attachment.sizeBytes must be a non-negative integer");

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: Array.from({ length: 21 }, (_, index) => ({ filename: `error-${index}.log` }))
      }),
    ).toThrow("Webhook attachments cannot exceed 20 files");

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: [{ filename: "error\n.log" }]
      }),
    ).toThrow("Webhook attachment.filename cannot contain control characters");

    expect(() =>
      mapWebhookPayload({
        ...basePayload,
        attachments: [{ filename: `${"a".repeat(260)}.log` }]
      }),
    ).toThrow("Webhook attachment.filename cannot exceed 255 bytes");
  });

  it("rejects attachments larger than the configured bridge limit before dispatch", async () => {
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      now: () => new Date("2026-02-28T12:00:00.000Z"),
      maxAttachmentBytes: 4
    });
    const seen: string[] = [];
    await provider.start(async (message) => {
      seen.push(message.id);
    });

    const payload = {
      target: { chatId: "team-chat" },
      sender: { userId: "alice" },
      text: "see attached",
      attachments: [
        {
          filename: "error.log",
          sizeBytes: 5,
          bufferBase64: Buffer.from("12345").toString("base64")
        }
      ]
    };
    await expect(provider.handleWebhookPayload(payload, signedAuth(payload))).rejects.toThrow("Webhook attachment exceeds max size of 4 bytes");
    expect(seen).toEqual([]);

    await provider.stop();
  });

  it("enforces the bridge attachment size limit for declared remote files", () => {
    expect(() =>
      mapWebhookPayload({
        target: { chatId: "team-chat" },
        sender: { userId: "alice" },
        text: "see attached",
        attachments: [
          {
            providerFileId: "remote-file",
            filename: "error.log",
            sizeBytes: 5
          }
        ]
      }, new Date(), "webhook", { maxAttachmentBytes: 4 }),
    ).toThrow("Webhook attachment exceeds max size of 4 bytes");
  });
});
