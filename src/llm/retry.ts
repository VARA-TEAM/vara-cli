/**
 * Retry with exponential backoff for transient provider errors.
 *
 * Only retries on status codes that indicate server-side or rate-limit issues:
 *   429 — rate limited (most common)
 *   500 — internal server error
 *   502 — bad gateway
 *   503 — service unavailable
 *   529 — overloaded (Anthropic-specific)
 *
 * Client errors (400, 401, 403, 404) are never retried — they indicate a real
 * problem that repetition cannot fix.
 */

/** Status codes eligible for retry. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])

export interface RetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number
  /** Initial delay in ms before the first retry (default 1000). */
  baseDelayMs?: number
  /** Maximum delay cap in ms (default 30000). */
  maxDelayMs?: number
  /** Optional AbortSignal to cancel waiting. */
  signal?: AbortSignal
}

/**
 * Compute the delay for a given attempt (exponential with jitter).
 * attempt 0 → baseDelay, attempt 1 → 2*base, attempt 2 → 4*base, etc.
 */
export function retryDelay(attempt: number, opts: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>>): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponential // 0-30% jitter
  return Math.min(exponential + jitter, opts.maxDelayMs)
}

/** Whether a given HTTP status code should trigger a retry. */
export function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

/**
 * Extract the Retry-After header value in milliseconds, if present.
 * Supports both delta-seconds and HTTP-date formats.
 */
export function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/** Sleep that respects AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('Aborted'))
    }, { once: true })
  })
}
