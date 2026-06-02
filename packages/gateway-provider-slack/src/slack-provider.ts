import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

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
import { normalizeChannelCapabilities, normalizeChannelProviderIdentity } from "@open-cowork/gateway-channel";

export interface SlackProviderConfig {
  providerId?: ChannelProviderId;
  botToken: string;
  signingSecret: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  maxSignatureAgeMs?: number;
  requestTimeoutMs?: number;
  maxSeenWebhookSignatures?: number;
  maxSeenWebhookSignaturesPerScope?: number;
}

export interface SlackWebhookAuth {
  headers?: Headers | Record<string, string | string[] | undefined>;
  rawBody?: string;
  signingSecret?: string | null;
  verified?: boolean;
}

export type SlackWebhookResult = {
  challenge?: string;
};

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  file?: {
    id?: string;
    shares?: {
      public?: Record<string, Array<{ ts?: string }>>;
      private?: Record<string, Array<{ ts?: string }>>;
    };
  };
};

const defaultSlackApiBaseUrl = "https://slack.com/api";
const defaultMaxSignatureAgeMs = 5 * 60 * 1000;
const defaultSlackRequestTimeoutMs = 15_000;
const defaultMaxSeenSlackSignatures = 5_000;
const defaultMaxSeenSlackSignaturesPerScope = 1_000;

type SeenSlackWebhookSignature = {
  expiresAt: number;
  scope: string;
};

