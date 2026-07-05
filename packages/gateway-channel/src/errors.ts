/**
 * Typed webhook ingress errors shared by the gateway daemons and every channel
 * provider.
 *
 * Webhook handlers used to signal failure with a plain `Error` whose message the
 * gateway then classified with brittle keyword regexes (auth-failure vs payload
 * vs upstream). A wording change in any provider could silently reclassify an
 * authentication failure as a 5xx (or vice-versa). Providers now throw one of
 * these typed errors so the gateways can classify on a stable `code` instead of
 * the human-readable message.
 */
export type ChannelWebhookErrorCode = "auth" | "payload" | "not_found" | "upstream";

export class ChannelWebhookError extends Error {
  readonly code: ChannelWebhookErrorCode;

  constructor(code: ChannelWebhookErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelWebhookError";
    this.code = code;
  }
}

/** Signature/secret/timestamp/replay verification failed → HTTP 401. */
export class WebhookAuthError extends ChannelWebhookError {
  constructor(message: string, options?: ErrorOptions) {
    super("auth", message, options);
    this.name = "WebhookAuthError";
  }
}

/** The request body was malformed/invalid/oversized → HTTP 400. */
export class WebhookPayloadError extends ChannelWebhookError {
  constructor(message: string, options?: ErrorOptions) {
    super("payload", message, options);
    this.name = "WebhookPayloadError";
  }
}

/** No provider is configured for the webhook route → HTTP 404. */
export class WebhookProviderNotFoundError extends ChannelWebhookError {
  constructor(message: string, options?: ErrorOptions) {
    super("not_found", message, options);
    this.name = "WebhookProviderNotFoundError";
  }
}

/**
 * Resolve the stable webhook error code for classification. Returns the code of
 * a {@link ChannelWebhookError} (or any error carrying a matching string `code`),
 * else null so the caller can fall back to a legacy heuristic.
 */
export function channelWebhookErrorCode(error: unknown): ChannelWebhookErrorCode | null {
  if (error instanceof ChannelWebhookError) return error.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "auth" || code === "payload" || code === "not_found" || code === "upstream" ? code : null;
}
