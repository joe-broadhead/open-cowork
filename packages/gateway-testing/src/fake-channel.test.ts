import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { FakeChannelProvider } from "@open-cowork/gateway-testing";

describe("FakeChannelProvider", () => {
  it("records sent text, files, and buttons for gateway e2e tests", async () => {
    const provider = new FakeChannelProvider();
    const target = {
      provider: "cli" as const,
      chatId: "local-test",
      threadId: "thread-1"
    };

    await expect(provider.sendText(target, "hello")).resolves.toMatchObject({
      provider: "cli",
      chatId: "local-test",
      threadId: "thread-1",
      messageId: "1"
    });
    await provider.sendButtons(target, "approve?", [[{ label: "Approve", token: "p:abc123" }]]);
    await provider.answerInteraction("callback-1", "Approved");
    await provider.sendFile(target, { filename: "result.txt", data: new TextEncoder().encode("ok") });

    expect(provider.sent).toHaveLength(3);
    expect(provider.sent[1]).toMatchObject({
      text: "approve?",
      buttons: [[{ label: "Approve", token: "p:abc123" }]]
    });
    expect(provider.sent[2]).toMatchObject({
      file: { filename: "result.txt" }
    });
    expect(provider.answered).toEqual([{ interactionId: "callback-1", text: "Approved", alert: undefined }]);
  });

  it("dispatches emitted messages only while started", async () => {
    const provider = new FakeChannelProvider();
    const seen: string[] = [];
    const message = {
      id: "msg-1",
      provider: "cli" as const,
      target: { provider: "cli" as const, chatId: "local-test" },
      sender: { providerUserId: "user-1" },
      text: "hello",
      rawText: "hello",
      isCommand: false,
      attachments: [],
      receivedAt: new Date("2026-05-27T12:00:00.000Z"),
      raw: {}
    };

    await expect(provider.emit(message)).rejects.toThrow("Fake channel provider is not started");
    await provider.start(async (incoming) => {
      seen.push(incoming.text);
    });
    await provider.emit(message);
    await provider.stop();

    expect(seen).toEqual(["hello"]);
  });
});