export class SlackProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind = "slack";
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  private readonly baseCapabilities: ChannelCapabilities = {
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: false,
    maxTextLength: 3000,
    preferredParseMode: "plain",
    parseModes: ["plain", "markdown"],
    maxButtonsPerMessage: 10,
    maxButtonRowsPerMessage: 5,
    maxButtonTokenBytes: 2000,
    maxFileBytes: 20 * 1024 * 1024,
    maxFileSizeBytes: 20 * 1024 * 1024,
    inboundFileModes: ["download_url", "provider_file_id"],
    outboundFileModes: ["local_path", "inline_buffer"],
    editSemantics: "message",
    interactionAcknowledgement: "optional",
    rateLimitStrategy: "retry_after",
    supportsEphemeralResponses: false
  };

  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly seenWebhookSignatures = new Map<string, SeenSlackWebhookSignature>();

  constructor(private readonly config: SlackProviderConfig) {
    this.id = normalizeChannelProviderIdentity(this.kind, config.providerId).providerId;
    this.capabilities = normalizeChannelCapabilities(this.baseCapabilities);
    if (!config.botToken.trim()) throw new Error("Slack bot token is required.");
    if (!config.signingSecret.trim()) throw new Error("Slack signing secret is required.");
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async handleWebhookPayload(payload: unknown, auth: SlackWebhookAuth): Promise<SlackWebhookResult | void> {
    this.assertWebhookAuthorized(auth);
    const record = objectRecord(payload);
    if (record.type === "url_verification") {
      const challenge = stringField(record, "challenge");
      return challenge ? { challenge } : undefined;
    }

    if (!this.handler) throw new Error("Slack provider is not started.");
    const message = mapSlackPayload(record, this.config.now?.() ?? new Date(), this.id);
    if (message) await this.handler(message);
    return undefined;
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    const result = await this.apiJson("chat.postMessage", {
      channel: target.chatId,
      text,
      thread_ts: target.threadId || undefined,
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: options?.parseMode === "markdown"
    });
    return sentMessage(target, stringField(result, "ts") || randomUUID());
  }

  async editText(target: ChannelTarget, messageId: string, text: string, options?: SendOptions): Promise<void> {
    await this.apiJson("chat.update", {
      channel: target.chatId,
      ts: messageId,
      text,
      mrkdwn: options?.parseMode === "markdown"
    });
  }

  async sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage> {
    const filePath = file.localPath ?? file.path;
    const data = file.data || (filePath ? new Uint8Array(await readFile(filePath)) : new Uint8Array());
    if (data.byteLength === 0) throw new Error("Slack file upload requires file data.");
    if (data.byteLength > this.capabilities.maxFileBytes!) {
      throw new Error(`Slack file exceeds maxFileBytes ${this.capabilities.maxFileBytes}.`);
    }
    const form = new FormData();
    form.set("channel_id", target.chatId);
    if (target.threadId) form.set("thread_ts", target.threadId);
    form.set("filename", file.filename);
    form.set("title", file.filename);
    form.set("file", new Blob([Buffer.from(data)], { type: file.mimeType || "application/octet-stream" }), file.filename);
    const result = await this.apiForm("files.uploadV2", form);
    return sentMessage(target, slackFileMessageTs(result) || stringField(result, "ts") || randomUUID());
  }

  async sendButtons(target: ChannelTarget, text: string, buttons: ChannelButton[][]): Promise<SentMessage> {
    validateSlackButtons(buttons);
    const result = await this.apiJson("chat.postMessage", {
      channel: target.chatId,
      text,
      thread_ts: target.threadId || undefined,
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      }, ...buttons.map((row) => ({
        type: "actions",
        block_id: `open_cowork_${randomUUID()}`,
        elements: row.map((button) => ({
          type: "button",
          text: {
            type: "plain_text",
            text: button.label.slice(0, 75)
          },
          value: button.token,
          action_id: `open_cowork_${randomUUID()}`,
          style: button.style === "danger" ? "danger" : button.style === "success" ? "primary" : undefined
        }))
      }))]
    });
    return sentMessage(target, stringField(result, "ts") || randomUUID());
  }

  async answerInteraction(_interactionId: string, _text?: string, _alert?: boolean): Promise<void> {
    // Slack requires HTTP acknowledgement during the interaction request. The
    // gateway endpoint responds 2xx after the provider maps the button payload.
  }

  async downloadAttachment(attachment: ChannelAttachment): Promise<Uint8Array> {
    if (!attachment.providerFileId) throw new Error("Slack attachment is missing a private file URL.");
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const response = await fetchWithTimeout(fetchImpl, attachment.providerFileId, {
      headers: {
        authorization: `Bearer ${this.config.botToken}`
      }
    }, this.config.requestTimeoutMs);
    if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private assertWebhookAuthorized(auth: SlackWebhookAuth): void {
    if (auth.verified === true) return;
    const signingSecret = auth.signingSecret || this.config.signingSecret;
    const rawBody = auth.rawBody || "";
    const timestamp = headerValue(auth.headers, "x-slack-request-timestamp");
    const signature = headerValue(auth.headers, "x-slack-signature");
    if (!signingSecret || !rawBody || !timestamp || !signature) {
      throw new Error("Slack webhook signature is required.");
    }
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) throw new Error("Slack webhook timestamp is invalid.");
    const nowMs = this.config.now?.().getTime() ?? Date.now();
    const maxAgeMs = this.config.maxSignatureAgeMs ?? defaultMaxSignatureAgeMs;
    if (Math.abs(nowMs - timestampSeconds * 1000) > maxAgeMs) {
      throw new Error("Slack webhook timestamp is outside the allowed window.");
    }
    const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    if (!constantTimeStringEqual(signature, expected)) {
      throw new Error("Slack webhook signature verification failed.");
    }
    this.claimWebhookSignature(`${timestamp}:${signature}`, slackReplayScopeFromRawBody(rawBody, this.id), nowMs, maxAgeMs);
  }

  private claimWebhookSignature(replayKey: string, scope: string, nowMs: number, maxAgeMs: number): void {
    this.purgeSeenWebhookSignatures(nowMs);
    const existing = this.seenWebhookSignatures.get(replayKey);
    if (existing && existing.expiresAt > nowMs) {
      throw new Error("Slack webhook signature replay rejected.");
    }
    this.seenWebhookSignatures.set(replayKey, { expiresAt: nowMs + maxAgeMs, scope });
    this.enforceSeenWebhookSignatureScopeLimit(scope);
    this.enforceSeenWebhookSignatureGlobalLimit();
  }

  private enforceSeenWebhookSignatureScopeLimit(scope: string): void {
    const limit = normalizeReplayCacheLimit(this.config.maxSeenWebhookSignaturesPerScope, defaultMaxSeenSlackSignaturesPerScope);
    const scopedKeys: string[] = [];
    for (const [key, entry] of this.seenWebhookSignatures) {
      if (entry.scope !== scope) continue;
      scopedKeys.push(key);
    }
    while (scopedKeys.length > limit) {
      const oldest = scopedKeys.shift();
      if (!oldest) return;
      this.seenWebhookSignatures.delete(oldest);
    }
  }

  private enforceSeenWebhookSignatureGlobalLimit(): void {
    const limit = normalizeReplayCacheLimit(this.config.maxSeenWebhookSignatures, defaultMaxSeenSlackSignatures);
    while (this.seenWebhookSignatures.size > limit) {
      const oldest = this.seenWebhookSignatures.keys().next().value;
      if (!oldest) return;
      this.seenWebhookSignatures.delete(oldest);
    }
  }

  private purgeSeenWebhookSignatures(nowMs: number): void {
    for (const [key, { expiresAt }] of this.seenWebhookSignatures) {
      if (expiresAt <= nowMs) this.seenWebhookSignatures.delete(key);
    }
  }

  private async apiJson(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    return this.api(method, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
  }

  private async apiForm(method: string, body: FormData): Promise<SlackApiResponse> {
    return this.api(method, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.botToken}`
      },
      body
    });
  }

  private async api(method: string, init: RequestInit): Promise<SlackApiResponse> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const response = await fetchWithTimeout(fetchImpl, `${this.config.apiBaseUrl || defaultSlackApiBaseUrl}/${method}`, init, this.config.requestTimeoutMs);
    const json = await responseJson(response);
    if (!response.ok || json.ok === false) {
      throw new Error(`Slack API ${method} failed: ${json.error || response.status}`);
    }
    return json;
  }
}

async function fetchWithTimeout(fetchImpl: typeof globalThis.fetch, input: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeRequestTimeoutMs(timeoutMs));
  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultSlackRequestTimeoutMs;
  }
  return Math.min(120_000, Math.max(100, Math.floor(value)));
}

function normalizeReplayCacheLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function slackReplayScopeFromRawBody(rawBody: string, providerId: ChannelProviderId): string {
  const fallback = replayScopeSegment(providerId);
  try {
    const value = parseSlackReplayScopeBody(rawBody);
    if (!isRecord(value)) return fallback;
    return replayScopeSegment(value.team_id)
      || replayScopeSegment(isRecord(value.team) ? value.team.id : undefined)
      || replayScopeSegment(value.enterprise_id)
      || fallback;
  } catch {
    return fallback;
  }
}

function parseSlackReplayScopeBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload");
    return payload ? JSON.parse(payload) as unknown : Object.fromEntries(params.entries());
  }
}

function replayScopeSegment(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  let sanitized = "";
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint < 32 || codePoint === 127 || character === ":" ? "_" : character;
    if (sanitized.length >= 256) break;
  }
  return sanitized;
}

function mapSlackPayload(payload: Record<string, unknown>, now: Date, providerId: ChannelProviderId = "slack"): IncomingChannelMessage | null {
  if (payload.type === "event_callback") {
    return mapSlackEvent(objectRecord(payload.event), payload, now, providerId);
  }
  if (payload.type === "block_actions") {
    return mapSlackInteraction(payload, now, providerId);
  }
  return null;
}

function mapSlackEvent(event: Record<string, unknown>, envelope: Record<string, unknown>, now: Date, providerId: ChannelProviderId): IncomingChannelMessage | null {
  if (event.type !== "message" || event.subtype === "bot_message" || stringField(event, "bot_id")) return null;
  const user = stringField(event, "user");
  const channel = stringField(event, "channel");
  const text = stringField(event, "text") || "";
  const ts = stringField(event, "ts") || `${now.getTime()}`;
  if (!user || !channel || !text.trim()) return null;
  const teamId = stringField(envelope, "team_id") || stringField(event, "team");
  return {
    id: stringField(event, "client_msg_id") || `slack-${teamId || "team"}-${channel}-${ts}`,
    providerInstanceId: providerId,
    providerEventId: stringField(envelope, "event_id") || stringField(event, "client_msg_id") || `${channel}:${ts}`,
    providerMessageId: ts,
    provider: providerId,
    providerKind: "slack",
    target: {
      provider: providerId,
      providerKind: "slack",
      chatId: channel,
      threadId: stringField(event, "thread_ts") || ts,
      userId: user,
      messageId: ts
    },
    sender: {
      providerUserId: user,
      username: user,
      displayName: displayNameFromSlackProfile(event),
      isBot: false
    },
    text,
    rawText: text,
    isCommand: text.trimStart().startsWith("/"),
    command: commandName(text),
    commandArgs: commandArgs(text),
    attachments: slackAttachments(event),
    interaction: undefined,
    receivedAt: now,
    raw: envelope
  };
}

function mapSlackInteraction(payload: Record<string, unknown>, now: Date, providerId: ChannelProviderId): IncomingChannelMessage | null {
  const user = objectRecord(payload.user);
  const channel = objectRecord(payload.channel);
  const message = objectRecord(payload.message);
  const actions = Array.isArray(payload.actions) ? payload.actions.map(objectRecord) : [];
  const action = actions[0];
  const token = stringField(action, "value");
  const userId = stringField(user, "id");
  const channelId = stringField(channel, "id");
  const messageTs = stringField(message, "thread_ts") || stringField(message, "ts") || stringField(payload, "message_ts");
  if (!token || !userId || !channelId) return null;
  const id = stringField(payload, "trigger_id") || stringField(action, "action_ts") || randomUUID();
  return {
    id,
    providerInstanceId: providerId,
    providerEventId: id,
    providerMessageId: stringField(message, "ts") ?? null,
    provider: providerId,
    providerKind: "slack",
    target: {
      provider: providerId,
      providerKind: "slack",
      chatId: channelId,
      threadId: messageTs,
      userId,
      messageId: stringField(message, "ts")
    },
    sender: {
      providerUserId: userId,
      username: stringField(user, "username"),
      displayName: stringField(user, "name"),
      isBot: false
    },
    text: "",
    rawText: "",
    isCommand: false,
    attachments: [],
    interaction: {
      id: stringField(action, "action_ts") || stringField(payload, "trigger_id") || randomUUID(),
      token,
      kind: "button"
    },
    receivedAt: now,
    raw: payload
  };
}

function slackAttachments(event: Record<string, unknown>): ChannelAttachment[] {
  const files = Array.isArray(event.files) ? event.files.map(objectRecord) : [];
  return files.map((file) => ({
    providerFileId: stringField(file, "url_private_download") || stringField(file, "url_private") || stringField(file, "id") || undefined,
    filename: stringField(file, "name") || stringField(file, "title") || "slack-file",
    mimeType: stringField(file, "mimetype") || undefined,
    sizeBytes: numberField(file, "size")
  }));
}

function validateSlackButtons(buttons: ChannelButton[][]): void {
  if (buttons.length > 5) throw new Error("Slack buttons exceed maxButtonRowsPerMessage 5.");
  if (buttons.flat().length > 10) throw new Error("Slack buttons exceed maxButtonsPerMessage 10.");
  for (const button of buttons.flat()) {
    if (!button.label.trim()) throw new Error("Slack button label is required.");
    if (Buffer.byteLength(button.token, "utf8") > 2000) throw new Error("Slack button token exceeds maxButtonTokenBytes 2000.");
  }
}

function sentMessage(target: ChannelTarget, messageId: string): SentMessage {
  return {
    provider: target.provider,
    providerKind: target.providerKind ?? "slack",
    chatId: target.chatId,
    threadId: target.threadId || messageId,
    messageId,
    sentAt: new Date()
  };
}

function slackFileMessageTs(response: SlackApiResponse): string | null {
  const shares = response.file?.shares;
  const entries = [
    ...Object.values(shares?.public || {}).flat(),
    ...Object.values(shares?.private || {}).flat()
  ];
  return entries.find((entry) => entry.ts)?.ts || null;
}

async function responseJson(response: Response): Promise<SlackApiResponse> {
  try {
    const parsed = JSON.parse(await response.text());
    return objectRecord(parsed) as SlackApiResponse;
  } catch {
    return {};
  }
}

function displayNameFromSlackProfile(event: Record<string, unknown>): string | null {
  const profile = objectRecord(event.user_profile);
  return stringField(profile, "real_name") || stringField(profile, "display_name") || null;
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

function headerValue(headers: SlackWebhookAuth["headers"], name: string): string | null {
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

function constantTimeStringEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const entry = value[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}
