import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { signWebhookIngressPayload } from "@open-cowork/gateway-provider-webhook";
import { WhatsAppProvider } from "@open-cowork/gateway-provider-whatsapp";

describe("WhatsAppProvider", () => {
  it("maps signed bridge ingress and fails closed without signatures", async () => {
    const provider = new WhatsAppProvider({
      deliveryUrl: "https://bridge.example.test/whatsapp",
      sharedSecret: "secret",
      now: () => new Date("2026-05-30T12:00:00.000Z")
    });
    const messages: unknown[] = [];
    await provider.start(async (message) => {
      messages.push(message);
    });
    const payload = {
      target: { chatId: "+15551234567@s.whatsapp.net", userId: "+15551234567@s.whatsapp.net" },
      sender: { userId: "+15551234567@s.whatsapp.net" },
      text: "approve"
    };

    await expect(provider.handleWebhookPayload(payload, {})).rejects.toThrow("signature");
    await provider.handleWebhookPayload(payload, signedAuth(payload));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      provider: "whatsapp",
      target: {
        provider: "whatsapp",
        chatId: "+15551234567@s.whatsapp.net",
        userId: "+15551234567@s.whatsapp.net"
      }
    });
  });
});

function signedAuth(payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const timestamp = "1780142400";
  return {
    rawBody,
    headers: {
      "x-open-cowork-gateway-webhook-timestamp": timestamp,
      "x-open-cowork-gateway-webhook-signature": signWebhookIngressPayload(rawBody, "secret", timestamp)
    }
  };
}
