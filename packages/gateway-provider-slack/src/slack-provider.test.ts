import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { SlackProvider } from "@open-cowork/gateway-provider-slack";
import type { IncomingChannelMessage } from "@open-cowork/gateway-channel";

const signingSecret = "slack-signing-secret";
const fixedNow = new Date("2026-05-29T12:00:00.000Z");

describe("SlackProvider", () => {
  it("verifies Slack signatures and maps message events to channel messages", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        user: "U123",
        channel: "C123",
        text: "/status now",
        ts: "1716984000.000100",
        thread_ts: "1716983000.000100",
        client_msg_id: "client-1",
        user_profile: {
          real_name: "Alice Example",
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    await provider.handleWebhookPayload(payload, {
      headers: signedHeaders(rawBody),
      rawBody,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "client-1",
      provider: "slack",
      target: {
        provider: "slack",
        chatId: "C123",
        threadId: "1716983000.000100",
        userId: "U123",
        messageId: "1716984000.000100",
      },
      sender: {
        providerUserId: "U123",
        displayName: "Alice Example",
      },
      text: "/status now",
      isCommand: true,
      command: "status",
      commandArgs: "now",
    });
  });

  it("rejects unsigned Slack ingress", async () => {
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
    });

    await expect(provider.handleWebhookPayload({ type: "url_verification", challenge: "ok" }, {})).rejects.toThrow("signature");
  });

  it("rejects replayed Slack signatures inside the timestamp window", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        user: "U123",
        channel: "C123",
        text: "hello",
        ts: "1716984000.000100",
      },
    };
    const rawBody = JSON.stringify(payload);
    const headers = signedHeaders(rawBody);

    await provider.handleWebhookPayload(payload, { headers, rawBody });
    await expect(provider.handleWebhookPayload(payload, { headers, rawBody })).rejects.toThrow("replay");

    expect(messages).toHaveLength(1);
  });

  it("maps Slack button actions to provider-neutral interactions", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const payload = {
      type: "block_actions",
      trigger_id: "trigger-1",
      user: { id: "U123", username: "alice", name: "Alice" },
      channel: { id: "C123" },
      message: { ts: "1716984000.000100", thread_ts: "1716983000.000100" },
      actions: [{ action_ts: "1716984001.000100", value: "p:token-1" }],
    };
    const rawBody = JSON.stringify(payload);

    await provider.handleWebhookPayload(payload, {
      headers: signedHeaders(rawBody),
      rawBody,
    });

    expect(messages[0]).toMatchObject({
      provider: "slack",
      target: {
        chatId: "C123",
        threadId: "1716983000.000100",
        userId: "U123",
      },
      interaction: {
        id: "1716984001.000100",
        token: "p:token-1",
        kind: "button",
      },
    });
  });

  it("uses Slack chat and file APIs for outbound messages", async () => {
    const calls: Array<{ url: string, body: unknown }> = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body });
        return new Response(JSON.stringify({ ok: true, ts: "1716984000.000100" }), { status: 200 });
      },
    });

    const sent = await provider.sendText({ provider: "slack", chatId: "C123", threadId: "1716983000.000100" }, "hello");
    await provider.editText({ provider: "slack", chatId: "C123" }, sent.messageId, "updated");
    await provider.sendButtons({ provider: "slack", chatId: "C123" }, "Approve?", [[{ label: "Allow", token: "p:allow", style: "success" }]]);
    await provider.sendFile({ provider: "slack", chatId: "C123" }, {
      filename: "report.txt",
      mimeType: "text/plain",
      data: new TextEncoder().encode("report"),
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.update",
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/files.uploadV2",
    ]);
  });
});

function signedHeaders(rawBody: string) {
  const timestamp = Math.floor(fixedNow.getTime() / 1000).toString();
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
  };
}
