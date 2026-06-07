import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { signWebhookDeliveryPayload } from "@open-cowork/gateway-provider-webhook";
import { DiscordProvider } from "@open-cowork/gateway-provider-discord";

describe("DiscordProvider", () => {
  async function resolvePublicBridgeHostname() {
    return [{ address: "93.184.216.34", family: 4 }];
  }

  it("declares Discord bridge capabilities", () => {
    const provider = new DiscordProvider({
      deliveryUrl: "https://bridge.example.test/discord",
      sharedSecret: "secret"
    });

    expect(provider.id).toBe("discord");
    expect(provider.capabilities).toMatchObject({
      threads: true,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 2000,
      preferredParseMode: "markdown",
      maxButtonsPerMessage: 25,
      supportsEphemeralResponses: true
    });
  });

  it("requires a bridge shared secret at construction", () => {
    expect(() => new DiscordProvider({
      deliveryUrl: "https://bridge.example.test/discord",
      sharedSecret: " "
    })).toThrow("sharedSecret is required");
  });

  it("delivers outbound messages through the signed bridge contract", async () => {
    const deliveries: Array<{ headers: Record<string, string>, rawBody: string, body: unknown }> = [];
    const provider = new DiscordProvider({
      deliveryUrl: "https://bridge.example.test/discord",
      sharedSecret: "secret",
      resolveDeliveryHostname: resolvePublicBridgeHostname,
      fetch: async (_input, init) => {
        const rawBody = String(init?.body);
        deliveries.push({
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          rawBody,
          body: JSON.parse(rawBody)
        });
        return new Response(JSON.stringify({ messageId: "discord-message-id" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(provider.sendButtons(
      { provider: "discord", chatId: "channel-1", threadId: "thread-1" },
      "Approve?",
      [[{ label: "Approve", token: "p:token" }]],
    )).resolves.toMatchObject({
      provider: "discord",
      chatId: "channel-1",
      threadId: "thread-1",
      messageId: "discord-message-id"
    });

    expect(deliveries).toEqual([
      {
        headers: expect.objectContaining({
          "x-open-cowork-gateway-webhook-signature": expect.any(String),
          "x-open-cowork-gateway-webhook-timestamp": expect.any(String)
        }),
        body: expect.objectContaining({
          provider: "discord",
          type: "buttons",
          target: expect.objectContaining({
            provider: "discord",
            chatId: "channel-1",
            threadId: "thread-1"
          })
        })
      }
    ]);
    expect(deliveries[0]?.headers["x-open-cowork-gateway-webhook-secret"]).toBe(undefined);
    expect(deliveries[0]?.headers["x-open-cowork-gateway-webhook-signature"]).toBe(
      signWebhookDeliveryPayload(
        deliveries[0]?.rawBody || "",
        "secret",
        deliveries[0]?.headers["x-open-cowork-gateway-webhook-timestamp"] || "",
      ),
    );
  });
});
