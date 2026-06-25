// Shared retry primitives for channel-delivery providers. Each provider classifies
// its own protocol errors (webhook HTTP statuses, Telegram error codes, …) but they
// share this loop, backoff curve, jitter, and Retry-After parsing so the behaviour
// cannot drift apart again.

export interface WithRetryOptions {
  // Total attempts including the first. Resolved via boundedPositiveInt(attempts,
  // defaultAttempts) and then clamped to maxAttempts when provided.
  attempts?: number;
  defaultAttempts?: number;
  maxAttempts?: number;
  // Base delay (ms) before the next attempt, given the thrown error and the 1-based
  // number of the attempt that just failed. Return null to stop retrying and rethrow.
  classifyDelayMs: (error: unknown, attempt: number) => number | null;
  // Whether this error's delay should be jittered. Defaults to jitterRatio > 0.
  jitterForError?: (error: unknown) => boolean;
  jitterRatio?: number;
  // Ceiling applied to the (post-jitter) delay when provided. Left unset for callers
  // (e.g. honouring an explicit upstream Retry-After) that must not clamp the delay.
  maxDelayMs?: number;
  // Fired after deciding to retry, before sleeping (e.g. rate-limit telemetry).
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const attempts = resolveAttempts(options);
  const sleep = options.sleep ?? defaultSleep;
  const random = typeof options.random === "function" ? options.random : Math.random;
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const baseDelay = options.classifyDelayMs(error, attempt);
      if (attempt >= attempts || baseDelay === null) {
        throw error;
      }
      const jitter = options.jitterForError
        ? options.jitterForError(error)
        : boundedNonNegativeNumber(options.jitterRatio, 0) > 0;
      const delayMs = jitter
        ? jitteredDelayMs(baseDelay, options, random)
        : clampDelayMs(baseDelay, options.maxDelayMs);
      await options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

function resolveAttempts(options: WithRetryOptions): number {
  const base = boundedPositiveInt(options.attempts, boundedPositiveInt(options.defaultAttempts, 3));
  return typeof options.maxAttempts === "number" && Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? Math.min(options.maxAttempts, base)
    : base;
}

export interface CappedBackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
}

export function cappedBackoffMs(attempt: number, options: CappedBackoffOptions = {}): number {
  const initialDelayMs = boundedPositiveInt(options.initialDelayMs, 1000);
  const maxDelayMs = boundedPositiveInt(options.maxDelayMs, 10_000);
  const factor = boundedNonNegativeNumber(options.factor, 2);
  return Math.min(maxDelayMs, initialDelayMs * factor ** Math.max(0, attempt - 1));
}

export function jitteredDelayMs(
  delayMs: number,
  options: { jitterRatio?: number; maxDelayMs?: number },
  random: () => number = Math.random,
): number {
  const ratio = boundedNonNegativeNumber(options.jitterRatio, 0);
  if (ratio === 0 || delayMs === 0) {
    return clampDelayMs(delayMs, options.maxDelayMs);
  }
  const spread = delayMs * ratio;
  return clampDelayMs(Math.max(0, Math.floor(delayMs - spread + random() * spread * 2)), options.maxDelayMs);
}

function clampDelayMs(delayMs: number, maxDelayMs: number | undefined): number {
  return typeof maxDelayMs === "number" && Number.isFinite(maxDelayMs) ? Math.min(delayMs, maxDelayMs) : delayMs;
}

// Parse an HTTP Retry-After header value (delta-seconds or an HTTP date) into ms.
// `nowMs` is injectable so callers can keep the computation deterministic in tests.
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - nowMs);
  }
  return null;
}

export function boundedPositiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

export function boundedNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
