import { randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { connect as createTlsConnection } from "node:tls";

import type {
  ChannelAttachment,
  ChannelButton,
  ChannelCapabilities,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";

export interface EmailProviderConfig {
  from: string;
  inboundSecret: string;
  smtp?: SmtpEmailTransportConfig;
  transport?: EmailTransport;
  now?: () => Date;
}

export interface SmtpEmailTransportConfig {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  localName?: string;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[] | null;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<{ messageId?: string | null } | void>;
}

export interface EmailWebhookAuth {
  headers?: Headers | Record<string, string | string[] | undefined>;
  sharedSecret?: string | null;
  verified?: boolean;
}

type EmailIncomingPayload = {
  id?: string;
  messageId?: string;
  from?: string | { email?: string; name?: string };
  sender?: string | { email?: string; name?: string };
  to?: string | string[];
  recipient?: string;
  subject?: string;
  text?: string;
  body?: string;
  inReplyTo?: string;
  references?: string | string[];
  threadId?: string;
  attachments?: Array<{
    filename?: string;
    name?: string;
    mimeType?: string;
    contentType?: string;
    sizeBytes?: number;
    size?: number;
    contentBase64?: string;
    bufferBase64?: string;
  }>;
};

export class EmailProvider implements ChannelProvider {
  readonly id = "email" as const;
  readonly capabilities: ChannelCapabilities = {
    threads: true,
    messageEditing: false,
    inlineButtons: false,
    fileUploads: true,
    fileDownloads: false,
    typingIndicator: false,
    maxTextLength: 20_000,
    preferredParseMode: "plain",
    parseModes: ["plain"],
    maxButtonsPerMessage: 0,
    maxButtonRowsPerMessage: 0,
    maxButtonTokenBytes: 0,
    maxFileBytes: 15 * 1024 * 1024,
    supportsEphemeralResponses: false
  };

  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly transport: EmailTransport;

  constructor(private readonly config: EmailProviderConfig) {
    if (!emailAddress(config.from)) throw new Error("Email provider requires a valid from address.");
    if (!config.inboundSecret.trim()) throw new Error("Email inbound secret is required.");
    this.transport = config.transport || new SmtpEmailTransport(config.smtp || missingSmtpConfig());
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async handleWebhookPayload(payload: unknown, auth: EmailWebhookAuth): Promise<void> {
    if (!this.handler) throw new Error("Email provider is not started.");
    this.assertWebhookAuthorized(auth);
    const message = mapEmailPayload(payload, this.config.now?.() ?? new Date());
    if (message) await this.handler(message);
  }

  async sendText(target: ChannelTarget, text: string, _options?: SendOptions): Promise<SentMessage> {
    const messageId = emailMessageId();
    const result = await this.transport.send({
      from: this.config.from,
      to: target.chatId,
      subject: "Open Cowork update",
      text,
      messageId,
      inReplyTo: target.threadId || null,
      references: target.threadId ? [target.threadId] : null
    });
    return {
      provider: "email",
      chatId: target.chatId,
      threadId: target.threadId || messageId,
      messageId: result?.messageId || messageId,
      sentAt: new Date()
    };
  }

  async editText(): Promise<void> {
    throw new Error("Email provider does not support message editing.");
  }

  async sendFile(): Promise<SentMessage> {
    throw new Error("Email provider does not support outgoing files; send an artifact link instead.");
  }

  async sendButtons(_target: ChannelTarget, _text: string, _buttons: ChannelButton[][]): Promise<SentMessage> {
    throw new Error("Email provider does not support inline buttons; use token approval fallback.");
  }

  async answerInteraction(): Promise<void> {
    // Email approvals use command-token replies, so there is no provider-native interaction to acknowledge.
  }

  async downloadAttachment(attachment: ChannelAttachment): Promise<Uint8Array> {
    if (attachment.buffer) return attachment.buffer;
    throw new Error("Email attachment content is not available.");
  }

  private assertWebhookAuthorized(auth: EmailWebhookAuth): void {
    if (auth.verified === true) return;
    const expectedSecret = this.config.inboundSecret;
    const providedSecret = auth.sharedSecret
      || headerValue(auth.headers, "x-open-cowork-gateway-email-secret")
      || bearerToken(headerValue(auth.headers, "authorization"));
    if (!constantTimeStringEqual(providedSecret, expectedSecret)) {
      throw new Error("Email webhook shared secret verification failed.");
    }
  }
}

export class SmtpEmailTransport implements EmailTransport {
  constructor(private readonly config: SmtpEmailTransportConfig) {
    if (!config.host.trim()) throw new Error("SMTP host is required.");
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const port = this.config.port || (this.config.secure ? 465 : 25);
    const socket = await connectSocket(this.config.host, port, this.config.secure === true);
    const client = new SmtpClient(socket);
    try {
      await client.expect(220);
      await client.command(`EHLO ${this.config.localName || "open-cowork-gateway"}`, 250);
      if (this.config.username) {
        const auth = Buffer.from(`\0${this.config.username}\0${this.config.password || ""}`, "utf8").toString("base64");
        await client.command(`AUTH PLAIN ${auth}`, 235);
      }
      await client.command(`MAIL FROM:<${message.from}>`, 250);
      await client.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await client.command("DATA", 354);
      await client.writeData(renderEmailMessage(message));
      await client.expect(250);
      await client.command("QUIT", 221);
      return { messageId: message.messageId };
    } finally {
      socket.end();
    }
  }
}

function mapEmailPayload(payload: unknown, now: Date): IncomingChannelMessage | null {
  const input = objectRecord(payload) as EmailIncomingPayload;
  const from = emailAddress(input.from) || emailAddress(input.sender);
  if (!from) return null;
  const messageId = cleanHeaderId(input.messageId || input.id) || emailMessageId();
  const text = stringField(input, "text") || stringField(input, "body") || "";
  const threadId = cleanHeaderId(input.threadId)
    || cleanHeaderId(input.inReplyTo)
    || lastReference(input.references)
    || messageId;
  return {
    id: messageId,
    provider: "email",
    target: {
      provider: "email",
      chatId: from,
      threadId,
      userId: from,
      messageId
    },
    sender: {
      providerUserId: from,
      username: from,
      displayName: emailDisplayName(input.from) || emailDisplayName(input.sender),
      isBot: false
    },
    text,
    rawText: text,
    isCommand: text.trimStart().startsWith("/"),
    command: commandName(text),
    commandArgs: commandArgs(text),
    attachments: emailAttachments(input.attachments),
    interaction: undefined,
    receivedAt: now,
    raw: payload
  };
}

function emailAttachments(values: EmailIncomingPayload["attachments"]): ChannelAttachment[] {
  if (!Array.isArray(values)) return [];
  return values.map((attachment) => {
    const base64 = attachment.contentBase64 || attachment.bufferBase64 || "";
    const buffer = base64 ? Buffer.from(base64, "base64") : undefined;
    return {
      filename: attachment.filename || attachment.name || "attachment",
      mimeType: attachment.mimeType || attachment.contentType,
      sizeBytes: attachment.sizeBytes || attachment.size || buffer?.byteLength,
      buffer
    };
  });
}

function renderEmailMessage(message: EmailMessage): string {
  const references = message.references?.filter(Boolean) || [];
  const headers = [
    ["From", message.from],
    ["To", message.to],
    ["Subject", message.subject],
    ["Message-ID", message.messageId],
    ["Date", new Date().toUTCString()],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "8bit"],
    ...(message.inReplyTo ? [["In-Reply-To", message.inReplyTo]] : []),
    ...(references.length ? [["References", references.join(" ")]] : [])
  ];
  return `${headers.map(([key, value]) => `${key}: ${sanitizeHeader(value)}`).join("\r\n")}\r\n\r\n${dotStuff(message.text)}\r\n.`;
}

function dotStuff(value: string): string {
  return value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function emailAddress(value: unknown): string | null {
  if (typeof value === "string") {
    const address = firstEmailCandidate(value);
    return address ? address.toLowerCase() : null;
  }
  const record = objectRecord(value);
  return emailAddress(record.email);
}

function emailDisplayName(value: unknown): string | null {
  if (typeof value === "string") {
    const marker = value.indexOf("<");
    if (marker <= 0) return null;
    const displayName = stripOuterQuotes(value.slice(0, marker).trim());
    return displayName || null;
  }
  const record = objectRecord(value);
  return stringField(record, "name");
}

function firstEmailCandidate(value: string): string | null {
  const input = value.slice(0, 1024).trim();
  const marker = input.lastIndexOf("<");
  if (marker >= 0) {
    const close = input.indexOf(">", marker + 1);
    const bracketed = close >= 0 ? input.slice(marker + 1, close) : input.slice(marker + 1);
    const normalized = cleanEmailCandidate(bracketed);
    if (isValidEmailAddress(normalized)) return normalized;
  }
  for (const token of tokenizeAddressInput(input)) {
    const normalized = cleanEmailCandidate(token);
    if (isValidEmailAddress(normalized)) return normalized;
  }
  return null;
}

function tokenizeAddressInput(value: string): string[] {
  const tokens: string[] = [];
  let start: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const separator = code === 44 || code === 59 || code <= 32;
    if (separator) {
      if (start !== null) tokens.push(value.slice(start, index));
      start = null;
    } else if (start === null) {
      start = index;
    }
  }
  if (start !== null) tokens.push(value.slice(start));
  return tokens;
}

function cleanEmailCandidate(value: string): string {
  let candidate = value.trim();
  if (candidate.toLowerCase().startsWith("mailto:")) {
    candidate = candidate.slice("mailto:".length).trim();
  }
  candidate = stripOuterQuotes(candidate);
  while (candidate.startsWith("<")) candidate = candidate.slice(1).trimStart();
  while (candidate.endsWith(">") || candidate.endsWith(",") || candidate.endsWith(";")) {
    candidate = candidate.slice(0, -1).trimEnd();
  }
  return candidate;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isValidEmailAddress(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  if (!hasOnlyEmailLocalChars(local) || !hasOnlyEmailDomainChars(domain)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return false;
  return labels.at(-1)!.length >= 2;
}

function hasOnlyEmailLocalChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const valid = isAsciiAlphaNumeric(code)
      || code === 33
      || code === 35
      || code === 36
      || code === 37
      || code === 38
      || code === 39
      || code === 42
      || code === 43
      || code === 45
      || code === 46
      || code === 47
      || code === 61
      || code === 63
      || code === 94
      || code === 95
      || code === 96
      || code === 123
      || code === 124
      || code === 125
      || code === 126;
    if (!valid) return false;
  }
  return value.length > 0;
}

function hasOnlyEmailDomainChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiAlphaNumeric(code) && code !== 45 && code !== 46) return false;
  }
  return value.length > 0;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function lastReference(value: unknown): string | null {
  if (Array.isArray(value)) return cleanHeaderId(value.at(-1));
  if (typeof value !== "string") return null;
  const parts = value.split(/\s+/).map(cleanHeaderId).filter(Boolean);
  return parts.at(-1) || null;
}

