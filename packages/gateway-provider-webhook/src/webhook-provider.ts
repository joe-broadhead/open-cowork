import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type {
  ChannelAttachment,
  ChannelButton,
  ChannelCapabilities,
  ChannelProviderHealth,
  ChannelProviderKind,
  ChannelProviderId,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  OutgoingFile,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";
import { isRecord } from "@open-cowork/gateway-channel";
import { boundedPositiveInt, channelProviderKindFromId, constantTimeStringEqual, normalizeChannelCapabilities, normalizeChannelProviderIdentity, WebhookAuthError } from "@open-cowork/gateway-channel";
import {
  isAbortError,
  isRetryableWebhookDeliveryError,
  parseRetryAfterMs,
  WebhookCircuitOpenError,
  WebhookDeliveryBodyError,
  WebhookDeliveryError,
  WebhookDeliveryNetworkError,
  WebhookDeliveryPolicyError,
  WebhookDeliveryTimeoutError,
  withWebhookRetry
} from "./webhook-retry.js";
import {
  resolveWebhookDeliveryAddresses,
  type ResolvedWebhookAddress,
  type ResolveWebhookHostname,
  validateWebhookDeliveryUrl
} from "./webhook-url-policy.js";

type NodeRequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface WebhookProviderConfig {
  providerId?: ChannelProviderId;
  providerKind?: ChannelProviderKind;
  deliveryUrl: string;
  deliveryUrlAllowedHosts?: readonly string[];
  sharedSecret?: string;
  capabilities?: Partial<ChannelCapabilities>;
  maxSignatureAgeMs?: number;
  maxAttachmentBytes?: number;
  /** Test seam only. The pinned delivery URL replaces the hostname with a resolved IP, so a real fetch cannot perform hostname TLS verification over HTTPS; production deliveries must use the default Node path, which pins the IP via a custom lookup while preserving hostname TLS. */
  fetch?: typeof globalThis.fetch;
  deliveryRequestForTests?: NodeRequestFactory;
  resolveDeliveryHostname?: ResolveWebhookHostname;
  allowPrivateDelivery?: boolean;
  now?: () => Date;
  retryAttempts?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deliveryTimeoutMs?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerCooldownMs?: number;
  legacySharedSecretHeader?: boolean;
  maxSeenIngressSignatures?: number;
  maxSeenIngressSignaturesPerScope?: number;
}

export interface WebhookIncomingPayload {
  id?: string;
  target: {
    chatId: string;
    isDirect?: boolean;
    threadId?: string | null;
    userId?: string | null;
    messageId?: string | null;
  };
  sender: {
    userId: string;
    username?: string | null;
    displayName?: string | null;
    isBot?: boolean;
  };
  text?: string;
  rawText?: string;
  attachments?: WebhookIncomingAttachment[];
  interaction?: {
    id: string;
    token: string;
    kind?: "button" | "command";
  };
  receivedAt?: string;
}

export interface WebhookIncomingAttachment {
  providerFileId?: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  bufferBase64?: string;
}

export interface WebhookIngressAuth {
  headers?: Headers | Record<string, string | string[] | undefined>;
  rawBody?: string;
  verified?: boolean;
}

const maxWebhookAttachments = 20;
const defaultMaxSignatureAgeMs = 5 * 60 * 1000;
const defaultDeliveryTimeoutMs = 15_000;
const maxWebhookDeliveryResponseBytes = 64 * 1024;
const defaultWebhookCircuitBreakerFailureThreshold = 5;
const defaultWebhookCircuitBreakerCooldownMs = 30_000;
const defaultMaxSeenIngressSignatures = 5_000;
const defaultMaxSeenIngressSignaturesPerScope = 1_000;

type SeenWebhookSignature = {
  expiresAt: number;
  scope: string;
};

type WebhookIngressReplayClaim = {
  key: string;
  entry: SeenWebhookSignature;
};

type WebhookCircuitState = {
  failures: number;
  openUntilMs: number;
};

type WebhookDeliveryRequest = {
  deliveryId: string;
  body: string;
};

type SignedWebhookDeliveryRequest = WebhookDeliveryRequest & {
  headers: Record<string, string>;
};

export interface MapWebhookPayloadOptions {
  maxAttachmentBytes?: number;
}

export class WebhookProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind;
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;

  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly seenIngressSignatures = new Map<string, SeenWebhookSignature>();
  private readonly deliveryUrl: URL;
  private circuit: WebhookCircuitState = {
    failures: 0,
    openUntilMs: 0
  };

  constructor(private readonly config: WebhookProviderConfig) {
    this.deliveryUrl = validateWebhookDeliveryUrl(config.deliveryUrl, {
      allowedHosts: config.deliveryUrlAllowedHosts,
      allowPrivateDelivery: config.allowPrivateDelivery
    });
    if (config.sharedSecret !== undefined) {
      validateHeaderValue(config.sharedSecret, "Webhook shared secret");
    }
    const identity = normalizeChannelProviderIdentity(
      config.providerKind ?? channelProviderKindFromId(config.providerId) ?? "webhook",
      config.providerId,
    );
    this.kind = identity.providerKind;
    this.id = identity.providerId;
    const configuredMaxAttachmentBytes = normalizeTimeoutOrByteLimit(config.maxAttachmentBytes);
    const mergedCapabilities = {
      ...defaultWebhookCapabilities,
      ...config.capabilities
    };
    this.capabilities = normalizeChannelCapabilities({
      ...mergedCapabilities,
      maxFileBytes: configuredMaxAttachmentBytes
        ? Math.min(mergedCapabilities.maxFileBytes ?? configuredMaxAttachmentBytes, configuredMaxAttachmentBytes)
        : mergedCapabilities.maxFileBytes
    });
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  health(): ChannelProviderHealth {
    if (this.circuit.openUntilMs <= 0) {
      return {
        ok: true,
        state: "ready",
        error: null
      };
    }
    const nowMs = this.config.now?.().getTime() ?? Date.now();
    if (nowMs >= this.circuit.openUntilMs) {
      return {
        ok: true,
        state: "ready",
        error: null
      };
    }
    return {
      ok: false,
      state: "degraded",
      error: `Webhook delivery circuit is open for ${Math.ceil(this.circuit.openUntilMs - nowMs)}ms`
    };
  }

  async handleWebhookPayload(payload: unknown, auth: WebhookIngressAuth): Promise<void> {
    if (!this.handler) {
      throw new Error("Webhook provider is not started");
    }
    const replayClaim = this.assertIngressAuthorized(auth);
    const message = mapWebhookPayload(payload, this.config.now?.() ?? new Date(), this.id, this.kind, {
      maxAttachmentBytes: this.config.maxAttachmentBytes
    });
    try {
      await this.handler(message);
    } catch (error) {
      if (replayClaim) this.releaseIngressReplayClaim(replayClaim);
      throw error;
    }
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage> {
    validateWebhookText(text, this.capabilities, `${this.id} bridge`);
    return this.deliver({
      type: "text",
      target,
      text,
      options
    });
  }

  async editText(target: ChannelTarget, messageId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.capabilities.messageEditing) {
      throw new Error(`${this.id} bridge does not support message editing`);
    }
    validateWebhookText(text, this.capabilities, `${this.id} bridge`);
    const cleanMessageId = cleanRequiredString(messageId, "Webhook delivery messageId", 512);
    if (!cleanMessageId) {
      throw new Error("Webhook delivery messageId is required");
    }
    await this.deliver({
      type: "edit",
      target,
      messageId: cleanMessageId,
      text,
      options
    });
  }

  async sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage> {
    if (!this.capabilities.fileUploads) {
      throw new Error(`${this.id} bridge does not support outgoing files`);
    }
    if (file.data && file.data.byteLength > (this.capabilities.maxFileBytes ?? defaultWebhookCapabilities.maxFileBytes!)) {
      throw new Error(`${this.id} bridge file exceeds maxFileBytes ${this.capabilities.maxFileBytes}`);
    }
    return this.deliver({
      type: "file",
      target,
      file: serializeOutgoingFile(file)
    });
  }

  async sendButtons(target: ChannelTarget, text: string, buttons: ChannelButton[][], options?: SendOptions): Promise<SentMessage> {
    if (!this.capabilities.inlineButtons) {
      throw new Error(`${this.id} bridge does not support inline buttons`);
    }
    validateWebhookText(text, this.capabilities, `${this.id} bridge`);
    validateWebhookButtons(buttons, this.capabilities);
    return this.deliver({
      type: "buttons",
      target,
      text,
      buttons,
      options
    });
  }

  async answerInteraction(interactionId: string, text?: string, alert?: boolean): Promise<void> {
    const cleanInteractionId = cleanRequiredString(interactionId, "Webhook interaction response id", 512);
    if (!cleanInteractionId) {
      throw new Error("Webhook interaction response id is required");
    }
    await this.deliver({
      type: "answer_interaction",
      interactionId: cleanInteractionId,
      text,
      alert
    });
  }

  async setTyping(target: ChannelTarget): Promise<void> {
    if (!this.capabilities.typingIndicator) {
      throw new Error(`${this.id} bridge does not support typing indicators`);
    }
    await this.deliver({
      type: "typing",
      target
    });
  }

  private async deliver(payload: Record<string, unknown> & { target?: ChannelTarget; options?: SendOptions }): Promise<SentMessage> {
    if (payload.target && payload.target.provider !== this.id) {
      throw new Error(`Webhook bridge ${this.id} cannot deliver target for provider ${payload.target.provider}`);
    }
    const normalizedTarget = payload.target ? normalizeOutboundTarget(payload.target, this.id, this.kind) : undefined;
    const normalizedPayload = normalizedTarget ? { ...payload, target: normalizedTarget } : payload;
    const deliveryId = deliveryIdForPayload(normalizedPayload);
    const body = JSON.stringify({
      deliveryId,
      idempotencyKey: deliveryId,
      provider: this.id,
      providerInstanceId: this.id,
      providerKind: this.kind,
      ...normalizedPayload
    });
    const responseBody = await withWebhookRetry(async () => {
      this.assertCircuitClosed();
      const parsed = await this.fetchDelivery({ deliveryId, body });
      this.recordCircuitSuccess();
      return parsed;
    }, {
      attempts: this.config.retryAttempts,
      initialDelayMs: this.config.retryInitialDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
      jitterRatio: this.config.retryJitterRatio,
      sleep: this.config.sleep,
      random: this.config.random
    }).catch((error) => {
      this.recordCircuitFailure(error);
      throw error;
    });
    const target = normalizedTarget;
    const messageId = cleanOptionalString(responseBody.messageId, "Webhook delivery response.messageId", 512) ?? randomUUID();
    return {
      provider: this.id,
      providerKind: this.kind,
      chatId: target?.chatId ?? "",
      threadId: target?.threadId,
      messageId,
      providerDeliveryId: deliveryId,
      sentAt: new Date()
    };
  }

  private async fetchDelivery(input: WebhookDeliveryRequest): Promise<Record<string, unknown>> {
    const timeoutMs = normalizeDeliveryTimeoutMs(this.config.deliveryTimeoutMs);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new WebhookDeliveryTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      const resolvedAddresses = await Promise.race([
        resolveWebhookDeliveryAddresses(this.deliveryUrl, {
          resolveHostname: this.config.resolveDeliveryHostname,
          allowPrivateDelivery: this.config.allowPrivateDelivery
        }),
        timeoutPromise
      ]);
      const signed = {
        ...input,
        headers: this.deliveryHeaders(input)
      };
      if (this.config.fetch) {
        const attempt = await this.config.fetch(pinnedDeliveryUrl(this.deliveryUrl, resolvedAddresses).toString(), {
          method: "POST",
          headers: {
            ...signed.headers,
            host: this.deliveryUrl.host
          },
          body: signed.body,
          signal: controller.signal,
          // Never auto-follow a redirect: it would re-resolve to an unpinned (possibly
          // private) host and defeat the SSRF address pin. A 3xx surfaces as !ok below.
          redirect: "manual"
        });
        if (!attempt.ok) {
          throw WebhookDeliveryError.fromResponse(attempt);
        }
        return responseJson(attempt);
      }
      return postWebhookDeliveryWithPinnedAddress(this.deliveryUrl, resolvedAddresses, signed, {
        signal: controller.signal,
        request: this.config.deliveryRequestForTests
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new WebhookDeliveryTimeoutError(timeoutMs);
      }
      if (
        error instanceof WebhookDeliveryError ||
        error instanceof WebhookDeliveryTimeoutError ||
        error instanceof WebhookDeliveryBodyError ||
        error instanceof WebhookDeliveryPolicyError
      ) {
        throw error;
      }
      throw new WebhookDeliveryNetworkError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private deliveryHeaders(input: WebhookDeliveryRequest): Record<string, string> {
    const timestamp = String(Math.floor((this.config.now?.().getTime() ?? Date.now()) / 1000));
    const signature = this.config.sharedSecret
      ? signWebhookDeliveryPayload(input.body, this.config.sharedSecret, timestamp)
      : null;
    return {
      "content-type": "application/json",
      "x-open-cowork-gateway-delivery-id": input.deliveryId,
      ...(signature ? {
        "x-open-cowork-gateway-webhook-timestamp": timestamp,
        "x-open-cowork-gateway-webhook-signature": signature
      } : {}),
      ...(this.config.legacySharedSecretHeader && this.config.sharedSecret
        ? { "x-open-cowork-gateway-webhook-secret": this.config.sharedSecret }
        : {})
    };
  }

  private assertCircuitClosed(): void {
    if (this.circuit.openUntilMs <= 0) {
      return;
    }
    const nowMs = this.config.now?.().getTime() ?? Date.now();
    if (nowMs < this.circuit.openUntilMs) {
      throw new WebhookCircuitOpenError(this.circuit.openUntilMs - nowMs);
    }
    this.circuit = {
      failures: 0,
      openUntilMs: 0
    };
  }

  private recordCircuitSuccess(): void {
    if (this.circuit.failures === 0 && this.circuit.openUntilMs === 0) {
      return;
    }
    this.circuit = {
      failures: 0,
      openUntilMs: 0
    };
  }

  private recordCircuitFailure(error: unknown): void {
    if (error instanceof WebhookCircuitOpenError || !isRetryableWebhookDeliveryError(error)) {
      return;
    }
    const threshold = boundedPositiveInt(this.config.circuitBreakerFailureThreshold, defaultWebhookCircuitBreakerFailureThreshold);
    const cooldownMs = boundedPositiveInt(this.config.circuitBreakerCooldownMs, defaultWebhookCircuitBreakerCooldownMs);
    const failures = this.circuit.failures + 1;
    this.circuit = {
      failures,
      openUntilMs: failures >= threshold ? (this.config.now?.().getTime() ?? Date.now()) + cooldownMs : 0
    };
  }

  private assertIngressAuthorized(auth: WebhookIngressAuth): WebhookIngressReplayClaim | null {
    const expectedSecret = this.config.sharedSecret;
    if (auth.verified === true) {
      return null;
    }
    if (!expectedSecret) {
      throw new WebhookAuthError("Webhook shared secret is required for ingress");
    }

    const timestamp = headerValue(auth.headers, "x-open-cowork-gateway-webhook-timestamp");
    const signature = headerValue(auth.headers, "x-open-cowork-gateway-webhook-signature");
    const rawBody = auth.rawBody || "";
    if (!timestamp || !signature || !rawBody) {
      throw new WebhookAuthError("Webhook timestamp signature is required for ingress");
    }
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new WebhookAuthError("Webhook timestamp is invalid");
    }
    const nowMs = this.config.now?.().getTime() ?? Date.now();
    const maxAgeMs = this.config.maxSignatureAgeMs ?? defaultMaxSignatureAgeMs;
    const timestampMs = timestampSeconds * 1000;
    if (Math.abs(nowMs - timestampMs) > maxAgeMs) {
      throw new WebhookAuthError("Webhook timestamp is outside the allowed window");
    }

    const expectedSignature = signWebhookIngressPayload(rawBody, expectedSecret, timestamp);
    if (!constantTimeStringEqual(signature, expectedSignature)) {
      throw new WebhookAuthError("Webhook signature verification failed");
    }
    this.purgeSeenIngressSignatures(nowMs);
    const replayKey = `${timestamp}:${signature}`;
    const existing = this.seenIngressSignatures.get(replayKey);
    if (existing && existing.expiresAt > nowMs) {
      throw new WebhookAuthError("Webhook signature replay rejected");
    }
    const scope = webhookReplayScopeFromRawBody(rawBody, this.id);
    const entry = { expiresAt: nowMs + maxAgeMs, scope };
    this.seenIngressSignatures.set(replayKey, entry);
    this.enforceSeenIngressSignatureScopeLimit(scope);
    this.enforceSeenIngressSignatureGlobalLimit();
    return { key: replayKey, entry };
  }

  private releaseIngressReplayClaim(claim: WebhookIngressReplayClaim): void {
    if (this.seenIngressSignatures.get(claim.key) === claim.entry) {
      this.seenIngressSignatures.delete(claim.key);
    }
  }

  private purgeSeenIngressSignatures(nowMs: number): void {
    for (const [key, { expiresAt }] of this.seenIngressSignatures) {
      if (expiresAt <= nowMs) this.seenIngressSignatures.delete(key);
    }
  }

  private enforceSeenIngressSignatureScopeLimit(scope: string): void {
    const limit = normalizeReplayCacheLimit(this.config.maxSeenIngressSignaturesPerScope, defaultMaxSeenIngressSignaturesPerScope);
    const scopedKeys: string[] = [];
    for (const [key, entry] of this.seenIngressSignatures) {
      if (entry.scope !== scope) continue;
      scopedKeys.push(key);
    }
    while (scopedKeys.length > limit) {
      const oldest = scopedKeys.shift();
      if (!oldest) return;
      this.seenIngressSignatures.delete(oldest);
    }
  }

  private enforceSeenIngressSignatureGlobalLimit(): void {
    const limit = normalizeReplayCacheLimit(this.config.maxSeenIngressSignatures, defaultMaxSeenIngressSignatures);
    while (this.seenIngressSignatures.size > limit) {
      const oldest = this.seenIngressSignatures.keys().next().value;
      if (!oldest) return;
      this.seenIngressSignatures.delete(oldest);
    }
  }
}

export const defaultWebhookCapabilities: ChannelCapabilities = {
  threads: true,
  messageEditing: true,
  inlineButtons: true,
  fileUploads: true,
  fileDownloads: false,
  typingIndicator: true,
  maxTextLength: 4096,
  preferredParseMode: "plain",
  parseModes: ["plain"],
  maxButtonsPerMessage: 8,
  maxButtonRowsPerMessage: 4,
  maxButtonTokenBytes: 64,
  maxFileBytes: 25 * 1024 * 1024,
  inboundFileModes: ["inline_buffer"],
  outboundFileModes: ["inline_buffer"],
  editSemantics: "message",
  interactionAcknowledgement: "optional",
  rateLimitStrategy: "fixed_backoff",
  supportsEphemeralResponses: false
};

export function signWebhookIngressPayload(rawBody: string, sharedSecret: string, timestamp: string): string {
  return `v1=${createHmac("sha256", sharedSecret).update(`v1:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function signWebhookDeliveryPayload(rawBody: string, sharedSecret: string, timestamp: string): string {
  return signWebhookIngressPayload(rawBody, sharedSecret, timestamp);
}

export function mapWebhookPayload(
  payload: unknown,
  now = new Date(),
  providerId: ChannelProviderId = "webhook",
  providerKindOrOptions: ChannelProviderKind | MapWebhookPayloadOptions = channelProviderKindFromId(providerId) ?? "webhook",
  options: MapWebhookPayloadOptions = {},
): IncomingChannelMessage {
  const providerKind = typeof providerKindOrOptions === "string"
    ? providerKindOrOptions
    : channelProviderKindFromId(providerId) ?? "webhook";
  const resolvedOptions = typeof providerKindOrOptions === "string" ? options : providerKindOrOptions;
  const record = requireRecord(payload, "Webhook payload");
  const target = normalizeTarget(record.target);
  const sender = normalizeSender(record.sender);
  const interaction = normalizeInteraction(record.interaction);
  const text = optionalString(record.text) ?? interaction?.token ?? "";
  const rawText = optionalString(record.rawText) ?? text;
  const command = parseWebhookCommand(text);
  const eventId = optionalString(record.id) ?? randomUUID();
  return {
    id: eventId,
    providerInstanceId: providerId,
    providerEventId: eventId,
    providerMessageId: eventId,
    provider: providerId,
    providerKind,
    target: {
      provider: providerId,
      providerKind,
      chatId: target.chatId,
      isDirect: target.isDirect,
      threadId: target.threadId,
      userId: target.userId ?? sender.providerUserId,
      messageId: target.messageId
    },
    sender,
    text,
    rawText,
    isCommand: command !== null,
    command: command?.command,
    commandArgs: command?.args,
    attachments: normalizeAttachments(record.attachments, resolvedOptions),
    interaction,
    receivedAt: parseReceivedAt(record.receivedAt, now),
    raw: payload
  };
}

export function validateWebhookButtons(buttons: ChannelButton[][], capabilities: Pick<ChannelCapabilities, "maxButtonRowsPerMessage" | "maxButtonsPerMessage" | "maxButtonTokenBytes"> = defaultWebhookCapabilities): void {
  const maxRows = capabilities.maxButtonRowsPerMessage ?? 4;
  const maxButtons = capabilities.maxButtonsPerMessage ?? 8;
  const maxTokenBytes = capabilities.maxButtonTokenBytes ?? 64;
  if (buttons.length > maxRows) {
    throw new Error(`Webhook buttons exceed maxButtonRowsPerMessage ${maxRows}`);
  }
  if (buttons.flat().length > maxButtons) {
    throw new Error(`Webhook buttons exceed maxButtonsPerMessage ${maxButtons}`);
  }
  for (const row of buttons) {
    for (const button of row) {
      if (!button.label.trim()) {
        throw new Error("Webhook button label cannot be empty");
      }
      validateInteractionToken(button.token, "Webhook button token");
      if (Buffer.byteLength(button.token, "utf8") > maxTokenBytes) {
        throw new Error(`Webhook button token exceeds maxButtonTokenBytes ${maxTokenBytes}`);
      }
    }
  }
}

function validateWebhookText(text: string, capabilities: Pick<ChannelCapabilities, "maxTextLength">, label: string): void {
  if (text.length > capabilities.maxTextLength) {
    throw new Error(`${label} text exceeds maxTextLength ${capabilities.maxTextLength}`);
  }
}

function normalizeOutboundTarget(target: ChannelTarget, provider: ChannelProviderId, providerKind: ChannelProviderKind): ChannelTarget {
  const chatId = cleanRequiredString(target.chatId, "Webhook delivery target.chatId", 512);
  if (!chatId) {
    throw new Error("Webhook delivery target.chatId is required");
  }
  return {
    provider,
    providerKind,
    chatId,
    isDirect: target.isDirect === true,
    threadId: cleanOptionalString(target.threadId, "Webhook delivery target.threadId", 512) ?? null,
    userId: cleanOptionalString(target.userId, "Webhook delivery target.userId", 512) ?? null,
    messageId: cleanOptionalString(target.messageId, "Webhook delivery target.messageId", 512) ?? null
  };
}

function normalizeTarget(value: unknown): {
  chatId: string;
  isDirect?: boolean;
  threadId?: string | null;
  userId?: string | null;
  messageId?: string | null;
} {
  const record = requireRecord(value, "Webhook target");
  const chatId = cleanRequiredString(record.chatId, "Webhook target.chatId", 512);
  if (!chatId) {
    throw new Error("Webhook target.chatId is required");
  }
  return {
    chatId,
    isDirect: record.isDirect === true,
    threadId: cleanOptionalString(record.threadId, "Webhook target.threadId", 512) ?? null,
    userId: cleanOptionalString(record.userId, "Webhook target.userId", 512) ?? null,
    messageId: cleanOptionalString(record.messageId, "Webhook target.messageId", 512) ?? null
  };
}

function normalizeSender(value: unknown): IncomingChannelMessage["sender"] {
  const record = requireRecord(value, "Webhook sender");
  const providerUserId = cleanRequiredString(record.userId, "Webhook sender.userId", 512);
  if (!providerUserId) {
    throw new Error("Webhook sender.userId is required");
  }
  return {
    providerUserId,
    username: cleanOptionalString(record.username, "Webhook sender.username", 256) ?? null,
    displayName: cleanOptionalString(record.displayName, "Webhook sender.displayName", 512) ?? null,
    isBot: record.isBot === true
  };
}

function normalizeInteraction(value: unknown): IncomingChannelMessage["interaction"] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requireRecord(value, "Webhook interaction");
  const id = cleanOptionalString(record.id, "Webhook interaction.id", 512);
  const token = optionalString(record.token);
  if (!id || !token) {
    throw new Error("Webhook interaction requires id and token");
  }
  validateInteractionToken(token, "Webhook interaction.token");
  return {
    id,
    token,
    kind: record.kind === "command" ? "command" : "button"
  };
}

function normalizeAttachments(value: unknown, options: MapWebhookPayloadOptions): ChannelAttachment[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Webhook attachments must be an array");
  }
  if (value.length > maxWebhookAttachments) {
    throw new Error(`Webhook attachments cannot exceed ${maxWebhookAttachments} files`);
  }
  return value.map((item) => {
    const record = requireRecord(item, "Webhook attachment");
    const filename = cleanOptionalString(record.filename, "Webhook attachment.filename", 255);
    if (!filename) {
      throw new Error("Webhook attachment.filename is required");
    }
    const sizeBytes = normalizeAttachmentSize(record.sizeBytes);
    if (sizeBytes !== undefined) {
      validateAttachmentSizeLimit(sizeBytes, options.maxAttachmentBytes);
    }
    const bufferBase64 = optionalString(record.bufferBase64);
    const buffer = bufferBase64 ? decodeWebhookBase64(bufferBase64, options.maxAttachmentBytes) : undefined;
    if (buffer) {
      validateAttachmentSizeLimit(buffer.byteLength, options.maxAttachmentBytes);
    }
    if (buffer && sizeBytes !== undefined && buffer.byteLength !== sizeBytes) {
      throw new Error("Webhook attachment.sizeBytes does not match decoded buffer length");
    }
    return {
      providerFileId: cleanOptionalString(record.providerFileId, "Webhook attachment.providerFileId", 512),
      filename,
      mimeType: cleanOptionalString(record.mimeType, "Webhook attachment.mimeType", 255),
      sizeBytes,
      buffer
    };
  });
}

function validateAttachmentSizeLimit(sizeBytes: number, maxAttachmentBytes: number | undefined): void {
  if (maxAttachmentBytes === undefined) {
    return;
  }
  const maxBytes = Math.max(0, Math.floor(maxAttachmentBytes));
  if (sizeBytes > maxBytes) {
    throw new Error(`Webhook attachment exceeds max size of ${maxBytes} bytes`);
  }
}

function normalizeTimeoutOrByteLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeReplayCacheLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeDeliveryTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return defaultDeliveryTimeoutMs;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return defaultDeliveryTimeoutMs;
  }
  return Math.min(120_000, Math.max(100, Math.floor(value)));
}

