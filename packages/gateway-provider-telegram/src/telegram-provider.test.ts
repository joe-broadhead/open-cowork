import type { Context } from "grammy";
import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import {
  extractTelegramAttachments,
  mapTelegramCallback,
  mapTelegramMessage,
  parseTelegramCommand,
  TelegramProvider,
  telegramFileDownloadUrl,
  validateTelegramButtons,
  type TelegramBotIdentity,
  type TelegramProviderConfig
} from "@open-cowork/gateway-provider-telegram";
import type { IncomingChannelMessage } from "@open-cowork/gateway-channel";

type TelegramMessage = NonNullable<Context["message"]>;

describe("TelegramProvider attachments", () => {
  it("maps Telegram documents to channel attachments", () => {
    const attachments = extractTelegramAttachments({
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 120
      }
    } as unknown as TelegramMessage);

    expect(attachments).toEqual([
      {
        providerFileId: "doc-file-id",
        filename: "error.log",
        mimeType: "text/plain",
        sizeBytes: 120
      }
    ]);
  });

  it("maps the highest-resolution Telegram photo to a JPEG attachment", () => {
    const attachments = extractTelegramAttachments({
      photo: [
        {
          file_id: "small-photo-id",
          file_unique_id: "small-photo",
          width: 90,
          height: 90,
          file_size: 300
        },
        {
          file_id: "large-photo-id",
          file_unique_id: "large-photo",
          width: 1280,
          height: 720,
          file_size: 20_000
        }
      ]
    } as unknown as TelegramMessage);

    expect(attachments).toEqual([
      {
        providerFileId: "large-photo-id",
        filename: "large-photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 20_000
      }
    ]);
  });

  it("builds Telegram file download URLs without logging or storing token-derived payloads", () => {
    expect(telegramFileDownloadUrl(
      "123:token",
      "documents/report final.txt",
    )).toBe("https://api.telegram.org/file/bot123:token/documents/report%20final.txt");

    expect(() => telegramFileDownloadUrl(
      "123:token",
      "documents/report final.txt",
      "https://evil.example.test",
    )).toThrow("non-Telegram host");
  });

  it("downloads Telegram attachments through injectable fetch", async () => {
    const fileIds: string[] = [];
    const urls: string[] = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "polling",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(new TextEncoder().encode("payload"), { status: 200 });
      }
    });
    const internals = provider as unknown as {
      bot: {
        api: {
          getFile: (fileId: string) => Promise<{ file_path?: string }>;
        };
      };
    };
    internals.bot.api.getFile = async (fileId) => {
      fileIds.push(fileId);
      return { file_path: "documents/error.log" };
    };

    const data = await provider.downloadAttachment({
      providerFileId: "doc-file-id",
      filename: "error.log",
      mimeType: "text/plain",
      sizeBytes: 7
    });

    expect(fileIds).toEqual(["doc-file-id"]);
    expect(urls).toEqual(["https://api.telegram.org/file/bot123:token/documents/error.log"]);
    expect(new TextDecoder().decode(data)).toBe("payload");
  });

  it("refuses to send the bot token to a non-Telegram file host", async () => {
    let fetched = false;
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "polling",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      fileDownloadBaseUrl: "https://evil.example.test",
      fetch: async () => {
        fetched = true;
        return new Response(new Uint8Array(), { status: 200 });
      }
    });
    const internals = provider as unknown as {
      bot: {
        api: {
          getFile: (fileId: string) => Promise<{ file_path?: string }>;
        };
      };
    };
    internals.bot.api.getFile = async () => ({ file_path: "documents/error.log" });

    await expect(provider.downloadAttachment({
      providerFileId: "doc-file-id",
      filename: "error.log"
    })).rejects.toThrow("non-Telegram host");
    expect(fetched).toBe(false);
  });

  it("rejects inline callback data before Telegram can reject overlong payloads", () => {
    expect(() => validateTelegramButtons([
      [{ label: "Approve", token: "p:short" }]
    ])).not.toThrow();

    expect(() => validateTelegramButtons([
      [{ label: "Approve", token: "" }]
    ])).toThrow("Telegram inline button token must be 1-64 bytes; got 0");

    expect(() => validateTelegramButtons([
      [{ label: "Approve", token: "p:bad\nvalue" }]
    ])).toThrow("Telegram inline button token cannot contain control characters");

    expect(() => validateTelegramButtons([
      [{ label: "Approve", token: `p:${"a".repeat(65)}` }]
    ])).toThrow("Telegram inline button token must be 1-64 bytes");
  });

  it("validates button callback tokens before sending messages", async () => {
    const sent: unknown[] = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "polling",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false
    });
    const internals = provider as unknown as {
      bot: {
        api: {
          sendMessage: (...args: unknown[]) => Promise<{ message_id: number }>;
        };
      };
    };
    internals.bot.api.sendMessage = async (...args) => {
      sent.push(args);
      return { message_id: 123 };
    };

    await expect(provider.sendButtons(
      { provider: "telegram", chatId: "123" },
      "Choose",
      [[{ label: "Approve", token: "p:short" }]],
    )).resolves.toMatchObject({ messageId: "123" });
    await expect(provider.sendButtons(
      { provider: "telegram", chatId: "123" },
      "Choose",
      [[{ label: "Approve", token: `p:${"x".repeat(80)}` }]],
    )).rejects.toThrow("Telegram inline button token must be 1-64 bytes");
    expect(sent).toHaveLength(1);
  });
});

