export interface TelegramRetryOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (event: TelegramRateLimitEvent) => void | Promise<void>;
}

export interface TelegramRateLimitEvent {
  attempt: number;
  delayMs: number;
}

export async function withTelegramRetry<T>(
  operation: () => Promise<T>,
  options: TelegramRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? delay;
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const status = telegramErrorStatus(error);
      const delayMs = telegramRetryDelayMs(error, attempt);
      if (attempt >= attempts || delayMs === null) {
        throw error;
      }
      if (status === 429) {
        await options.onRateLimit?.({ attempt, delayMs });
      }
      await sleep(delayMs);
    }
  }
}

export function telegramRetryDelayMs(error: unknown, attempt: number): number | null {
  const status = telegramErrorStatus(error);
  if (status === 429) {
    return telegramRetryAfterMs(error) ?? cappedBackoffMs(attempt);
  }
  if (status && status >= 500 && status < 600) {
    return cappedBackoffMs(attempt);
  }
  return null;
}

function telegramRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const parameters = error.parameters;
  if (isRecord(parameters) && typeof parameters.retry_after === "number") {
    return Math.max(0, parameters.retry_after * 1000);
  }
  return null;
}

function telegramErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const direct = numericStatus(error.error_code) ?? numericStatus(error.status);
  if (direct) {
    return direct;
  }
  const response = error.response;
  return isRecord(response) ? numericStatus(response.status) : null;
}

function numericStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function cappedBackoffMs(attempt: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
