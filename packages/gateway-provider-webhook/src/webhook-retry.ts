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
  const attempts = Math.min(maxWebhookRetryAttempts, boundedPositiveInt(options.attempts, defaultWebhookRetryAttempts));
  const sleep = options.sleep ?? delay;
  const random = typeof options.random === "function" ? options.random : Math.random;
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const delayMs = webhookRetryDelayMs(error, attempt, options);
      if (attempt >= attempts || delayMs === null) {
        throw error;
      }
      await sleep(jitteredDelayMs(
        delayMs,
        options.jitterRatio,
        random,
        shouldJitterWebhookDelay(error),
        options.maxDelayMs,
      ));
    }
  }
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
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return null;
}

export function boundedPositiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function cappedBackoffMs(attempt: number, options: WebhookRetryOptions = {}): number {
  const initialDelayMs = boundedPositiveInt(options.initialDelayMs, defaultWebhookRetryInitialDelayMs);
  const maxDelayMs = boundedPositiveInt(options.maxDelayMs, defaultWebhookRetryMaxDelayMs);
  return Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
}

function jitteredDelayMs(
  delayMs: number,
  jitterRatio: number | undefined,
  random: () => number,
  enabled: boolean,
  maxDelayMs: number | undefined,
): number {
  const maxMs = boundedPositiveInt(maxDelayMs, defaultWebhookRetryMaxDelayMs);
  if (!enabled) {
    return Math.min(delayMs, maxMs);
  }
  const ratio = boundedNonNegativeNumber(jitterRatio, defaultWebhookRetryJitterRatio);
  if (ratio === 0 || delayMs === 0) {
    return Math.min(delayMs, maxMs);
  }
  const spread = delayMs * ratio;
  return Math.min(maxMs, Math.max(0, Math.floor(delayMs - spread + random() * spread * 2)));
}

function boundedNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function shouldJitterWebhookDelay(error: unknown): boolean {
  return !(error instanceof WebhookDeliveryError && error.status === 429 && error.retryAfterMs !== null);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
