import type {
  ChannelAttachment,
  ChannelButton,
  ChannelCapabilities,
  ChannelProviderId,
  ChannelProviderKind,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  OutgoingFile,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";
import { constantTimeStringEqual, normalizeChannelCapabilities, normalizeChannelProviderIdentity, WebhookAuthError } from "@open-cowork/gateway-channel";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Update } from "grammy/types";
import { withTelegramRetry, type TelegramRateLimitEvent } from "./telegram-retry.js";

const MAX_TELEGRAM_WEBHOOK_DEDUPE_KEYS = 10_000;
const TELEGRAM_FILE_DOWNLOAD_HOST = "api.telegram.org";

export interface TelegramProviderConfig {
  providerId?: ChannelProviderId;
  botToken: string;
  mode: "polling" | "webhook";
  fetch?: typeof globalThis.fetch;
  fileDownloadBaseUrl?: string;
  webhook?: {
    publicBaseUrl: string;
    path: string;
    secretToken: string;
  };
  onRateLimit?: (event: TelegramRateLimitEvent) => void | Promise<void>;
  respondInGroups: "commands_only" | "mentions_and_replies" | "all";
  observeUnmentionedGroupMessages: boolean;
}

export interface TelegramBotIdentity {
  id: number;
  username?: string;
}

export interface TelegramWebhookAuth {
  headers?: Headers | Record<string, string | string[] | undefined>;
  secretToken?: string | null;
  verified?: boolean;
}

