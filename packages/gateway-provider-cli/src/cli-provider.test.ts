import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CliProvider, mapCliPayload } from "@open-cowork/gateway-provider-cli";

describe("CLI provider", () => {
  it("maps plain text and JSONL payloads into channel messages", () => {
    const textMessage = mapCliPayload("hello", new Date("2026-05-30T00:00:00.000Z"));
    assert.equal(textMessage.provider, "cli");
    assert.equal(textMessage.text, "hello");
    assert.equal(textMessage.target.chatId, "local-cli");

    const command = mapCliPayload({
      id: "msg-1",
      chatId: "terminal-1",
      userId: "operator",
      text: "/approve token-1",
      interaction: { id: "interaction-1", token: "token-1" }
    });
    assert.equal(command.isCommand, true);
    assert.equal(command.command, "approve");
    assert.equal(command.commandArgs, "token-1");
    assert.equal(command.interaction?.kind, "command");
  });

  it("writes outbound messages as JSONL and rejects non-CLI targets", async () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const provider = new CliProvider({ input: new PassThrough(), output, now: () => new Date("2026-05-30T00:00:00.000Z") });

    const sent = await provider.sendText({ provider: "cli", chatId: "terminal-1" }, "done");
    assert.equal(sent.provider, "cli");
    assert.match(chunks.join(""), /"type":"text"/);
    assert.match(chunks.join(""), /"text":"done"/);

    await assert.rejects(
      provider.sendText({ provider: "slack", chatId: "C123" }, "bad"),
      /cannot deliver target/,
    );
  });

  it("reads stdin-style lines without exposing an unauthenticated public webhook", async () => {
    const input = new PassThrough();
    const provider = new CliProvider({ input, output: new PassThrough() });
    const messages: string[] = [];
    await provider.start(async (message) => {
      messages.push(message.text);
    });
    input.write("hello from cli\n");
    input.write("{\"text\":\"/status\",\"chatId\":\"terminal-2\"}\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await provider.stop();
    assert.deepEqual(messages, ["hello from cli", "/status"]);
  });
});
