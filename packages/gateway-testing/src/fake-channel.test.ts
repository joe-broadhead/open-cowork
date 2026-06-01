import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { runChannelProviderConformance } from "@open-cowork/gateway-channel";
import {
  createButtonCapableFakeProvider,
  createButtonlessFakeProvider,
  createConstrainedMessageFakeProvider,
  createFileCapableFakeProvider,
  FakeChannelProvider
} from "@open-cowork/gateway-testing";

describe("FakeChannelProvider", () => {
  it("passes the provider conformance suite with an instance-aware id", async () => {
    const provider = new FakeChannelProvider({ id: "cli-main" });
    const target = {
      provider: "cli-main" as const,
      providerKind: "cli" as const,
      chatId: "local-test",
      threadId: "thread-1",
      messageId: "1"
    };

    const report = await runChannelProviderConformance({
      provider,
      target,
      downloadableAttachment: {
        filename: "input.txt",
        buffer: new TextEncoder().encode("input")
      },
      inbound: [{
        name: "text",
        emit: () => provider.emit({
          id: "msg-1",
          providerInstanceId: "cli-main",
          providerEventId: "event-1",
          providerMessageId: "msg-1",
          provider: "cli-main",
          providerKind: "cli",
          target,
          sender: { providerUserId: "user-1" },
          text: "/approve ok",
          rawText: "/approve ok",
          isCommand: true,
          command: "approve",
          commandArgs: "ok",
          attachments: [],
          receivedAt: new Date("2026-05-27T12:00:00.000Z"),
          raw: {}
        }),
        expected: {
          text: "/approve ok",
          command: "approve",
          chatId: "local-test",
          threadId: "thread-1"
        }
      }]
    });

    expect(report).toMatchObject({ passed: true, providerId: "cli-main", providerKind: "cli" });
    expect(report.violations).toEqual([]);
  });

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

  it("provides realistic fake provider capability presets", async () => {
    const buttonCapable = createButtonCapableFakeProvider();
    expect(buttonCapable.capabilities.inlineButtons).toBe(true);
    expect(buttonCapable.capabilities.messageEditing).toBe(true);
    await buttonCapable.setTyping({ provider: "cli", chatId: "chat-1" });
    expect(buttonCapable.typing).toHaveLength(1);

    const buttonless = createButtonlessFakeProvider();
    expect(buttonless.capabilities.inlineButtons).toBe(false);
    await expect(
      buttonless.sendButtons({ provider: "cli", chatId: "chat-1" }, "approve?", [[{ label: "Approve", token: "token" }]]),
    ).rejects.toThrow("does not support inline buttons");

    const fileCapable = createFileCapableFakeProvider();
    await expect(
      fileCapable.sendFile({ provider: "cli", chatId: "chat-1" }, { filename: "artifact.txt", data: new Uint8Array() }),
    ).resolves.toMatchObject({ messageId: "1" });

    const constrained = createConstrainedMessageFakeProvider();
    expect(constrained.capabilities.maxTextLength).toBe(128);
    await expect(constrained.sendText({ provider: "cli", chatId: "chat-1" }, "x".repeat(129))).rejects.toThrow(
      "maxTextLength 128",
    );
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
