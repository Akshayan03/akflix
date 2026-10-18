/**
 * How skip detection reads audio beside playback. A source that is still
 * arriving (a torrent stream) is read at most `lead` seconds ahead of the
 * playhead, so detection never pulls bytes away from what is about to play;
 * a read that comes back short before the end waited on the source and is
 * retried later rather than mistaken for the end of the file.
 */

import { FP_SAMPLE_RATE } from "./fingerprint";

export type PcmRead = (start: number, seconds: number, signal: AbortSignal) => Promise<Int16Array>;

export interface ReaderOptions {
  read: PcmRead;
  /** Playhead in media seconds. */
  playhead: () => number;
  /** Media duration in seconds; 0 while unknown. */
  duration: () => number;
  /** Whole file readable now (a finished download, a media server). */
  available: () => boolean;
  /** Seconds a still-arriving source may be read ahead of the playhead. */
  lead?: number;
  /** Retry wait after a short read, and how many short reads are tolerated in a row. */
  retryMs?: number;
  retries?: number;
  /** Poll interval while waiting for the playhead. */
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const READ_AHEAD_SECONDS = 150;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Skip analysis stopped", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException("Skip analysis stopped", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function concat(parts: Int16Array[]): Int16Array {
  if (parts.length === 1) return parts[0];
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function gentleReader(options: ReaderOptions): PcmRead {
  const lead = options.lead ?? READ_AHEAD_SECONDS;
  const retryMs = options.retryMs ?? 12_000;
  const retries = options.retries ?? 20;
  const pollMs = options.pollMs ?? 2_000;
  const sleep = options.sleep ?? abortableSleep;

  return async (start, seconds, signal) => {
    const parts: Int16Array[] = [];
    let position = start;
    let left = seconds;
    let shortReads = 0;
    while (left > 0.05) {
      while (!options.available() && options.playhead() < position - lead) {
        await sleep(pollMs, signal);
      }
      const pcm = await options.read(position, left, signal);
      parts.push(pcm);
      const got = pcm.length / FP_SAMPLE_RATE;
      position += got;
      left -= got;
      if (left <= 0.05) break;
      const duration = options.duration();
      // Short at the end of the file (or of a complete one): that is all there is.
      if (options.available() || (duration > 0 && position >= duration - 2)) break;
      if (got > 0.5) shortReads = 0;
      shortReads += 1;
      if (shortReads > retries) {
        throw new Error(`The source stopped delivering audio at ${position.toFixed(0)} s`);
      }
      await sleep(retryMs, signal);
    }
    return concat(parts.length ? parts : [new Int16Array(0)]);
  };
}
