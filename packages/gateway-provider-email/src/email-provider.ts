import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { connect as createTlsConnection } from "node:tls";

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
import { constantTimeStringEqual, normalizeChannelCapabilities, normalizeChannelProviderIdentity, WebhookAuthError, WebhookPayloadError } from "@open-cowork/gateway-channel";

export interface EmailProviderConfig {
  providerId?: ChannelProviderId;
  from: string;
  inboundSecret: string;
  // Outbound message subject. Configurable so a downstream builder can rebrand it;
  // defaults to the Open Cowork public-app value when unset.
  subject?: string;
  smtp?: SmtpEmailTransportConfig;
  transport?: EmailTransport;
  now?: () => Date;
  maxAttachmentBytes?: number;
}

const DEFAULT_EMAIL_SUBJECT = "Open Cowork update";

export interface SmtpEmailTransportConfig {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  localName?: string;
  timeoutMs?: number;
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

const emailCapabilities: ChannelCapabilities = {
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
  maxFileSizeBytes: 15 * 1024 * 1024,
  inboundFileModes: ["inline_buffer"],
  outboundFileModes: [],
  editSemantics: "none",
  interactionAcknowledgement: "none",
  rateLimitStrategy: "fixed_backoff",
  supportsEphemeralResponses: false
};
const defaultEmailReplayWindowMs = 24 * 60 * 60 * 1000;
const maxSeenEmailMessages = 5_000;

export class EmailProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind = "email";
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;

  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly transport: EmailTransport;
  private readonly seenMessageIds = new Map<string, number>();

  constructor(private readonly config: EmailProviderConfig) {
    this.id = normalizeChannelProviderIdentity(this.kind, config.providerId).providerId;
    if (!emailAddress(config.from)) throw new Error("Email provider requires a valid from address.");
    if (!config.inboundSecret.trim()) throw new Error("Email inbound secret is required.");
    this.capabilities = normalizeChannelCapabilities({
      ...emailCapabilities,
      maxFileBytes: Math.min(emailCapabilities.maxFileBytes!, normalizeAttachmentLimit(config.maxAttachmentBytes) ?? emailCapabilities.maxFileBytes!)
    });
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
    const now = this.config.now?.() ?? new Date();
    const message = mapEmailPayload(payload, now, this.capabilities.maxFileBytes, this.id);
    if (!message) return;
    const replayKey = message.providerEventId || message.id;
    const nowMs = now.getTime();
    this.claimMessageId(replayKey, nowMs);
    try {
      await this.handler(message);
    } catch (error) {
      this.seenMessageIds.delete(replayKey);
      throw error;
    }
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    const messageId = emailMessageId();
    const result = await this.transport.send({
      from: this.config.from,
      to: target.chatId,
      subject: this.config.subject?.trim() || DEFAULT_EMAIL_SUBJECT,
      text,
      messageId,
      inReplyTo: target.threadId || null,
      references: target.threadId ? [target.threadId] : null
    });
    return {
      provider: target.provider,
      providerKind: target.providerKind ?? "email",
      chatId: target.chatId,
      threadId: target.threadId || messageId,
      messageId: result?.messageId || messageId,
      providerDeliveryId: options?.deliveryId,
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
      throw new WebhookAuthError("Email webhook shared secret verification failed.");
    }
  }

  private claimMessageId(messageId: string, nowMs: number): void {
    this.purgeSeenMessageIds(nowMs);
    const existingExpiresAt = this.seenMessageIds.get(messageId);
    if (existingExpiresAt && existingExpiresAt > nowMs) {
      throw new WebhookAuthError("Email webhook message replay rejected.");
    }
    this.seenMessageIds.set(messageId, nowMs + defaultEmailReplayWindowMs);
    if (this.seenMessageIds.size > maxSeenEmailMessages) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }

  private purgeSeenMessageIds(nowMs: number): void {
    for (const [key, expiresAt] of this.seenMessageIds) {
      if (expiresAt <= nowMs) this.seenMessageIds.delete(key);
    }
  }
}

