import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { SignalProvider } from "@open-cowork/gateway-provider-signal";

describe("SignalProvider", () => {
  it("declares Signal bridge capabilities with button fallback semantics", () => {
    const provider = new SignalProvider({
      deliveryUrl: "https://bridge.example.test/signal",
      sharedSecret: "secret"
    });

    expect(provider.id).toBe("signal");
    expect(provider.capabilities).toMatchObject({
      threads: false,
      messageEditing: false,
      inlineButtons: false,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 4096,
      preferredParseMode: "plain"
    });
  });

  it("requires a bridge shared secret at construction", () => {
    expect(() => new SignalProvider({
      deliveryUrl: "https://bridge.example.test/signal",
      sharedSecret: " "
    })).toThrow("sharedSecret is required");
  });

  it("rejects oversized bridge button rows according to provider capabilities", async () => {
    const provider = new SignalProvider({
      deliveryUrl: "https://bridge.example.test/signal",
      sharedSecret: "secret"
    });

    await expect(provider.sendButtons(
      { provider: "signal", chatId: "group-1" },
      "Approve?",
      [[{ label: "Approve", token: "p:token" }]],
    )).rejects.toThrow("does not support inline buttons");
  });
});
