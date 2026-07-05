import { describe, it } from "node:test";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { EmailProvider, SmtpEmailTransport, type EmailMessage, type EmailTransport } from "@open-cowork/gateway-provider-email";
import type { IncomingChannelMessage } from "@open-cowork/gateway-channel";

describe("EmailProvider", () => {
  it("authenticates inbound webhooks and maps threaded mail to channel messages", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(),
      now: () => new Date("2026-05-29T12:00:00.000Z"),
    });
    await provider.start(async (message) => {
      messages.push(message);
    });

    await provider.handleWebhookPayload({
      messageId: "<m2@example.test>",
      from: { email: "alice@example.test", name: "Alice" },
      subject: "Re: Status",
      text: "/status now",
      inReplyTo: "<m1@example.test>",
      references: "<root@example.test> <m1@example.test>",
      attachments: [{
        filename: "error.log",
        mimeType: "text/plain",
        contentBase64: Buffer.from("payload").toString("base64"),
      }],
    }, {
      headers: { "x-open-cowork-gateway-email-secret": "inbound-secret" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "<m2@example.test>",
      provider: "email",
      target: {
        provider: "email",
        chatId: "alice@example.test",
        threadId: "<m1@example.test>",
        userId: "alice@example.test",
      },
      sender: {
        providerUserId: "alice@example.test",
        displayName: "Alice",
      },
      text: "/status now",
      isCommand: true,
      command: "status",
      commandArgs: "now",
    });
    expect(new TextDecoder().decode(messages[0]!.attachments[0]!.buffer)).toBe("payload");
  });

  it("rejects inbound mail without the shared secret", async () => {
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(),
    });
    await provider.start(async () => {});

    await expect(provider.handleWebhookPayload({
      from: "alice@example.test",
      text: "hello",
    }, {
      headers: { "x-open-cowork-gateway-email-secret": "wrong" },
    })).rejects.toThrow("shared secret");
  });

  it("rejects replayed inbound message ids", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(),
      now: () => new Date("2026-05-29T12:00:00.000Z"),
    });
    await provider.start(async (message) => {
      messages.push(message);
    });
    const payload = {
      messageId: "<m-replay@example.test>",
      from: "alice@example.test",
      text: "hello",
    };
    const auth = { headers: { "x-open-cowork-gateway-email-secret": "inbound-secret" } };

    await provider.handleWebhookPayload(payload, auth);
    await expect(provider.handleWebhookPayload(payload, auth)).rejects.toThrow("replay");

    expect(messages).toHaveLength(1);
  });

  it("parses formatted sender addresses with bounded deterministic parsing", async () => {
    const messages: IncomingChannelMessage[] = [];
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(),
    });
    await provider.start(async (message) => {
      messages.push(message);
    });

    await provider.handleWebhookPayload({
      messageId: "<formatted-sender@example.test>",
      from: `"Alice Example" <ALICE+ops@example.test> ${"%".repeat(2048)}`,
      text: "hello",
    }, {
      sharedSecret: "inbound-secret",
    });

    expect(messages[0]?.target.chatId).toBe("alice+ops@example.test");
    expect(messages[0]?.sender.displayName).toBe("Alice Example");
  });

  it("rejects inbound mail without a stable replay key", async () => {
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(),
    });
    await provider.start(async () => {});

    await expect(provider.handleWebhookPayload({
      from: "alice@example.test",
      text: "hello",
    }, {
      sharedSecret: "inbound-secret",
    })).rejects.toThrow("messageId or id is required");
  });

  it("sends threaded outbound email and keeps approvals on token fallback", async () => {
    const sent: EmailMessage[] = [];
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      transport: fakeTransport(sent),
    });

    const message = await provider.sendText({
      provider: "email",
      chatId: "alice@example.test",
      threadId: "<m1@example.test>",
    }, "Use /approve p:token to continue.");

    expect(message.provider).toBe("email");
    expect(sent[0]).toMatchObject({
      from: "agent@example.test",
      to: "alice@example.test",
      subject: "Open Cowork update",
      inReplyTo: "<m1@example.test>",
      references: ["<m1@example.test>"],
      text: "Use /approve p:token to continue.",
    });
    await expect(provider.sendButtons({ provider: "email", chatId: "alice@example.test" }, "Approve?", [[{
      label: "Approve",
      token: "p:token",
    }]])).rejects.toThrow("inline buttons");
  });

  it("uses a configured outbound subject when provided (downstream rebranding)", async () => {
    const sent: EmailMessage[] = [];
    const provider = new EmailProvider({
      from: "agent@example.test",
      inboundSecret: "inbound-secret",
      subject: "Northwind Assistant",
      transport: fakeTransport(sent),
    });

    await provider.sendText({ provider: "email", chatId: "alice@example.test" }, "hello");

    expect(sent[0]?.subject).toBe("Northwind Assistant");
  });
});

describe("SmtpEmailTransport CRLF injection guard", () => {
  it("rejects a from/to value containing CR or LF before it reaches the socket", async () => {
    const received: string[] = [];
    const server = createServer((socket: Socket) => {
      let buffer = "";
      socket.write("220 test-smtp ready\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          received.push(line);
          if (line.startsWith("EHLO")) socket.write("250 OK\r\n");
          index = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const transport = new SmtpEmailTransport({ host: "127.0.0.1", port, timeoutMs: 2000 });
      await expect(transport.send({
        from: "agent@example.test\r\nRCPT TO:<victim@example.test>",
        to: "alice@example.test",
        subject: "hi",
        text: "hello",
        messageId: "<inject@example.test>",
      })).rejects.toThrow("must not contain CR or LF");
      // The tainted MAIL FROM line must never have been written to the socket.
      expect(received.some((line) => line.includes("victim@example.test"))).toBe(false);
      expect(received.some((line) => line.startsWith("MAIL FROM"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function fakeTransport(sent: EmailMessage[] = []): EmailTransport {
  return {
    async send(message) {
      sent.push(message);
      return { messageId: message.messageId };
    },
  };
}