function cleanHeaderId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/[^\S\r\n]+/g, " ") : null;
}

function commandName(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  return trimmed.slice(1).split(/\s+/)[0] || undefined;
}

function commandArgs(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  return trimmed.slice(1).split(/\s+/).slice(1).join(" ") || undefined;
}

function emailMessageId(): string {
  return `<${randomUUID()}@open-cowork.local>`;
}

function missingSmtpConfig(): SmtpEmailTransportConfig {
  throw new Error("Email provider requires smtp config or an injected transport.");
}

function connectSocket(host: string, port: number, secure: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? createTlsConnection({ host, port }) : createConnection({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

class SmtpClient {
  private buffer = "";
  private waiters: Array<{
    resolve(line: string): void;
    reject(error: Error): void;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(String(chunk)));
    socket.on("error", (error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  async command(line: string, expected: number | number[]): Promise<void> {
    this.socket.write(`${line}\r\n`);
    await this.expect(expected);
  }

  async writeData(data: string): Promise<void> {
    this.socket.write(`${data}\r\n`);
  }

  async expect(expected: number | number[]): Promise<void> {
    const allowed = Array.isArray(expected) ? expected : [expected];
    while (true) {
      const line = await this.readLine();
      const code = Number(line.slice(0, 3));
      const continued = line[3] === "-";
      if (!continued) {
        if (!allowed.includes(code)) throw new Error(`SMTP command failed: ${line}`);
        return;
      }
    }
  }

  private readLine(): Promise<string> {
    const newline = this.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (this.waiters.length) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.waiters.shift()?.resolve(line);
    }
  }
}

function headerValue(headers: EmailWebhookAuth["headers"], name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    const entry = Array.isArray(value) ? value[0] : value;
    return typeof entry === "string" && entry.trim() ? entry.trim() : null;
  }
  return null;
}

function bearerToken(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith("bearer ") ? value.slice("bearer ".length).trim() : null;
}

function constantTimeStringEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}
