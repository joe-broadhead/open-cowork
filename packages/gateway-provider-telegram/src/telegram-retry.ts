import { cappedBackoffMs as sharedCappedBackoffMs, withRetry } from "@open-cowork/gateway-channel";
import { isRecord } from "@open-cowork/gateway-channel";

export interface TelegramRetryOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (event: TelegramRateLimitEvent) => void | Promise<void>;
}

export interface TelegramRateLimitEvent {
  attempt: number;
  delayMs: number;
}

// Bounded to maxAttempts so a misconfigured attempts value can't spin forever. No
// jitter and no delay clamp, so an explicit Telegram retry_after is honoured verbatim.
export async function withTelegramRetry<T>(
  operation: () => Promise<T>,
  options: TelegramRetryOptions = {},
): Promise<T> {
  return withRetry(operation, {
    attempts: options.attempts,
    defaultAttempts: 3,
    maxAttempts: 10,
    classifyDelayMs: telegramRetryDelayMs,
    sleep: options.sleep,
    onRetry: async (error, _attempt, delayMs) => {
      if (telegramErrorStatus(error) === 429) {
        await options.onRateLimit?.({ attempt: _attempt, delayMs });
      }
    },
  });
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
  return sharedCappedBackoffMs(attempt);
}