function validateInteractionToken(token: string, label: string): void {
  if (!token) {
    throw new Error(`${label} cannot be empty`);
  }
  validateHeaderValue(token, label);
  if (Buffer.byteLength(token, "utf8") > 64) {
    throw new Error(`${label} cannot exceed 64 bytes`);
  }
}

function webhookReplayScopeFromRawBody(rawBody: string, providerId: ChannelProviderId): string {
  const fallback = replayScopeSegment(providerId);
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (!isRecord(value)) return fallback;
    const target = isRecord(value.target) ? value.target : null;
    const chatId = replayScopeSegment(optionalString(target?.chatId));
    if (!chatId) return fallback;
    const threadId = replayScopeSegment(optionalString(target?.threadId));
    return threadId ? `${fallback}:${chatId}:${threadId}` : `${fallback}:${chatId}`;
  } catch {
    return fallback;
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

function validateHeaderValue(value: string, label: string): void {
  if (containsControlCharacter(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
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


function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function normalizeAttachmentSize(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Webhook attachment.sizeBytes must be a non-negative integer");
  }
  return value;
}

function decodeWebhookBase64(value: string, maxAttachmentBytes: number | undefined): Uint8Array {
  const compact = value.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
    throw new Error("Webhook attachment.bufferBase64 must be valid base64");
  }
  validateAttachmentSizeLimit(estimatedDecodedBase64Bytes(compact), maxAttachmentBytes);
  const buffer = Buffer.from(compact, "base64");
  const normalizedInput = compact.replace(/=+$/u, "");
  const normalizedOutput = buffer.toString("base64").replace(/=+$/u, "");
  if (normalizedInput !== normalizedOutput) {
    throw new Error("Webhook attachment.bufferBase64 must be valid base64");
  }
  return Uint8Array.from(buffer);
}

function estimatedDecodedBase64Bytes(compactBase64: string): number {
  if (!compactBase64) {
    return 0;
  }
  const padding = compactBase64.endsWith("==") ? 2 : compactBase64.endsWith("=") ? 1 : 0;
  return Math.floor(compactBase64.length * 3 / 4) - padding;
}

function parseWebhookCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [head, ...args] = trimmed.slice(1).split(/\s+/);
  const command = head?.split("@")[0]?.toLowerCase();
  if (!command || !/^[a-z][a-z0-9_-]*$/.test(command)) {
    return null;
  }
  return { command, args: args.join(" ") };
}

function parseReceivedAt(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function serializeOutgoingFile(file: OutgoingFile): Record<string, unknown> {
  const filename = cleanRequiredString(file.filename, "Webhook outgoing file.filename", 255);
  if (!filename) {
    throw new Error("Webhook outgoing file.filename is required");
  }
  if (!file.data) {
    throw new Error("Webhook file delivery requires inline data; local paths are not exposed to bridge providers");
  }
  return {
    filename,
    mimeType: cleanOptionalString(file.mimeType, "Webhook outgoing file.mimeType", 255),
    dataBase64: Buffer.from(file.data).toString("base64")
  };
}

function deliveryIdForPayload(payload: { options?: SendOptions }): string {
  return cleanOptionalString(payload.options?.deliveryId, "Webhook delivery options.deliveryId", 512) ?? randomUUID();
}

async function postWebhookDeliveryWithPinnedAddress(
  url: URL,
  resolvedAddresses: ResolvedWebhookAddress[],
  input: SignedWebhookDeliveryRequest,
  options: { signal: AbortSignal; request?: NodeRequestFactory },
): Promise<Record<string, unknown>> {
  const pinned = resolvedAddresses[0];
  if (!pinned?.address || !pinned.family) {
    throw new WebhookDeliveryPolicyError("Webhook delivery URL host cannot be resolved");
  }
  const requestFactory = options.request ?? (url.protocol === "http:" ? httpRequest : httpsRequest);
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: "POST",
      agent: false,
      signal: options.signal,
      headers: {
        ...input.headers,
        "content-length": String(Buffer.byteLength(input.body, "utf8"))
      },
      lookup: pinnedLookup(url, pinned, "Webhook delivery URL") as unknown as RequestOptions["lookup"]
    };
    const request = requestFactory(url, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 299) {
        response.resume();
        reject(new WebhookDeliveryError(status, parseRetryAfterMs(firstHeaderValue(response.headers["retry-after"]) ?? null)));
        return;
      }
      nodeResponseJson(response).then(resolve, reject);
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

function pinnedDeliveryUrl(url: URL, resolvedAddresses: ResolvedWebhookAddress[]): URL {
  const pinned = resolvedAddresses[0];
  if (!pinned?.address || !pinned.family) {
    throw new WebhookDeliveryPolicyError("Webhook delivery URL host cannot be resolved");
  }
  const next = new URL(url.toString());
  const host = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
  next.host = url.port ? `${host}:${url.port}` : host;
  return next;
}

function pinnedLookup(url: URL, pinned: ResolvedWebhookAddress, label: string) {
  return (
    hostname: string,
    lookupOptions: unknown,
    callback: PinnedLookupCallback,
  ): void => {
    if (normalizeHostnameForPolicy(hostname) !== normalizeHostnameForPolicy(url.hostname)) {
      callback(new Error(`${label} host changed during request`));
      return;
    }
    if (isRecord(lookupOptions) && lookupOptions.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

type PinnedLookupCallback = {
  (error: Error | null, address?: string, family?: number): void;
  (error: Error | null, addresses?: ResolvedWebhookAddress[]): void;
};

function normalizeHostnameForPolicy(value: unknown): string {
  return String(value).trim().replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
}

function firstHeaderValue(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(Array.isArray(value) ? value[0] : value);
}

async function nodeResponseJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = firstHeaderValue(response.headers["content-length"]);
  if (contentLength) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > maxWebhookDeliveryResponseBytes) {
      response.resume();
      throw new WebhookDeliveryBodyError(`Webhook delivery response cannot exceed ${maxWebhookDeliveryResponseBytes} bytes`);
    }
  }
  const bytes = await readBoundedNodeResponseBytes(response, maxWebhookDeliveryResponseBytes);
  if (bytes.byteLength === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readBoundedNodeResponseBytes(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response) {
    const value = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
    total += value.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new WebhookDeliveryBodyError(`Webhook delivery response cannot exceed ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > maxWebhookDeliveryResponseBytes) {
      throw new WebhookDeliveryBodyError(`Webhook delivery response cannot exceed ${maxWebhookDeliveryResponseBytes} bytes`);
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxWebhookDeliveryResponseBytes) {
    throw new WebhookDeliveryBodyError(`Webhook delivery response cannot exceed ${maxWebhookDeliveryResponseBytes} bytes`);
  }
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanRequiredString(value: unknown, label: string, maxBytes: number): string | undefined {
  return cleanOptionalString(value, label, maxBytes);
}

function cleanOptionalString(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  validateHeaderValue(trimmed, label);
  const bytes = Buffer.byteLength(trimmed, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} cannot exceed ${maxBytes} bytes`);
  }
  return trimmed;
}
