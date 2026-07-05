import {
  boundedPositiveInt,
  cappedBackoffMs as sharedCappedBackoffMs,
  parseRetryAfterMs as sharedParseRetryAfterMs,
  withRetry,
  type WithRetryOptions,
} from "@open-cowork/gateway-channel";

export const defaultWebhookRetryAttempts = 3;
export const defaultWebhookRetryInitialDelayMs = 1000;
export const defaultWebhookRetryMaxDelayMs = 10_000;
export const defaultWebhookRetryJitterRatio = 0.2;
const maxWebhookRetryAttempts = 5;

export interface WebhookRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export async function withWebhookRetry<T>(
  operation: () => Promise<T>,
  options: WebhookRetryOptions = {},
): Promise<T> {
  const retryOptions: WithRetryOptions = {
    attempts: options.attempts,
    defaultAttempts: defaultWebhookRetryAttempts,
    maxAttempts: maxWebhookRetryAttempts,
    classifyDelayMs: (error, attempt) => webhookRetryDelayMs(error, attempt, options),
    jitterForError: shouldJitterWebhookDelay,
    jitterRatio: options.jitterRatio ?? defaultWebhookRetryJitterRatio,
    maxDelayMs: boundedPositiveInt(options.maxDelayMs, defaultWebhookRetryMaxDelayMs),
    sleep: options.sleep,
    random: options.random,
  };
  return withRetry(operation, retryOptions);
}

export function webhookRetryDelayMs(error: unknown, attempt: number, options: WebhookRetryOptions = {}): number | null {
  if (error instanceof WebhookDeliveryTimeoutError || error instanceof WebhookDeliveryNetworkError) {
    return cappedBackoffMs(attempt, options);
  }
  if (error instanceof WebhookCircuitOpenError) {
    return null;
  }
  if (error instanceof WebhookDeliveryError) {
    if (error.status === 429) {
      return error.retryAfterMs === null
        ? cappedBackoffMs(attempt, options)
        : Math.min(error.retryAfterMs, boundedPositiveInt(options.maxDelayMs, defaultWebhookRetryMaxDelayMs));
    }
    if (error.status >= 500 && error.status < 600) {
      return cappedBackoffMs(attempt, options);
    }
  }
  return null;
}

export class WebhookDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`Webhook delivery failed: ${status}`);
  }

  static fromResponse(response: Response): WebhookDeliveryError {
    return new WebhookDeliveryError(
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }
}

export class WebhookDeliveryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Webhook delivery timed out after ${timeoutMs}ms`);
  }
}

export class WebhookDeliveryNetworkError extends Error {
  constructor(readonly cause: unknown) {
    super("Webhook delivery network error");
  }
}

export class WebhookDeliveryPolicyError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export class WebhookDeliveryBodyError extends Error {}

export class WebhookCircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Webhook delivery circuit is open for ${Math.ceil(retryAfterMs)}ms`);
  }
}

export function isRetryableWebhookDeliveryError(error: unknown): boolean {
  if (
    error instanceof WebhookDeliveryTimeoutError ||
    error instanceof WebhookDeliveryNetworkError ||
    error instanceof WebhookCircuitOpenError
  ) {
    return true;
  }
  return error instanceof WebhookDeliveryError && (error.status === 429 || (error.status >= 500 && error.status < 600));
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

export function parseRetryAfterMs(value: string | null): number | null {
  return sharedParseRetryAfterMs(value);
}

function cappedBackoffMs(attempt: number, options: WebhookRetryOptions = {}): number {
  return sharedCappedBackoffMs(attempt, {
    initialDelayMs: options.initialDelayMs ?? defaultWebhookRetryInitialDelayMs,
    maxDelayMs: options.maxDelayMs ?? defaultWebhookRetryMaxDelayMs,
  });
}

function shouldJitterWebhookDelay(error: unknown): boolean {
  return !(error instanceof WebhookDeliveryError && error.status === 429 && error.retryAfterMs !== null);
}