export class SmtpEmailTransport implements EmailTransport {
  constructor(private readonly config: SmtpEmailTransportConfig) {
    if (!config.host.trim()) throw new Error("SMTP host is required.");
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const host = this.config.host;
    const port = this.config.port || (this.config.secure ? 465 : 25);
    const timeoutMs = normalizeSmtpTimeoutMs(this.config.timeoutMs);
    const localName = this.config.localName || "open-cowork-gateway";
    const socket = await connectSocket(host, port, this.config.secure === true, timeoutMs);
    const client = new SmtpClient(socket, timeoutMs);
    try {
      await client.expect(220);
      let capabilities = await client.ehlo(localName);
      // Opportunistic STARTTLS (audit G2): if the server advertises it and we are not already on an
      // implicit-TLS (port 465) socket, upgrade the connection BEFORE any credentials cross it, then
      // re-EHLO over the encrypted channel as RFC 3207 requires.
      if (!client.isSecure && capabilities.has("STARTTLS")) {
        await client.command("STARTTLS", 220);
        await client.startTls(host);
        capabilities = await client.ehlo(localName);
      }
      if (this.config.username) {
        // Fail closed: never put AUTH PLAIN credentials on a plaintext socket. If the server offered
        // no STARTTLS and this is not an implicit-TLS connection, refuse rather than leak the secret.
        if (!client.isSecure) {
          throw new Error("Refusing to send SMTP AUTH credentials over a plaintext connection; enable TLS (smtp secure/port 465) or STARTTLS on the SMTP server.");
        }
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
      client.close();
    }
  }
}

function mapEmailPayload(payload: unknown, now: Date, maxAttachmentBytes: number | undefined, providerId: ChannelProviderId = "email"): IncomingChannelMessage | null {
  const input = objectRecord(payload) as EmailIncomingPayload;
  const from = emailAddress(input.from) || emailAddress(input.sender);
  if (!from) return null;
  const messageId = cleanHeaderId(input.messageId || input.id);
  if (!messageId) {
    throw new WebhookPayloadError("Email webhook messageId or id is required for replay protection.");
  }
  const text = stringField(input, "text") || stringField(input, "body") || "";
  const threadId = cleanHeaderId(input.threadId)
    || cleanHeaderId(input.inReplyTo)
    || lastReference(input.references)
    || messageId;
  return {
    id: messageId,
    providerInstanceId: providerId,
    providerEventId: messageId,
    providerMessageId: messageId,
    provider: providerId,
    providerKind: "email",
    target: {
      provider: providerId,
      providerKind: "email",
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
    attachments: emailAttachments(input.attachments, maxAttachmentBytes),
    interaction: undefined,
    receivedAt: now,
    raw: payload
  };
}

function emailAttachments(values: EmailIncomingPayload["attachments"], maxAttachmentBytes: number | undefined): ChannelAttachment[] {
  if (!Array.isArray(values)) return [];
  return values.map((attachment) => {
    const base64 = attachment.contentBase64 || attachment.bufferBase64 || "";
    const buffer = base64 ? Buffer.from(base64, "base64") : undefined;
    const sizeBytes = attachment.sizeBytes || attachment.size || buffer?.byteLength;
    if (sizeBytes !== undefined && maxAttachmentBytes !== undefined && sizeBytes > maxAttachmentBytes) {
      throw new WebhookPayloadError(`Email attachment exceeds maxFileBytes ${maxAttachmentBytes}.`);
    }
    if (buffer && maxAttachmentBytes !== undefined && buffer.byteLength > maxAttachmentBytes) {
      throw new WebhookPayloadError(`Email attachment exceeds maxFileBytes ${maxAttachmentBytes}.`);
    }
    return {
      filename: attachment.filename || attachment.name || "attachment",
      mimeType: attachment.mimeType || attachment.contentType,
      sizeBytes,
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
  return `${headers.map(([key, value]) => `${key}: ${sanitizeHeader(value ?? "")}`).join("\r\n")}\r\n\r\n${dotStuff(message.text)}\r\n.`;
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

function connectSocket(host: string, port: number, secure: boolean, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? createTlsConnection({ host, port }) : createConnection({ host, port });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("SMTP connection timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("error", onError);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("SMTP socket timed out.")));
      resolve(socket);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("secureConnect", onConnect);
    socket.once("error", onError);
  });
}

// Upgrade an established plaintext SMTP socket to TLS in place (STARTTLS). `servername` is pinned to
// the configured host so the certificate is validated against it (SNI + hostname check).
function upgradeSocketToTls(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsSocket = createTlsConnection({ socket, servername: host });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      tlsSocket.destroy();
      reject(new Error("SMTP STARTTLS upgrade timed out."));
    }, timeoutMs);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      tlsSocket.removeListener("error", onError);
      tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error("SMTP socket timed out.")));
      resolve(tlsSocket);
    });
    tlsSocket.once("error", onError);
  });
}

