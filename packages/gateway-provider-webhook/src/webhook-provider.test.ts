import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import {
  mapWebhookPayload,
  signWebhookIngressPayload,
  validateWebhookButtons,
  WebhookProvider
} from "@open-cowork/gateway-provider-webhook";

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
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret\nvalue"
    })).toThrow("Webhook shared secret cannot contain control characters");
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
    const deliveries: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "whatsapp",
      deliveryUrl: "https://bridge.example.test/gateway",
      sharedSecret: "secret",
      fetch: async (input, init) => {
        deliveries.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body))
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
        url: "https://bridge.example.test/gateway",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-open-cowork-gateway-delivery-id": expect.any(String),
          "x-open-cowork-gateway-webhook-secret": "secret"
        }),
        body: expect.objectContaining({
          deliveryId: expect.any(String),
          provider: "whatsapp",
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
  });

  it("delivers files as inline data without exposing gateway local paths", async () => {
    const deliveries: Array<{ body: unknown }> = [];
    const provider = new WebhookProvider({
      providerId: "slack",
      deliveryUrl: "https://bridge.example.test/gateway",
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
        path: "/srv/repos/private-app/diff.patch",
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
        path: "/srv/repos/private-app/diff.patch"
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

  it("caps bridge retry attempts and retry-after delays", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const provider = new WebhookProvider({
      deliveryUrl: "https://bridge.example.test/gateway",
      retryAttempts: 99,
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