export class TelegramProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind = "telegram";
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  private readonly baseCapabilities: ChannelCapabilities = {
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: true,
    maxTextLength: 4096,
    preferredParseMode: "plain",
    parseModes: ["plain"],
    maxButtonsPerMessage: 8,
    maxButtonRowsPerMessage: 4,
    maxButtonTokenBytes: 64,
    maxFileBytes: 20 * 1024 * 1024,
    inboundFileModes: ["provider_file_id"],
    outboundFileModes: ["local_path", "inline_buffer"],
    editSemantics: "message",
    interactionAcknowledgement: "required",
    rateLimitStrategy: "retry_after",
    supportsEphemeralResponses: true
  };

  private readonly bot: Bot;
  private polling?: Promise<void>;
  private started = false;
  private pollingError: string | null = null;
  private handlersRegistered = false;
  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private identity?: TelegramBotIdentity;
  private readonly seenWebhookUpdateIds = new Set<string>();
  private readonly seenWebhookUpdateOrder: string[] = [];

  constructor(private readonly config: TelegramProviderConfig) {
    if (!config.botToken.trim()) throw new Error("Telegram bot token is required.");
    // Match the other providers: reject an empty webhook secret at construction rather
    // than only failing closed at request time (a blank secret would be sent to setWebhook).
    if (config.mode === "webhook" && !config.webhook?.secretToken?.trim()) {
      throw new Error("Telegram webhook secret token is required.");
    }
    this.id = normalizeChannelProviderIdentity(this.kind, config.providerId).providerId;
    this.capabilities = normalizeChannelCapabilities(this.baseCapabilities);
    this.bot = new Bot(config.botToken);
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    if (this.started) {
      return;
    }
    this.handler = handler;
    const me = await this.retry(() => this.bot.api.getMe());
    this.identity = {
      id: me.id,
      username: me.username
    };

    if (!this.handlersRegistered) {
      this.bot.on("message", async (ctx) => {
        if (!this.handler || !this.identity) {
          return;
        }
        const message = mapTelegramMessage(ctx, this.config, this.identity, this.id);
        if (message) {
          await this.handler(message);
        }
      });

      this.bot.on("callback_query:data", async (ctx) => {
        if (!this.handler) {
          return;
        }
        const message = mapTelegramCallback(ctx, this.id);
        if (message) {
          await this.handler(message);
        }
      });
      this.handlersRegistered = true;
    }

    this.started = true;

    if (this.config.mode === "polling") {
      this.pollingError = null;
      this.polling = this.bot.start().catch((error: unknown) => {
        this.pollingError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    if (this.polling) {
      await this.bot.stop();
      await this.polling;
      this.polling = undefined;
    }
    this.started = false;
    this.pollingError = null;
  }

  health(): { ok: boolean; error?: string | null } {
    return {
      ok: this.started && !this.pollingError,
      error: this.pollingError
    };
  }

  async configureWebhook(): Promise<void> {
    if (this.config.mode !== "webhook") {
      return;
    }
    if (!this.config.webhook) {
      throw new Error("Telegram webhook mode requires webhook configuration");
    }
    const webhook = this.config.webhook;
    await this.retry(() => this.bot.api.setWebhook(webhookUrl(webhook.publicBaseUrl, webhook.path), {
      secret_token: webhook.secretToken,
      allowed_updates: ["message", "callback_query"]
    }));
  }

  async handleWebhookUpdate(update: unknown, auth: TelegramWebhookAuth): Promise<void> {
    this.assertWebhookAuthorized(auth);
    const updateId = telegramUpdateId(update);
    if (updateId && !this.claimWebhookUpdate(updateId)) {
      return;
    }
    try {
      await this.bot.handleUpdate(update as Update);
    } catch (error) {
      if (updateId) this.releaseWebhookUpdate(updateId);
      throw error;
    }
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    const sent = await this.retry(() => this.bot.api.sendMessage(toChatId(target.chatId), text, {
      message_thread_id: toThreadId(target.threadId),
      disable_notification: options?.disableNotification
    }));

    return toSentMessage(target, sent.message_id, options?.deliveryId);
  }

  async editText(
    target: ChannelTarget,
    messageId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    await this.retry(() => this.bot.api.editMessageText(toChatId(target.chatId), Number(messageId), text, {
      parse_mode: undefined
    }));
  }

  async sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage> {
    const filePath = file.localPath;
    const inputFile = filePath ? new InputFile(filePath, file.filename) : new InputFile(file.data ?? new Uint8Array(), file.filename);
    const sent = await this.retry(() => this.bot.api.sendDocument(toChatId(target.chatId), inputFile, {
      message_thread_id: toThreadId(target.threadId)
    }));
    return toSentMessage(target, sent.message_id);
  }

  async sendButtons(
    target: ChannelTarget,
    text: string,
    buttons: ChannelButton[][],
    options?: SendOptions,
  ): Promise<SentMessage> {
    validateTelegramButtons(buttons);
    const keyboard = new InlineKeyboard();
    for (const row of buttons) {
      for (const button of row) {
        keyboard.text(button.label, button.token);
      }
      keyboard.row();
    }

    const sent = await this.retry(() => this.bot.api.sendMessage(toChatId(target.chatId), text, {
      message_thread_id: toThreadId(target.threadId),
      reply_markup: keyboard
    }));

    return toSentMessage(target, sent.message_id, options?.deliveryId);
  }

  async answerInteraction(interactionId: string, text?: string, alert?: boolean): Promise<void> {
    await this.retry(() => this.bot.api.answerCallbackQuery(interactionId, {
      text,
      show_alert: alert
    }));
  }

  async downloadAttachment(attachment: ChannelAttachment): Promise<Uint8Array> {
    if (!attachment.providerFileId) {
      throw new Error("Telegram attachment is missing file id");
    }
    const fileId = attachment.providerFileId;
    const file = await this.retry(() => this.bot.api.getFile(fileId));
    if (!file.file_path) {
      throw new Error("Telegram did not return a downloadable file path");
    }
    const filePath = file.file_path;
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const response = await this.retry(async () => {
      const result = await fetchImpl(telegramFileDownloadUrl(
        this.config.botToken,
        filePath,
        this.config.fileDownloadBaseUrl,
      ));
      if (!result.ok) {
        throw new TelegramFileDownloadError(result.status);
      }
      return result;
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async setTyping(target: ChannelTarget): Promise<void> {
    await this.retry(() => this.bot.api.sendChatAction(toChatId(target.chatId), "typing", {
      message_thread_id: toThreadId(target.threadId)
    }));
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    return withTelegramRetry(operation, {
      onRateLimit: this.config.onRateLimit
    });
  }

  private assertWebhookAuthorized(auth: TelegramWebhookAuth): void {
    if (this.config.mode !== "webhook") {
      throw new Error("Telegram webhook updates require webhook mode");
    }
    const expectedSecret = this.config.webhook?.secretToken;
    if (!expectedSecret) {
      throw new Error("Telegram webhook mode requires webhook configuration");
    }
    if (auth.verified === true) {
      return;
    }

    const providedSecret =
      auth.secretToken ?? headerValue(auth.headers, "x-telegram-bot-api-secret-token");
    if (!constantTimeStringEqual(providedSecret, expectedSecret)) {
      throw new WebhookAuthError("Telegram webhook secret verification failed");
    }
  }

  private claimWebhookUpdate(updateId: string): boolean {
    if (this.seenWebhookUpdateIds.has(updateId)) {
      return false;
    }
    this.seenWebhookUpdateIds.add(updateId);
    this.seenWebhookUpdateOrder.push(updateId);
    while (this.seenWebhookUpdateOrder.length > MAX_TELEGRAM_WEBHOOK_DEDUPE_KEYS) {
      const evicted = this.seenWebhookUpdateOrder.shift();
      if (evicted) this.seenWebhookUpdateIds.delete(evicted);
    }
    return true;
  }

  private releaseWebhookUpdate(updateId: string): void {
    if (!this.seenWebhookUpdateIds.delete(updateId)) {
      return;
    }
    const index = this.seenWebhookUpdateOrder.indexOf(updateId);
    if (index >= 0) this.seenWebhookUpdateOrder.splice(index, 1);
  }
}

function telegramUpdateId(update: unknown): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

export function mapTelegramMessage(
  ctx: Context,
  config: TelegramProviderConfig,
  identity: TelegramBotIdentity,
  providerId: ChannelProviderId = "telegram",
): IncomingChannelMessage | null {
  const message = ctx.message;
  const from = message?.from;
  const chat = message?.chat;
  if (!message || !from || !chat) {
    return null;
  }
  if (from.is_bot) {
    return null;
  }

  const text = "text" in message && typeof message.text === "string" ? message.text : "caption" in message && typeof message.caption === "string" ? message.caption : "";
  const parsedCommand = parseTelegramCommand(text, identity.username);
  if (!shouldAcceptMessage(message, text, parsedCommand !== null, config, identity)) {
    return null;
  }
  const threadId = "message_thread_id" in message && typeof message.message_thread_id === "number" ? String(message.message_thread_id) : null;
  const providerEventId = telegramContextUpdateId(ctx) ?? String(message.message_id);

  return {
    id: String(message.message_id),
    providerInstanceId: providerId,
    providerEventId,
    providerMessageId: String(message.message_id),
    provider: providerId,
    providerKind: "telegram",
    target: {
      provider: providerId,
      providerKind: "telegram",
      chatId: String(chat.id),
      isDirect: chat.type === "private",
      threadId,
      userId: String(from.id),
      messageId: String(message.message_id)
    },
    sender: {
      providerUserId: String(from.id),
      username: from.username ?? null,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
      isBot: from.is_bot
    },
    text,
    rawText: text,
    isCommand: parsedCommand !== null,
    command: parsedCommand?.command,
    commandArgs: parsedCommand?.args,
    attachments: extractTelegramAttachments(message),
    receivedAt: new Date(message.date * 1000),
    raw: message
  };
}

export function mapTelegramCallback(ctx: Context, providerId: ChannelProviderId = "telegram"): IncomingChannelMessage | null {
  const query = ctx.callbackQuery;
  const from = query?.from;
  const data = query?.data;
  const message = query?.message;
  const chat = message?.chat;
  if (!query || !from || !data || !message || !chat) {
    return null;
  }
  if (from.is_bot) {
    return null;
  }

  const threadId = "message_thread_id" in message && typeof message.message_thread_id === "number" ? String(message.message_thread_id) : null;
  const providerEventId = telegramContextUpdateId(ctx) ?? query.id;

  return {
    id: query.id,
    providerInstanceId: providerId,
    providerEventId,
    providerMessageId: String(message.message_id),
    provider: providerId,
    providerKind: "telegram",
    target: {
      provider: providerId,
      providerKind: "telegram",
      chatId: String(chat.id),
      isDirect: chat.type === "private",
      threadId,
      userId: String(from.id),
      messageId: String(message.message_id)
    },
    sender: {
      providerUserId: String(from.id),
      username: from.username ?? null,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
      isBot: from.is_bot
    },
    text: data,
    rawText: data,
    isCommand: false,
    attachments: [],
    interaction: {
      id: query.id,
      token: data,
      kind: "button"
    },
    receivedAt: new Date(),
    raw: query
  };
}

function telegramContextUpdateId(ctx: Context): string | null {
  return telegramUpdateId((ctx as { update?: unknown }).update);
}

export function parseTelegramCommand(text: string, botUsername?: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [head, ...tail] = trimmed.slice(1).split(/\s+/);
  const [rawCommand, rawSuffix] = head?.split("@") ?? [];
  if (rawSuffix && botUsername && rawSuffix.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }
  const command = rawCommand?.toLowerCase();
  if (!command) {
    return null;
  }
  return { command, args: tail.join(" ") };
}

function shouldAcceptMessage(
  message: NonNullable<Context["message"]>,
  text: string,
  isCommand: boolean,
  config: TelegramProviderConfig,
  identity: TelegramBotIdentity,
): boolean {
  const chat = message.chat;
  if (chat.type === "private") {
    return true;
  }
  if (config.respondInGroups === "all" || config.observeUnmentionedGroupMessages) {
    return true;
  }
  if (isCommand) {
    return true;
  }
  if (config.respondInGroups !== "mentions_and_replies") {
    return false;
  }
  if (identity.username && text.toLowerCase().includes(`@${identity.username.toLowerCase()}`)) {
    return true;
  }
  if ("reply_to_message" in message && message.reply_to_message?.from?.id === identity.id) {
    return true;
  }
  return false;
}

export function extractTelegramAttachments(message: NonNullable<Context["message"]>): ChannelAttachment[] {
  const attachments: ChannelAttachment[] = [];

  if ("document" in message && message.document) {
    attachments.push({
      providerFileId: message.document.file_id,
      filename: message.document.file_name ?? "document",
      mimeType: message.document.mime_type,
      sizeBytes: message.document.file_size
    });
  }

  if ("photo" in message && message.photo && message.photo.length > 0) {
    const photo = message.photo.at(-1);
    if (photo) {
      attachments.push({
        providerFileId: photo.file_id,
        filename: `${photo.file_unique_id}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: photo.file_size
      });
    }
  }

  return attachments;
}

export function validateTelegramButtons(buttons: ChannelButton[][]): void {
  for (const row of buttons) {
    for (const button of row) {
      const label = button.label.trim();
      if (!label) {
        throw new Error("Telegram inline button label cannot be empty");
      }
      if (containsControlCharacter(button.token)) {
        throw new Error("Telegram inline button token cannot contain control characters");
      }
      const tokenBytes = Buffer.byteLength(button.token, "utf8");
      if (tokenBytes < 1 || tokenBytes > 64) {
        throw new Error(`Telegram inline button token must be 1-64 bytes; got ${tokenBytes}`);
      }
    }
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function telegramFileDownloadUrl(
  botToken: string,
  filePath: string,
  baseUrl = `https://${TELEGRAM_FILE_DOWNLOAD_HOST}`,
): string {
  const parsedBase = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (parsedBase.protocol !== "https:" || parsedBase.hostname !== TELEGRAM_FILE_DOWNLOAD_HOST) {
    throw new Error(`Refusing to send the Telegram bot token to a non-Telegram host: ${parsedBase.hostname}`);
  }
  const safeFilePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  return new URL(`file/bot${botToken}/${safeFilePath}`, parsedBase).toString();
}

class TelegramFileDownloadError extends Error {
  readonly response: { status: number };

  constructor(status: number) {
    super(`Telegram file download failed: ${status}`);
    this.response = { status };
  }
}

function toChatId(chatId: string): number | string {
  const numeric = Number(chatId);
  return Number.isSafeInteger(numeric) ? numeric : chatId;
}

function toThreadId(threadId: string | null | undefined): number | undefined {
  if (!threadId) {
    return undefined;
  }
  const numeric = Number(threadId);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

function toSentMessage(target: ChannelTarget, messageId: number, providerDeliveryId?: string): SentMessage {
  return {
    provider: target.provider,
    providerKind: target.providerKind ?? "telegram",
    chatId: target.chatId,
    threadId: target.threadId,
    messageId: String(messageId),
    providerDeliveryId,
    sentAt: new Date()
  };
}

function webhookUrl(publicBaseUrl: string, webhookPath: string): string {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
  const path = webhookPath.startsWith("/") ? webhookPath.slice(1) : webhookPath;
  return new URL(path, base).toString();
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