function isTlsSocket(socket: Socket): boolean {
  return (socket as { encrypted?: boolean }).encrypted === true;
}

class SmtpClient {
  // Buffer-mode line reader (no socket.setEncoding): keeping the underlying socket in raw byte mode
  // is what lets STARTTLS hand it cleanly to the TLS layer, and decoding each completed line as utf8
  // avoids splitting any multibyte sequence at a chunk boundary.
  private socket: Socket;
  private secure: boolean;
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<{
    resolve(line: string): void;
    reject(error: Error): void;
  }> = [];
  private readonly onData = (chunk: Buffer | string): void => {
    this.handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  private readonly onError = (error: Error): void => {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  };

  constructor(socket: Socket, private readonly timeoutMs: number) {
    this.socket = socket;
    this.secure = isTlsSocket(socket);
    this.attach(socket);
  }

  get isSecure(): boolean {
    return this.secure;
  }

  private attach(socket: Socket): void {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
  }

  private detach(socket: Socket): void {
    socket.removeListener("data", this.onData);
    socket.removeListener("error", this.onError);
  }

  async startTls(host: string): Promise<void> {
    // The server is silent until it receives our TLS ClientHello, so detaching here drops no inbound
    // bytes. Rebind the reader to the secure socket and reset the buffer for the encrypted session.
    const plain = this.socket;
    this.detach(plain);
    const secureSocket = await upgradeSocketToTls(plain, host, this.timeoutMs);
    this.socket = secureSocket;
    this.secure = true;
    this.buffer = Buffer.alloc(0);
    this.attach(secureSocket);
  }

  async command(line: string, expected: number | number[]): Promise<void> {
    this.socket.write(`${line}\r\n`);
    await this.expect(expected);
  }

  // Send EHLO and collect the advertised capability keywords (e.g. STARTTLS, AUTH) from the
  // multi-line 250 response.
  async ehlo(localName: string): Promise<Set<string>> {
    this.socket.write(`EHLO ${localName}\r\n`);
    const capabilities = new Set<string>();
    while (true) {
      const line = await this.readLine();
      const code = Number(line.slice(0, 3));
      const continued = line[3] === "-";
      if (code !== 250) throw new Error(`SMTP command failed: ${line}`);
      const keyword = line.slice(4).trim().split(/\s+/)[0];
      if (keyword) capabilities.add(keyword.toUpperCase());
      if (!continued) return capabilities;
    }
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

  close(): void {
    this.detach(this.socket);
    this.socket.end();
  }

  private readLine(): Promise<string> {
    const ready = this.takeBufferedLine();
    if (ready !== null) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      let waiter!: { resolve(line: string): void; reject(error: Error): void };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("SMTP response timed out."));
      }, this.timeoutMs);
      waiter = {
        resolve(line) {
          clearTimeout(timeout);
          resolve(line);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      this.waiters.push(waiter);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.waiters.length) {
      const line = this.takeBufferedLine();
      if (line === null) return;
      this.waiters.shift()?.resolve(line);
    }
  }

  private takeBufferedLine(): string | null {
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return null;
    const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    this.buffer = this.buffer.subarray(newline + 1);
    return line;
  }
}

function normalizeSmtpTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 30_000;
  }
  return Math.min(120_000, Math.max(100, Math.floor(value)));
}

function normalizeAttachmentLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}
