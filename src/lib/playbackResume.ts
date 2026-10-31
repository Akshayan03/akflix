/**
 * Resuming the desktop player after a pause of any length.
 *
 * A converted (HLS) stream's FFmpeg is stopped (SIGSTOP) while the viewer
 * pauses, so its live playlist stops changing. WebKit reloads an unchanged
 * live playlist about once a second and gives up after roughly half a minute.
 * From then on the paused item is wedged: play reports "playing", ready
 * state stays HAVE_ENOUGH_DATA and nothing is fetched, but the clock never
 * moves again and no waiting, stalled or error event fires. Seeking inside
 * the buffer does not wake it either (owner's VisionQuest S1E6, Oct 30:
 * paused at 16:04 for 2 min 15 s, frozen on play).
 *
 * So after a pause longer than LONG_PAUSE_MS the player starts a fresh
 * conversion at the same position instead of resuming the stale one. That
 * also covers everything else a long pause or a Mac sleep can break: the
 * engine connection FFmpeg held, a VideoToolbox session, a converter that
 * died meanwhile. A frozen-clock watch covers the rest: playing, data
 * buffered, clock not moving.
 */

/** Pauses at least this long resume on a fresh conversion (WebKit gives up on a still playlist after ~28 s). */
export const LONG_PAUSE_MS = 15_000;
/** Playing with frames buffered and a clock that has not moved for this long is a wedged player. */
export const FROZEN_CLOCK_MS = 3_500;
/** After a reconnect, give the new source this long before judging it frozen again. */
export const RECONNECT_GRACE_MS = 10_000;
/** Reconnects in a row without the clock moving; then the stall and error handling take over. */
export const MAX_FROZEN_RECONNECTS = 3;
/** "Reconnecting…" shows only when the reconnect takes longer than this. */
export const RECONNECTING_LABEL_DELAY_MS = 1_000;

export type ResumeKind = "converted" | "direct" | "other";

/** What play should do after a pause that lasted `pausedMs` (wall clock, so a Mac sleep counts). */
export function resumeAction(kind: ResumeKind, pausedMs: number | null): "reconnect" | "play" {
  if (kind !== "converted" || pausedMs === null || !Number.isFinite(pausedMs)) return "play";
  return pausedMs >= LONG_PAUSE_MS ? "reconnect" : "play";
}

export interface ClockSample {
  /** Wall clock, ms. */
  now: number;
  /** Media time, s. */
  time: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  readyState: number;
  /** A seek restart, reread or reconnect owns the element right now. */
  busy: boolean;
}

/**
 * Watches the media clock while the viewer expects playback. Returns true
 * once when the player has frames ready (HAVE_FUTURE_DATA or better), is not
 * paused, seeking or busy, and its clock has not moved for FROZEN_CLOCK_MS.
 * Real buffering (ready state below HAVE_FUTURE_DATA) is not frozen: the
 * stall handling waits for data there.
 */
export function createFrozenClockWatch() {
  let lastTime: number | null = null;
  let stillSince = 0;
  let quietUntil = 0;
  let attempts = 0;

  const reset = (now: number, time: number | null) => {
    lastTime = time;
    stillSince = now;
  };

  return {
    sample(s: ClockSample): boolean {
      const watching = !s.paused && !s.seeking && !s.ended && !s.busy && s.readyState >= 3;
      const moved = lastTime !== null && Math.abs(s.time - lastTime) > 0.05;
      if (moved && watching && s.now >= quietUntil) attempts = 0;
      if (!watching || lastTime === null || moved) {
        reset(s.now, s.time);
        return false;
      }
      if (s.now < quietUntil || s.now - stillSince < FROZEN_CLOCK_MS) return false;
      reset(s.now, s.time);
      if (attempts >= MAX_FROZEN_RECONNECTS) return false;
      attempts += 1;
      return true;
    },
    /** A reconnect started: let the new source settle before judging it. */
    reconnected(now: number) {
      quietUntil = now + RECONNECT_GRACE_MS;
      reset(now, null);
    },
  };
}
