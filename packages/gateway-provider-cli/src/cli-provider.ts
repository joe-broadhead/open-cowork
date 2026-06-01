import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type {
  ChannelAttachment,
  ChannelButton,
  ChannelCapabilities,
  ChannelProviderId,
  ChannelProviderKind,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";
import { normalizeChannelCapabilities, normalizeChannelProviderIdentity } from "@open-cowork/gateway-channel";

export interface CliProviderConfig {
  providerId?: ChannelProviderId;
  input?: Readable;
  output?: Writable;
  now?: () => Date;
}

export interface CliIncomingPayload {
  id?: string;
  chatId?: string;
  threadId?: string | null;
  userId?: string;
  username?: string | null;
  displayName?: string | null;
  text?: string;
  rawText?: string;
  interaction?: {
    id: string;
    token: string;
    kind?: "button" | "command";
  };
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    sizeBytes?: number;
    bufferBase64?: string;
  }>;
}

export class CliProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind = "cli";
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  private readonly baseCapabilities: ChannelCapabilities = {
    threads: true,
    messageEditing: false,
    inlineButtons: false,
    fileUploads: true,
    fileDownloads: false,
    typingIndicator: false,
    maxTextLength: 12_000,
    preferredParseMode: "plain",
    parseModes: ["plain"],
    maxButtonsPerMessage: 0,
    maxButtonRowsPerMessage: 0,
    maxButtonTokenBytes: 0,
    maxFileBytes: 10 * 1024 * 1024,
    maxFileSizeBytes: 10 * 1024 * 1024,
    inboundFileModes: ["inline_buffer"],
    outboundFileModes: [],
    editSemantics: "none",
    interactionAcknowledgement: "none",
    rateLimitStrategy: "none",
    supportsEphemeralResponses: false
  };

  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly now: () => Date;
  private reader: Interface | null = null;

  constructor(config: CliProviderConfig = {}) {
    this.id = normalizeChannelProviderIdentity(this.kind, config.providerId).providerId;
    this.capabilities = normalizeChannelCapabilities(this.baseCapabilities);
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.now = config.now ?? (() => new Date());
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.reader = createInterface({ input: this.input, crlfDelay: Number.POSITIVE_INFINITY });
    this.reader.on("line", (line) => {
      void this.handleLine(line);
    });
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    this.reader?.close();
    this.reader = null;
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    return this.writeEvent("text", target, { text, options });
  }

  async editText(): Promise<void> {
    throw new Error("CLI provider does not support message editing; use appended output instead.");
  }

  async sendFile(): Promise<SentMessage> {
    throw new Error("CLI provider does not send local files; render artifact links instead.");
  }

  async sendButtons(_target: ChannelTarget, _text: string, _buttons: ChannelButton[][]): Promise<SentMessage> {
    throw new Error("CLI provider does not support inline buttons; use token approval fallback.");
  }

  async answerInteraction(interactionId: string, text?: string, alert?: boolean): Promise<void> {
    this.writeJson({ type: "answer_interaction", interactionId, text, alert });
  }

  async downloadAttachment(attachment: ChannelAttachment): Promise<Uint8Array> {
    if (attachment.buffer) return attachment.buffer;
    throw new Error("CLI attachment content is not available.");
  }

  private async handleLine(line: string): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const payload = trimmed.startsWith("{")
        ? JSON.parse(trimmed) as unknown
        : { text: trimmed };
      await handler(mapCliPayload(payload, this.now(), this.id));
    } catch (error) {
      this.writeJson({
        type: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeEvent(type: string, target: ChannelTarget, payload: Record<string, unknown>): Promise<SentMessage> {
    const messageId = randomUUID();
    const sentAt = this.now();
    this.writeJson({
      type,
      target: normalizeTarget(target),
      messageId,
      sentAt: sentAt.toISOString(),
      ...payload
    });
    return {
      provider: target.provider,
      providerKind: target.providerKind ?? this.kind,
      chatId: target.chatId,
      threadId: target.threadId,
      messageId,
      sentAt
    };
  }

  private writeJson(payload: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify({ provider: this.id, providerKind: this.kind, ...payload })}\n`);
  }
}

export function mapCliPayload(payload: unknown, now = new Date(), providerId: ChannelProviderId = "cli"): IncomingChannelMessage {
  const record = isRecord(payload) ? payload as CliIncomingPayload : { text: String(payload ?? "") };
  const text = cleanString(record.text) ?? "";
  const rawText = cleanString(record.rawText) ?? text;
  const chatId = cleanString(record.chatId) ?? "local-cli";
  const userId = cleanString(record.userId) ?? "cli-user";
  const command = parseCommand(text);
  const id = cleanString(record.id) ?? randomUUID();
  return {
    id,
    providerInstanceId: providerId,
    providerEventId: id,
    providerMessageId: id,
    provider: providerId,
    providerKind: "cli",
    target: {
      provider: providerId,
      providerKind: "cli",
      chatId,
      isDirect: true,
      threadId: cleanString(record.threadId) ?? null,
      userId
    },
    sender: {
      providerUserId: userId,
      username: cleanString(record.username) ?? null,
      displayName: cleanString(record.displayName) ?? null
    },
    text,
    rawText,
    isCommand: command !== null,
    command: command?.command,
    commandArgs: command?.args,
    attachments: normalizeAttachments(record.attachments),
    interaction: normalizeInteraction(record.interaction),
    receivedAt: now,
    raw: payload
  };
}

function normalizeTarget(target: ChannelTarget): ChannelTarget {
  if (target.providerKind !== "cli" && target.provider !== "cli" && !String(target.provider).startsWith("cli-")) {
    throw new Error(`CLI provider cannot deliver target for provider ${target.provider}.`);
  }
  return {
    provider: target.provider,
    providerKind: "cli",
    chatId: cleanRequired(target.chatId, "CLI target.chatId"),
    isDirect: target.isDirect === true,
    threadId: cleanString(target.threadId) ?? null,
    userId: cleanString(target.userId) ?? null,
    messageId: cleanString(target.messageId) ?? null
  };
}

function normalizeAttachments(value: CliIncomingPayload["attachments"]): ChannelAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((attachment) => {
    const filename = cleanRequired(attachment.filename, "CLI attachment.filename");
    const bufferBase64 = cleanString(attachment.bufferBase64);
    const buffer = bufferBase64
      ? Uint8Array.from(Buffer.from(bufferBase64, "base64"))
      : undefined;
    return {
      filename,
      mimeType: cleanString(attachment.mimeType),
      sizeBytes: typeof attachment.sizeBytes === "number" && Number.isInteger(attachment.sizeBytes)
        ? attachment.sizeBytes
        : buffer?.byteLength,
      buffer
    };
  });
}

function normalizeInteraction(value: CliIncomingPayload["interaction"]): IncomingChannelMessage["interaction"] | undefined {
  if (!value) return undefined;
  const id = cleanString(value.id);
  const token = cleanString(value.token);
  if (!id || !token) throw new Error("CLI interaction requires id and token.");
  return {
    id,
    token,
    kind: value.kind === "button" ? "button" : "command"
  };
}

function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [command, ...args] = trimmed.slice(1).split(/\s+/);
  if (!command || !/^[a-z][a-z0-9_-]*$/i.test(command)) return null;
  return { command: command.toLowerCase(), args: args.join(" ") };
}

function cleanRequired(value: unknown, label: string): string {
  const cleaned = cleanString(value);
  if (!cleaned) throw new Error(`${label} is required.`);
  return cleaned;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