describe("TelegramProvider update mapping", () => {
  it("does not register duplicate handlers across stop/start cycles", async () => {
    const registeredHandlers: Array<{ event: string; handler: (ctx: Context) => Promise<void> }> = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "webhook",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      webhook: {
        publicBaseUrl: "https://gateway.example.test",
        path: "/telegram",
        secretToken: "telegram-secret"
      }
    });
    const internals = provider as unknown as {
      bot: {
        api: {
          getMe: () => Promise<{ id: number; username: string }>;
        };
        on: (event: string, handler: (ctx: Context) => Promise<void>) => void;
      };
    };
    internals.bot.api.getMe = async () => ({ id: 999, username: "GatewayBot" });
    internals.bot.on = (event, handler) => {
      registeredHandlers.push({ event, handler });
    };

    const firstSeen: IncomingChannelMessage[] = [];
    const secondSeen: IncomingChannelMessage[] = [];
    await provider.start(async (message) => {
      firstSeen.push(message);
    });
    await provider.stop();
    await provider.start(async (message) => {
      secondSeen.push(message);
    });

    expect(registeredHandlers.map((entry) => entry.event)).toEqual(["message", "callback_query:data"]);
    const messageHandler = registeredHandlers.find((entry) => entry.event === "message")?.handler;
    if (!messageHandler) {
      throw new Error("missing Telegram message handler");
    }
    await messageHandler({
      message: {
        message_id: 42,
        date: 1_700_000_000,
        text: "/status",
        from: user(123),
        chat: { id: 123, type: "private", first_name: "Alice" }
      }
    } as unknown as Context);

    expect(firstSeen).toHaveLength(0);
    expect(secondSeen).toHaveLength(1);
    await provider.stop();
  });

  it("requires Telegram webhook secret verification before handling webhook updates", async () => {
    const handled: unknown[] = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "webhook",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      webhook: {
        publicBaseUrl: "https://gateway.example.test",
        path: "/telegram",
        secretToken: "telegram-secret"
      }
    });
    const internals = provider as unknown as {
      bot: {
        handleUpdate: (update: unknown) => Promise<void>;
      };
    };
    internals.bot.handleUpdate = async (update) => {
      handled.push(update);
    };

    await expect(provider.handleWebhookUpdate({ update_id: 1 }, {})).rejects.toThrow(
      "Telegram webhook secret verification failed",
    );
    await expect(provider.handleWebhookUpdate({ update_id: 1 }, {
      headers: { "x-telegram-bot-api-secret-token": "wrong" }
    })).rejects.toThrow("Telegram webhook secret verification failed");
    await provider.handleWebhookUpdate({ update_id: 2 }, {
      headers: { "x-telegram-bot-api-secret-token": "telegram-secret" }
    });

    expect(handled).toEqual([{ update_id: 2 }]);
  });

  it("deduplicates Telegram webhook updates by update_id after authentication", async () => {
    const handled: unknown[] = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "webhook",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      webhook: {
        publicBaseUrl: "https://gateway.example.test",
        path: "/telegram",
        secretToken: "telegram-secret"
      }
    });
    const internals = provider as unknown as {
      bot: {
        handleUpdate: (update: unknown) => Promise<void>;
      };
    };
    internals.bot.handleUpdate = async (update) => {
      handled.push(update);
    };
    const auth = { headers: { "x-telegram-bot-api-secret-token": "telegram-secret" } };

    await provider.handleWebhookUpdate({ update_id: 42, message: { message_id: 1 } }, auth);
    await provider.handleWebhookUpdate({ update_id: 42, message: { message_id: 1 } }, auth);
    await provider.handleWebhookUpdate({ update_id: 43, message: { message_id: 1 } }, auth);

    expect(handled).toEqual([
      { update_id: 42, message: { message_id: 1 } },
      { update_id: 43, message: { message_id: 1 } }
    ]);
  });

  it("releases Telegram webhook update_id claims when handling fails", async () => {
    const handled: unknown[] = [];
    const provider = new TelegramProvider({
      botToken: "123:token",
      mode: "webhook",
      respondInGroups: "commands_only",
      observeUnmentionedGroupMessages: false,
      webhook: {
        publicBaseUrl: "https://gateway.example.test",
        path: "/telegram",
        secretToken: "telegram-secret"
      }
    });
    let attempts = 0;
    const internals = provider as unknown as {
      bot: {
        handleUpdate: (update: unknown) => Promise<void>;
      };
    };
    internals.bot.handleUpdate = async (update) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary handler failure");
      }
      handled.push(update);
    };
    const auth = { headers: { "x-telegram-bot-api-secret-token": "telegram-secret" } };

    await expect(provider.handleWebhookUpdate({ update_id: 99, message: { message_id: 7 } }, auth))
      .rejects.toThrow("temporary handler failure");
    await provider.handleWebhookUpdate({ update_id: 99, message: { message_id: 7 } }, auth);

    expect(handled).toEqual([{ update_id: 99, message: { message_id: 7 } }]);
  });

  it("maps private text messages to incoming channel messages", () => {
    const mapped = mapTelegramMessage({
      update: { update_id: 7001 },
      message: {
        message_id: 42,
        date: 1_700_000_000,
        text: "hello",
        from: user(123),
        chat: { id: 123, type: "private", first_name: "Alice" }
      }
    } as unknown as Context, telegramConfig(), botIdentity());

    expect(mapped).toMatchObject({
      id: "42",
      provider: "telegram",
      target: {
        provider: "telegram",
        chatId: "123",
        isDirect: true,
        threadId: null,
        userId: "123",
        messageId: "42"
      },
      sender: {
        providerUserId: "123",
        username: "alice",
        displayName: "Alice Example",
        isBot: false
      },
      text: "hello",
      rawText: "hello",
      isCommand: false,
      attachments: []
    });
    expect(mapped?.providerEventId).toBe("7001");
    expect(mapped?.receivedAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("maps forum topic group commands with distinct thread targets", () => {
    const mapped = mapTelegramMessage({
      message: {
        message_id: 77,
        message_thread_id: 456,
        date: 1_700_000_000,
        text: "/bind my-app",
        from: user(123),
        chat: { id: -100111222333, type: "supergroup", title: "Engineering" }
      }
    } as unknown as Context, telegramConfig(), botIdentity());

    expect(mapped).toMatchObject({
      target: {
        chatId: "-100111222333",
        threadId: "456",
        userId: "123",
        messageId: "77"
      },
      isCommand: true,
      command: "bind",
      commandArgs: "my-app"
    });
  });

  it("ignores unmentioned group messages when configured for mentions and replies", () => {
    const mapped = mapTelegramMessage({
      message: {
        message_id: 7,
        date: 1_700_000_000,
        text: "plain group chatter",
        from: user(123),
        chat: { id: -100111222333, type: "supergroup", title: "Engineering" }
      }
    } as unknown as Context, telegramConfig(), botIdentity());

    expect(mapped).toBeNull();
  });

  it("ignores bot-authored messages before they reach gateway auth", () => {
    const mapped = mapTelegramMessage({
      message: {
        message_id: 9,
        date: 1_700_000_000,
        text: "/status",
        from: botUser(321),
        chat: { id: 321, type: "private", first_name: "BuildBot" }
      }
    } as unknown as Context, telegramConfig(), botIdentity());

    expect(mapped).toBeNull();
  });

  it("accepts replies to the bot in groups", () => {
    const mapped = mapTelegramMessage({
      message: {
        message_id: 8,
        date: 1_700_000_000,
        text: "continue this",
        from: user(123),
        chat: { id: -100111222333, type: "supergroup", title: "Engineering" },
        reply_to_message: {
          message_id: 6,
          date: 1_700_000_000,
          from: { id: 999, is_bot: true, first_name: "Gateway" },
          chat: { id: -100111222333, type: "supergroup", title: "Engineering" }
        }
      }
    } as unknown as Context, telegramConfig(), botIdentity());

    expect(mapped).toMatchObject({
      text: "continue this",
      isCommand: false,
      target: { chatId: "-100111222333" }
    });
  });

  it("maps callback button data to channel interactions", () => {
    const mapped = mapTelegramCallback({
      update: { update_id: 8001 },
      callbackQuery: {
        id: "callback-id",
        data: "p:abc123",
        from: user(123),
        message: {
          message_id: 90,
          message_thread_id: 456,
          date: 1_700_000_000,
          chat: { id: -100111222333, type: "supergroup", title: "Engineering" }
        }
      }
    } as unknown as Context);

    expect(mapped).toMatchObject({
      id: "callback-id",
      text: "p:abc123",
      target: {
        chatId: "-100111222333",
        threadId: "456",
        userId: "123",
        messageId: "90"
      },
      interaction: {
        id: "callback-id",
        token: "p:abc123",
        kind: "button"
      }
    });
    expect(mapped?.providerEventId).toBe("8001");
  });

  it("ignores bot-authored callback interactions before they reach gateway auth", () => {
    const mapped = mapTelegramCallback({
      callbackQuery: {
        id: "callback-id",
        data: "p:abc123",
        from: botUser(321),
        message: {
          message_id: 90,
          date: 1_700_000_000,
          chat: { id: 321, type: "private", first_name: "BuildBot" }
        }
      }
    } as unknown as Context);

    expect(mapped).toBeNull();
  });

  it("parses bot-addressed commands and rejects commands for another bot", () => {
    expect(parseTelegramCommand("/status@GatewayBot now", "gatewaybot")).toEqual({
      command: "status",
      args: "now"
    });
    expect(parseTelegramCommand("/status@OtherBot now", "gatewaybot")).toBeNull();
  });
});

function telegramConfig(): TelegramProviderConfig {
  return {
    botToken: "123:token",
    mode: "polling",
    respondInGroups: "mentions_and_replies",
    observeUnmentionedGroupMessages: false
  };
}

function botIdentity(): TelegramBotIdentity {
  return {
    id: 999,
    username: "GatewayBot"
  };
}

function user(id: number): {
  id: number;
  is_bot: false;
  first_name: string;
  last_name: string;
  username: string;
} {
  return {
    id,
    is_bot: false,
    first_name: "Alice",
    last_name: "Example",
    username: "alice"
  };
}

function botUser(id: number): {
  id: number;
  is_bot: true;
  first_name: string;
  username: string;
} {
  return {
    id,
    is_bot: true,
    first_name: "BuildBot",
    username: "buildbot"
  };
}
