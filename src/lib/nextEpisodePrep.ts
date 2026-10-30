// Early preparation of the next episode's sources, shared by the Next button
// and autoplay so the provider lookup is done (once) before the credits.
//
// Behaviour:
// - One lookup per episode key. Callers during a lookup share its promise.
// - A ready result is reused until it expires (sources and hosted links age).
// - A failure is not cached: the next call retries, but not more often than
//   `retryAfterMs` unless the caller insists (an explicit tap does).
// - Asking for a different key, or cancel(), aborts the previous lookup; its
//   late result is never handed out for another key.
// - Cancelling autoplay does not discard a prepared result: the user can still
//   choose Next and it starts from the same preparation.

export interface NextPreparer<T> {
  /** Start, or join, preparation of `key`. `force` skips the failure backoff. */
  prepare(key: string, run: (signal: AbortSignal) => Promise<T>, options?: { force?: boolean }): Promise<T> | null;
  /** The ready result for `key`, if prepared and fresh. */
  peek(key: string): T | null;
  cancel(): void;
  readonly key: string | null;
}

export function createNextPreparer<T>({
  ttlMs = 20 * 60_000,
  retryAfterMs = 30_000,
  now = () => Date.now(),
}: { ttlMs?: number; retryAfterMs?: number; now?: () => number } = {}): NextPreparer<T> {
  type Entry = {
    key: string;
    controller: AbortController;
    promise: Promise<T>;
    value?: T;
    settledAt?: number;
    failedAt?: number;
  };
  let entry: Entry | null = null;

  const fresh = (candidate: Entry) =>
    candidate.failedAt === undefined && (candidate.settledAt === undefined || now() - candidate.settledAt < ttlMs);

  return {
    prepare(key, run, options = {}) {
      if (entry?.key === key) {
        if (fresh(entry)) return entry.promise;
        if (entry.failedAt !== undefined && !options.force && now() - entry.failedAt < retryAfterMs) return null;
      }
      entry?.controller.abort();
      const controller = new AbortController();
      const current: Entry = { key, controller, promise: Promise.resolve(undefined as T) };
      current.promise = run(controller.signal).then(
        (value) => {
          if (controller.signal.aborted) throw new DOMException("Preparation was replaced.", "AbortError");
          current.value = value;
          current.settledAt = now();
          return value;
        },
        (error) => {
          current.failedAt = now();
          throw error;
        }
      );
      // Background preparation must never surface an unhandled rejection.
      current.promise.catch(() => {});
      entry = current;
      return current.promise;
    },
    peek(key) {
      return entry?.key === key && entry.settledAt !== undefined && fresh(entry) ? entry.value ?? null : null;
    },
    cancel() {
      entry?.controller.abort();
      entry = null;
    },
    get key() {
      return entry?.key ?? null;
    },
  };
}

/**
 * Whether to start preparing the next episode at this point of the current
 * one: inside the last quarter (at least 2, at most 10 minutes); at once for
 * short episodes; after 30 s of playback when the duration is unknown.
 */
export function shouldPrepareNext(position: number, duration: number): boolean {
  if (!Number.isFinite(position)) return false;
  if (!Number.isFinite(duration) || duration <= 0) return position >= 30;
  if (duration <= 240) return true;
  const window = Math.min(600, Math.max(120, duration * 0.25));
  return duration - position <= window;
}
