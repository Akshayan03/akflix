/**
 * Seeking for the desktop player's single <video>.
 *
 * Quick repeated skips must add up even while the video, or a converter
 * restart, is still catching up, so every skip starts from where the previous
 * one is heading instead of the position the video still reports.
 *
 * Converted streams restart FFmpeg for targets outside what it has produced.
 * A restart into a part of the torrent that has not downloaded yet can time
 * out on the native side; that is buffering, not a dead source. The same
 * target is retried a few times before the failure is reported, and play
 * then retries it again instead of resuming the replaced stream.
 */
import type { DirectPlaybackRequest } from "@/stores/playbackStore";
import { convertedSeekTime, type SeekableRanges } from "@/lib/compatSeek";

/** Quiet period that merges a burst of skips into one converter restart. */
export const RESTART_DEBOUNCE_MS = 280;
/** Waits before retrying a converter restart that failed transiently. */
export const RESTART_RETRY_DELAYS_MS = [1_500, 4_000] as const;

type Timer = ReturnType<typeof setTimeout>;

export interface SeekVideo {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly seekable: SeekableRanges;
  src: string;
  pause(): void;
  play(): Promise<void>;
  load(): void;
}

export interface SeekHost {
  video(): SeekVideo | null;
  request(): DirectPlaybackRequest | null;
  /** The position and duration the player currently shows. */
  shownPosition(): number;
  shownDuration(): number;
  /** Restart the conversion at `target`; resolves its playlist URL. */
  startConverter(request: DirectPlaybackRequest, target: number): Promise<string | null>;
  sync(patch: { currentTime?: number; buffering?: boolean; isPlaying?: boolean }): void;
  /** A restarted conversion became the video's source. */
  attached(request: DirectPlaybackRequest, target: number): void;
  /** The converter could not reach `target`, even after retrying. */
  failed(request: DirectPlaybackRequest, target: number, reason: string): void;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer | undefined): void;
}

/**
 * Restart failures that mean "not yet": the torrent has not delivered that
 * part, or another start replaced this one. Anything else is final.
 */
export function isTransientConverterFailure(reason: string): boolean {
  return /timed out preparing|could not read this source yet|was replaced/i.test(reason);
}

export function createPlayerSeek(host: SeekHost) {
  // Where the current run of skips is heading, until playback lands there.
  let target: number | null = null;
  // Set while a converter restart is pending: whether to play once it lands.
  let resume: boolean | null = null;
  // The video's conversion was stopped by a restart that has not landed.
  let detached = false;
  let sequence = 0;
  let timer: Timer | undefined;

  const position = () => target ?? host.shownPosition();

  const restart = async (
    run: number,
    request: DirectPlaybackRequest,
    next: number,
    attempt: number
  ) => {
    const current = () =>
      run === sequence && host.request()?.playbackRequestId === request.playbackRequestId;
    const video = host.video();
    const source = request.compatibility;
    if (!current() || !video || !source) return;

    video.pause();
    detached = true;
    let url: string | null = null;
    let failure = "The conversion source is unavailable.";
    try {
      url = await host.startConverter(request, next);
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
    // A newer skip replaced this conversion and reports its own result.
    if (!current()) return;

    if (!url) {
      if (attempt < RESTART_RETRY_DELAYS_MS.length && isTransientConverterFailure(failure)) {
        timer = host.setTimeout(
          () => void restart(run, request, next, attempt + 1),
          RESTART_RETRY_DELAYS_MS[attempt]
        );
        return;
      }
      // Keep the target: the clock stays there and play retries it.
      resume = null;
      host.sync({ currentTime: next, buffering: false, isPlaying: false });
      host.failed(request, next, failure);
      return;
    }

    const play = resume ?? false;
    resume = null;
    detached = false;
    target = null;
    source.startSeconds = next;
    request.url = url;
    video.src = `${url}${url.includes("?") ? "&" : "?"}seek=${Date.now()}`;
    video.load();
    host.attached(request, next);
    if (play) await video.play().catch(() => {});
  };

  const scheduleRestart = (request: DirectPlaybackRequest, next: number, delay: number) => {
    const run = ++sequence;
    host.clearTimeout(timer);
    host.sync({ currentTime: next, buffering: true, isPlaying: resume ?? false });
    timer = host.setTimeout(() => void restart(run, request, next, 0), delay);
  };

  const seek = (seconds: number) => {
    const video = host.video();
    if (!video || !Number.isFinite(seconds)) return;
    const request = host.request();
    const knownDuration =
      request?.durationSeconds ??
      (Number.isFinite(video.duration) ? video.duration : host.shownDuration());
    const next = Math.max(
      0,
      Math.min(seconds, knownDuration > 0 ? Math.max(0, knownDuration - 0.25) : seconds)
    );
    target = next;
    const compatibility = request?.compatibility;
    if (!request || !compatibility) {
      video.currentTime = next;
      host.sync({ currentTime: next });
      return;
    }

    // Skips within what the converter has produced are instant and leave it
    // running; only targets outside it restart the conversion.
    const converted =
      resume === null && !detached
        ? convertedSeekTime(video.seekable, compatibility.startSeconds, next)
        : null;
    if (converted !== null) {
      video.currentTime = converted;
      host.sync({ currentTime: next });
      return;
    }

    // Skips that arrive while a restart is pending find the video already
    // paused by that restart. Keep the intent of the first skip, otherwise
    // a quick double tap leaves playback paused for good.
    if (resume === null) resume = !video.paused && !detached;
    scheduleRestart(request, next, RESTART_DEBOUNCE_MS);
  };

  return {
    seek,
    /** Relative skips add to the target a previous skip is still heading to. */
    seekBy: (delta: number) => seek(position() + delta),
    /**
     * Play/pause while the conversion is being replaced: changes what happens
     * when the restart lands, or retries a target the converter could not
     * reach. Returns false when the caller should toggle the video itself.
     */
    toggle: (): boolean => {
      if (resume !== null) {
        resume = !resume;
        if (!resume) host.video()?.pause();
        host.sync({ isPlaying: resume });
        return true;
      }
      const request = host.request();
      if (!detached || target === null || !request?.compatibility) return false;
      resume = true;
      scheduleRestart(request, target, 0);
      return true;
    },
    /**
     * True while the video still shows a conversion that a restart stopped.
     * Its pause, progress, errors and end are not the user's playback.
     */
    replacing: () => resume !== null || detached,
    /** Where playback is heading, if it has not landed there yet. */
    pendingTarget: () => target,
    /** The video finished a seek: later skips start from where it plays. */
    settle: () => {
      const video = host.video();
      if (resume === null && !detached && video && !video.seeking && video.readyState > 0) {
        target = null;
      }
    },
    /** A new title or teardown: forget every pending seek. */
    reset: () => {
      sequence += 1;
      host.clearTimeout(timer);
      target = null;
      resume = null;
      detached = false;
    },
  };
}

export type PlayerSeek = ReturnType<typeof createPlayerSeek>;
