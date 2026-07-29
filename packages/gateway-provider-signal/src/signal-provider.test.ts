import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { SignalProvider } from "@open-cowork/gateway-provider-signal";

describe("SignalProvider", () => {
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
