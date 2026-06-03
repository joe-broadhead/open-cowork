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

  it("releases replay claims when message handler dispatch fails", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
    });
    let attempts = 0;
    await provider.start(async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("store offline");
      messages.push(message);
    });
    const payload = slackMessagePayload("T123", "C123", "1716984000.000200", "hello");
    const rawBody = JSON.stringify(payload);
    const headers = signedHeaders(rawBody);

    await expect(provider.handleWebhookPayload(payload, { headers, rawBody })).rejects.toThrow("store offline");
    await provider.handleWebhookPayload(payload, { headers, rawBody });
    await expect(provider.handleWebhookPayload(payload, { headers, rawBody })).rejects.toThrow("replay");

    expect(attempts).toBe(2);
    expect(messages).toHaveLength(1);
  });

  it("does not release newer replay claims from older handler failures", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
      maxSeenWebhookSignatures: 1,
    });
    let firstAttempts = 0;
    let failOriginalFirst: (error: Error) => void = () => {};
    await provider.start(async (message) => {
      if (message.text === "first") {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          await new Promise<void>((_, reject) => {
            failOriginalFirst = reject;
          });
          return;
        }
      }
      messages.push(message);
    });
    const firstPayload = slackMessagePayload("T123", "C123", "1716984000.000200", "first");
    const secondPayload = slackMessagePayload("T123", "C123", "1716984000.000201", "second");
    const firstRawBody = JSON.stringify(firstPayload);
    const firstHeaders = signedHeaders(firstRawBody);

    const originalFirst = provider.handleWebhookPayload(firstPayload, { headers: firstHeaders, rawBody: firstRawBody });
    await new Promise((resolve) => setImmediate(resolve));

    const secondRawBody = JSON.stringify(secondPayload);
    await provider.handleWebhookPayload(secondPayload, { headers: signedHeaders(secondRawBody), rawBody: secondRawBody });
    await provider.handleWebhookPayload(firstPayload, { headers: firstHeaders, rawBody: firstRawBody });
    failOriginalFirst(new Error("store offline"));
    await expect(originalFirst).rejects.toThrow("store offline");
    await expect(provider.handleWebhookPayload(firstPayload, { headers: firstHeaders, rawBody: firstRawBody })).rejects.toThrow("replay");

    expect(messages.map((message) => message.text)).toEqual(["second", "first"]);
  });

  it("keeps replay eviction scoped by Slack team", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
      maxSeenWebhookSignatures: 10,
      maxSeenWebhookSignaturesPerScope: 2,
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const preservedPayload = slackMessagePayload("T-B", "C-B", "1716984000.000100", "team b");
    const preservedRawBody = JSON.stringify(preservedPayload);
    const preservedHeaders = signedHeaders(preservedRawBody);

    await provider.handleWebhookPayload(preservedPayload, {
      headers: preservedHeaders,
      rawBody: preservedRawBody,
    });

    let newestFloodPayload: ReturnType<typeof slackMessagePayload> | null = null;
    let newestFloodRawBody: string | null = null;
    let newestFloodHeaders: ReturnType<typeof signedHeaders> | null = null;
    for (let index = 0; index < 3; index += 1) {
      const payload = slackMessagePayload("T-A", "C-A", `171698400${index}.000100`, `team a ${index}`);
      const rawBody = JSON.stringify(payload);
      const headers = signedHeaders(rawBody);
      await provider.handleWebhookPayload(payload, {
        headers,
        rawBody,
      });
      newestFloodPayload = payload;
      newestFloodRawBody = rawBody;
      newestFloodHeaders = headers;
    }

    if (!newestFloodPayload || !newestFloodRawBody || !newestFloodHeaders) throw new Error("missing newest flood request");
    await expect(provider.handleWebhookPayload(newestFloodPayload, {
      headers: newestFloodHeaders,
      rawBody: newestFloodRawBody,
    })).rejects.toThrow("replay");
    await expect(provider.handleWebhookPayload(preservedPayload, {
      headers: preservedHeaders,
      rawBody: preservedRawBody,
    })).rejects.toThrow("replay");
    expect(messages).toHaveLength(4);
  });

  it("keeps form-encoded Slack interaction replay eviction scoped by team", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new SlackProvider({
      botToken: "xoxb-test",
      signingSecret,
      now: () => fixedNow,
      maxSeenWebhookSignatures: 10,
      maxSeenWebhookSignaturesPerScope: 2,
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const preservedPayload = slackInteractionPayload("T-B", "C-B", "trigger-b", "1716984001.000100");
    const preservedRawBody = slackFormBody(preservedPayload);
    const preservedHeaders = signedHeaders(preservedRawBody);

    await provider.handleWebhookPayload(preservedPayload, {
      headers: preservedHeaders,
      rawBody: preservedRawBody,
    });

    let newestFloodPayload: ReturnType<typeof slackInteractionPayload> | null = null;
    let newestFloodRawBody: string | null = null;
    let newestFloodHeaders: ReturnType<typeof signedHeaders> | null = null;
    for (let index = 0; index < 3; index += 1) {
      const payload = slackInteractionPayload("T-A", "C-A", `trigger-a-${index}`, `171698400${index}.000100`);
      const rawBody = slackFormBody(payload);
      const headers = signedHeaders(rawBody);
      await provider.handleWebhookPayload(payload, {
        headers,
        rawBody,
      });
      newestFloodPayload = payload;
      newestFloodRawBody = rawBody;
      newestFloodHeaders = headers;
    }

    if (!newestFloodPayload || !newestFloodRawBody || !newestFloodHeaders) throw new Error("missing newest flood request");
    await expect(provider.handleWebhookPayload(newestFloodPayload, {
      headers: newestFloodHeaders,
      rawBody: newestFloodRawBody,
    })).rejects.toThrow("replay");
    await expect(provider.handleWebhookPayload(preservedPayload, {
      headers: preservedHeaders,
      rawBody: preservedRawBody,
    })).rejects.toThrow("replay");
    expect(messages).toHaveLength(4);
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

function slackMessagePayload(teamId: string, channel: string, ts: string, text: string) {
  return {
    type: "event_callback",
    team_id: teamId,
    event: {
      type: "message",
      user: "U123",
      channel,
      text,
      ts,
    },
  };
}

function slackInteractionPayload(teamId: string, channel: string, triggerId: string, actionTs: string) {
  return {
    type: "block_actions",
    trigger_id: triggerId,
    team: { id: teamId },
    user: { id: "U123", username: "alice", name: "Alice" },
    channel: { id: channel },
    message: { ts: "1716984000.000100" },
    actions: [{ action_ts: actionTs, value: "p:token-1" }],
  };
}

function slackFormBody(payload: unknown) {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function signedHeaders(rawBody: string) {
  const timestamp = Math.floor(fixedNow.getTime() / 1000).toString();
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
  };
}
