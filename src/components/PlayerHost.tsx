/**
 * PlayerHost — the persistent playback engine, mounted ONCE in App.
 *
 * Owns the single <video> element so playback survives navigation:
 *   - mode "expanded": immersive full-screen player with animated controls
 *   - mode "mini":     floating PiP video + <MiniPlayer/> bottom bar
 *
 * Also owns: PlaybackInfo negotiation (direct-play vs HLS via hls.js),
 * subtitle tracks, next-episode lookup, Jellyfin progress reporting, and
 * global keyboard shortcuts (Space/K, ←/→, F, M, Esc).
 *
 * Pages start playback with usePlayback().open(itemId); the /play/:id route
 * is just a thin shim over this component.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type Hls from "hls.js";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Check,
  Gauge,
  LoaderCircle,
  Maximize,
  Minus,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  SkipForward,
  Subtitles,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth, useJellyfinClient } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import { usePlayback } from "@/stores/playbackStore";
import type {
  DirectEpisodeTarget,
  DirectPlaybackRequest,
  PlaybackSession,
} from "@/stores/playbackStore";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import { formatClock, ticksToSeconds } from "@/lib/utils";
import { isAppleMobile } from "@/lib/platform";
import { mediaDisplayFromRelease } from "@/lib/mediaTitle";
import {
  cuesToVtt,
  estimateCaptionOffset,
  inferredCaptionRanges,
  loadManualCaption,
  mergeCaptionRanges,
  offsetSubtitle,
  parseVttCues,
  removeManualCaption,
  saveManualCaption,
  sequentialCues,
  type CaptionCue,
  type ManualCaption,
} from "@/lib/manualCaptions";
import { captionFrame, showOnlyCaptionTrack } from "@/lib/captionDisplay";
import { transcribeCaptionChunk } from "@/lib/liveCaptions";
import { httpRaw } from "@/lib/http";
import {
  setCompatibilityStreamPaused,
  startCompatibilityStream,
  startCompatibilityStreamUrl,
} from "@/lib/compatStream";
import { createPlayerSeek } from "@/lib/playerSeek";
import { iosNativeSources } from "@/lib/iosSourceCompatibility";
import { automaticSafeSources } from "@/lib/sourceLanguage";
import { directSubtitleTracks } from "@/api/subtitles";
import MiniPlayer from "@/components/MiniPlayer";
import SkipControls, { type SkipNotice } from "@/components/SkipControls";
import { openingWindow } from "@/lib/skip/detector";
import { desktopSkipReader } from "@/lib/skip/desktopSource";
import {
  markersFromJellyfinSegments,
  skipView,
  sourceKey,
  type SkipMarkers,
  type SkippableKind,
} from "@/lib/skip/markers";
import { useSkipMarkers, type SkipSubject } from "@/lib/skip/useSkipMarkers";
import type { MediaSource, MediaStream } from "@/types/jellyfin";
import { useHistory, type HistoryTitle } from "@/stores/historyStore";

const PROGRESS_INTERVAL_MS = 10_000;
const LOCAL_HISTORY_INTERVAL_MS = 5_000;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const SEEK_SECONDS = 10;
const MANUAL_SUBTITLE_INDEX = 900_000;
/**
 * A torrent stream that has shown no picture by then moves on to the next
 * ranked source (the conversion gets longer: FFmpeg has to start first).
 */
export const FIRST_FRAME_LIMIT_MS = 45_000;
export const COMPATIBILITY_FIRST_FRAME_LIMIT_MS = 75_000;

interface SubTrack {
  index: number;
  label: string;
  language?: string;
  url: string;
  manual?: boolean;
  vtt?: string;
}

type WebKitVideoElement = HTMLVideoElement & {
  webkitPresentationMode?: "inline" | "fullscreen" | "picture-in-picture";
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "fullscreen" | "picture-in-picture") => void;
};

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)
  );
};

function rememberVolume(volume: number) {
  try {
    localStorage.setItem("akflix.player.volume", String(volume));
  } catch {
    // Playback still works when storage is unavailable.
  }
}

function applyPlaybackRate(video: HTMLVideoElement, rate: number) {
  const safeRate = Math.max(0.5, Math.min(2, rate));
  video.defaultPlaybackRate = safeRate;
  video.playbackRate = safeRate;
}

function manualCaptionKey(
  session: PlaybackSession | null,
  request: DirectPlaybackRequest | null
): string | null {
  if (!session) return null;
  if (request?.catalogId) {
    return [
      request.mediaType ?? "video",
      request.catalogId,
      request.season ?? 0,
      request.episode ?? 0,
    ].join(":");
  }
  return `${session.direct ? "direct" : "jellyfin"}:${session.itemId}`;
}

function directHistoryTitle(request: DirectPlaybackRequest): HistoryTitle | null {
  if (!request.catalogId || !request.mediaType) return null;
  return {
    source: "discover",
    id: request.catalogId,
    type: request.mediaType,
    name: request.title,
    poster: request.posterUrl,
    background: request.backgroundUrl,
    description: request.description,
    releaseInfo: request.releaseInfo,
    year: request.year,
    imdbRating: request.catalogRating,
    genres: request.genres,
  };
}

function saveDirectProgress(
  request: DirectPlaybackRequest | null,
  video: HTMLVideoElement | null,
  completed = false,
  position?: number
) {
  if (!request || !video) return;
  const media = directHistoryTitle(request);
  if (!media) return;
  const currentTime =
    position ??
    (request.compatibility
      ? request.compatibility.startSeconds + video.currentTime
      : video.currentTime);
  const duration =
    request.durationSeconds && request.durationSeconds > 0
      ? request.durationSeconds
      : video.duration;
  useHistory.getState().recordProgress(media, currentTime, duration, {
    subtitle: request.subtitle,
    season: request.season,
    episode: request.episode,
    completed,
  });
}

/** Background skip detection for one playing file (see lib/skip). */
function desktopSkipSubject(options: {
  key: string;
  show: string;
  season: number;
  episode: number;
  /** Stable identity of the exact file (hashed before it is stored). */
  file: string;
  input: string;
  isEpisode: boolean;
  audioLanguage: string;
  known?: (signal: AbortSignal, duration: number) => Promise<SkipMarkers>;
}): SkipSubject {
  const playhead = () => usePlayback.getState().currentTime;
  const reader = desktopSkipReader({
    owner: options.key,
    input: options.input,
    audioLanguage: options.audioLanguage,
    fingerprint: options.isEpisode,
    // Streams and media servers alike are read beside playback, never far ahead.
    available: () => false,
    playhead,
    duration: () => usePlayback.getState().duration,
    known: options.known ? (signal) => options.known!(signal, reader.duration()) : undefined,
  });
  return {
    key: options.key,
    identity: {
      show: options.show,
      season: options.season,
      episode: options.episode,
      source: sourceKey(options.file),
    },
    adapter: reader.adapter,
    duration: reader.duration,
    playhead,
    // Resumed past the opening: no Skip Intro to offer, and no reason to read it.
    wantIntro: () => playhead() < openingWindow(reader.duration()) - 30,
  };
}

const AUTO_SKIP_NOTICE_MS = 6_000;

function queueDirectEpisodeProgress(
  request: DirectPlaybackRequest | null,
  next: DirectEpisodeTarget | undefined
) {
  if (!request || !next) return;
  const media = directHistoryTitle(request);
  if (!media || media.type !== "series") return;
  useHistory.getState().recordProgress(media, 0, 0, {
    subtitle: `S${next.season} E${next.episode} · ${next.title}`,
    season: next.season,
    episode: next.episode,
    upNext: true,
  });
}

export default function PlayerHost() {
  const t = useT();
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();
  // Memoized per profile — safe for effect deps (a fresh-per-render client
  // here caused an infinite re-register loop with the controls effect).
  const client = useJellyfinClient();
  const subtitleLanguage = useSettings((s) => s.subtitleLanguage);
  const autoSkipIntro = useSettings((s) => s.autoSkipIntro);
  const preferredAudioLanguage = useSettings((s) => s.audioLanguage);
  const activeStreamHash = useTorrents((s) => s.activeStreamHash);
  const finishActiveStream = useTorrents((s) => s.finishActiveStream);

  const {
    requestedItemId,
    requestedDirect,
    session,
    mode,
    isPlaying,
    muted,
    volume,
    currentTime,
    duration,
    buffering,
    hasNext,
    playbackRate,
    _setSession,
    _setControls,
    _sync,
    stop,
  } = usePlayback();

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const jfSessionRef = useRef<{
    itemId: string;
    mediaSourceId: string;
    playSessionId: string;
  } | null>(null);
  const nextEpisodeRef = useRef<string | null>(null);
  const directIdRef = useRef<number | null>(null);
  const directRequestRef = useRef<DirectPlaybackRequest | null>(null);
  const compatibilityFallbackRef = useRef<DirectPlaybackRequest | null>(null);
  const firstFrameTimer = useRef<ReturnType<typeof setTimeout>>();
  /** The direct request whose first picture has been decoded. */
  const pictureShownRef = useRef<DirectPlaybackRequest | null>(null);
  const requestedPlaybackRateRef = useRef(usePlayback.getState().playbackRate);
  const bufferingIndicatorTimer = useRef<ReturnType<typeof setTimeout>>();
  const playbackStallTimer = useRef<ReturnType<typeof setTimeout>>();
  const playbackStallOpen = useRef(false);
  // Position a stuck direct stream is being reloaded at, until its metadata
  // loads (see rereadDirectSource); and whether that reload's canplay is due.
  const rereadingRef = useRef<number | null>(null);
  const rereadCanPlayRef = useRef(false);
  const directResumeAppliedRef = useRef<number | null>(null);
  const lastLocalHistoryWrite = useRef(0);
  const loadSeq = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const seekFeedbackTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrubTimeRef = useRef<number | null>(null);
  const scrubPointerActiveRef = useRef(false);
  const controlsBarRef = useRef<HTMLDivElement>(null);
  const manualCaptionRef = useRef<ManualCaption | null>(null);
  const subtitleBlobUrlsRef = useRef<string[]>([]);
  const captionInputRef = useRef<string | null>(null);
  const captionGenerationRef = useRef(0);

  const [subTracks, setSubTracks] = useState<SubTrack[]>([]);
  const [playbackSubTracks, setPlaybackSubTracks] = useState<SubTrack[]>([]);
  const [activeSub, setActiveSub] = useState(-1);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [bufferedUntil, setBufferedUntil] = useState(0);
  const [seekFeedback, setSeekFeedback] = useState<number | null>(null);
  const [manualCaption, setManualCaption] = useState<ManualCaption | null>(null);
  const [manualTrack, setManualTrack] = useState<SubTrack | null>(null);
  const [captionTask, setCaptionTask] = useState<"generating" | "syncing" | null>(null);
  const [compatibilityStartSeconds, setCompatibilityStartSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Skip Intro / Recap and the credits card.
  const [skipSubject, setSkipSubject] = useState<SkipSubject | null>(null);
  const skipMarkers = useSkipMarkers(skipSubject);
  const [skipNotice, setSkipNotice] = useState<SkipNotice | null>(null);
  const [creditsDismissed, setCreditsDismissed] = useState(false);
  const [nextTitle, setNextTitle] = useState<string | undefined>(undefined);
  const skipTimeRef = useRef<number | null>(null);
  const autoSkippedRef = useRef(new Set<SkippableKind>());
  const skipDismissedRef = useRef(new Set<SkippableKind>());
  const skipNoticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const skipActionsRef = useRef<{ skip: (() => void) | null; next: (() => void) | null }>({ skip: null, next: null });

  // Skips, converter restarts and their retries. Created once: it reads the
  // live video, request and store through refs.
  const [seeker] = useState(() =>
    createPlayerSeek({
      video: () => videoRef.current,
      request: () => directRequestRef.current,
      shownPosition: () => usePlayback.getState().currentTime,
      shownDuration: () => usePlayback.getState().duration,
      startConverter: async (request, target) => {
        const source = request.compatibility;
        if (source?.inputUrl) {
          return startCompatibilityStreamUrl(
            source.inputUrl,
            source.streamId,
            source.audioLanguage,
            target
          );
        }
        if (source?.filename) {
          return startCompatibilityStream(
            source.filename,
            source.streamId,
            source.audioLanguage,
            target
          );
        }
        return null;
      },
      sync: (patch) => usePlayback.getState()._sync(patch),
      attached: (_request, target) => {
        setCompatibilityStartSeconds(target);
        setError(null);
        const video = videoRef.current;
        if (!video) return;
        applyPlaybackRate(video, requestedPlaybackRateRef.current);
        video.volume = usePlayback.getState().volume;
        video.muted = usePlayback.getState().muted;
      },
      failed: (request, target, reason) => {
        // History keeps the point the viewer asked for, not the old one.
        saveDirectProgress(request, videoRef.current, false, target);
        toast.error("Could not jump to that point", {
          description: `${reason.replace(/\.?$/, ".")} Press play to try ${formatClock(target)} again.`,
        });
      },
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    })
  );

  // ── Controls auto-hide ───────────────────────────────────────────────
  const poke = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // Keep controls up while paused, scrubbing, or using a menu.
      const v = videoRef.current;
      if (
        v &&
        !v.paused &&
        scrubTimeRef.current === null &&
        !subMenuOpen &&
        !speedMenuOpen
      ) {
        setControlsVisible(false);
      }
    }, 3000);
  }, [speedMenuOpen, subMenuOpen]);

  useEffect(() => {
    if (mode === "expanded") poke();
    return () => clearTimeout(hideTimer.current);
  }, [mode, poke]);

  // ── Teardown helpers ─────────────────────────────────────────────────

  const reportStopped = useCallback(() => {
    const v = videoRef.current;
    clearTimeout(bufferingIndicatorTimer.current);
    clearTimeout(playbackStallTimer.current);
    seeker.reset();
    clearTimeout(seekFeedbackTimer.current);
    playbackStallOpen.current = false;
    rereadingRef.current = null;
    rereadCanPlayRef.current = false;
    scrubPointerActiveRef.current = false;
    const s = jfSessionRef.current;
    if (client && v && s) {
      client
        .reportStopped(s.itemId, s.mediaSourceId, s.playSessionId, v.currentTime)
        .catch(() => {});
    }
    jfSessionRef.current = null;
  }, [client, seeker]);

  const teardown = useCallback(() => {
    setSkipSubject(null);
    setSkipNotice(null);
    clearTimeout(skipNoticeTimer.current);
    setCreditsDismissed(false);
    setNextTitle(undefined);
    skipTimeRef.current = null;
    autoSkippedRef.current = new Set();
    skipDismissedRef.current = new Set();
    captionGenerationRef.current += 1;
    captionInputRef.current = null;
    setCaptionTask(null);
    setCompatibilityStartSeconds(0);
    saveDirectProgress(
      directRequestRef.current,
      videoRef.current,
      false,
      seeker.pendingTarget() ?? undefined
    );
    directRequestRef.current = null;
    reportStopped();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    subtitleBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    subtitleBlobUrlsRef.current = [];
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  }, [reportStopped, seeker]);

  // ── Core: load an item into the video element ────────────────────────

  const load = useCallback(
    async (itemId: string) => {
      if (!client) return;
      const video = videoRef.current;
      if (!video) return;
      const seq = ++loadSeq.current;

      teardown();
      directIdRef.current = null;
      setError(null);
      setSubTracks([]);
      setActiveSub(-1);
      setBufferedUntil(0);
      setScrubTime(null);
      setSeekFeedback(null);
      scrubTimeRef.current = null;
      scrubPointerActiveRef.current = false;
      nextEpisodeRef.current = null;
      _sync({ buffering: true, hasNext: false, currentTime: 0, duration: 0 });

      try {
        const item = await client.item(itemId);
        if (seq !== loadSeq.current) return;

        const startAt = ticksToSeconds(item.UserData?.PlaybackPositionTicks);
        const info = await client.playbackInfo(itemId, startAt);
        if (seq !== loadSeq.current) return;
        if (info.ErrorCode) throw new Error(`Playback error: ${info.ErrorCode}`);

        const source = info.MediaSources[0];
        if (!source) throw new Error("No playable media source.");
        jfSessionRef.current = {
          itemId,
          mediaSourceId: source.Id,
          playSessionId: info.PlaySessionId,
        };

        const isEpisode = item.Type === "Episode";
        _setSession({
          itemId,
          title: isEpisode ? item.SeriesName ?? item.Name : item.Name,
          subtitle: isEpisode
            ? `S${item.ParentIndexNumber ?? 1}:E${item.IndexNumber ?? 1} · ${item.Name}`
            : undefined,
          posterUrl: client.imageUrl(item, "Primary", 200),
          isEpisode,
        });

        // Subtitle tracks (text/external only — deliverable as WebVTT).
        const subs: SubTrack[] = (source.MediaStreams ?? [])
          .filter(
            (s: MediaStream) =>
              s.Type === "Subtitle" && (s.IsTextSubtitleStream || s.IsExternal)
          )
          .map((s) => ({
            index: s.Index,
            label: s.DisplayTitle ?? s.Language ?? `Track ${s.Index}`,
            language: s.Language,
            url: client.subtitleUrl(itemId, source.Id, s.Index),
          }));
        setSubTracks(subs);
        const preferred = subs.find((s) => s.language === subtitleLanguage);
        if (preferred) setActiveSub(preferred.index);

        // Resolve the next episode (for the Next button / auto-advance).
        if (isEpisode && item.SeriesId) {
          client
            .episodes(item.SeriesId)
            .then((r) => {
              if (seq !== loadSeq.current) return;
              const ordered = [...r.Items].sort(
                (a, b) =>
                  (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) ||
                  (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0)
              );
              const i = ordered.findIndex((episode) => episode.Id === itemId);
              const next = i >= 0 ? ordered[i + 1] : undefined;
              nextEpisodeRef.current = next?.Id ?? null;
              setNextTitle(
                next ? `S${next.ParentIndexNumber ?? 1} E${next.IndexNumber ?? 1} · ${next.Name}` : undefined
              );
              _sync({ hasNext: !!next });
            })
            .catch(() => {});
        }

        // Attach the stream.
        const { url, isHls } = client.streamUrl(itemId, source as MediaSource, info.PlaySessionId);
        captionInputRef.current = url;
        setSkipSubject(
          desktopSkipSubject({
            key: `jellyfin:${itemId}:${source.Id}:${seq}`,
            show: item.SeriesId ?? item.Id,
            season: item.ParentIndexNumber ?? 0,
            episode: item.IndexNumber ?? 0,
            file: `jellyfin:${itemId}:${source.Id}`,
            // Skip detection reads the stored file. Only beside direct play: a
            // transcode means the bandwidth is short, and reading the original
            // too could starve playback (chapters and segments still apply).
            input: client.staticStreamUrl(itemId, source.Id),
            isEpisode: isEpisode && !isHls,
            audioLanguage: preferredAudioLanguage,
            known: async (signal, mediaDuration) =>
              markersFromJellyfinSegments(
                await client.mediaSegments(itemId, signal),
                mediaDuration || ticksToSeconds(item.RunTimeTicks)
              ),
          })
        );
        // hls.js is the largest frontend dependency. Load it only when the
        // negotiated source actually needs Media Source Extensions; direct
        // play sessions should not pay that startup/download cost.
        const HlsModule = isHls ? (await import("hls.js")).default : null;
        if (seq !== loadSeq.current) return;
        if (HlsModule?.isSupported()) {
          const hls = new HlsModule({ startPosition: -1 });
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(HlsModule.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(`Stream error: ${data.type}`);
          });
        } else {
          video.src = url;
        }
        applyPlaybackRate(video, requestedPlaybackRateRef.current);
        video.volume = usePlayback.getState().volume;
        video.muted = usePlayback.getState().muted;
        // HLS transcodes already start server-side at the requested position.
        if (startAt > 5 && !isHls) video.currentTime = startAt;

        await video.play().catch(() => {/* autoplay may need a gesture */});
        if (seq !== loadSeq.current) return;
        _sync({ buffering: false });
        await client.reportStart(itemId, source.Id, info.PlaySessionId);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        _sync({ buffering: false });
        toast.error(t("common.error"), { description: msg.slice(0, 140) });
      }
    },
    [client, preferredAudioLanguage, subtitleLanguage, teardown, _setSession, _sync, t]
  );

  /**
   * The source handed to the player never produced a picture (it stopped
   * sharing, or never really started). Start the next ranked source instead
   * of a black screen that loads forever.
   */
  const moveToNextSource = useCallback(
    async (request: DirectPlaybackRequest, reason: string) => {
      const video = videoRef.current;
      if (!video || directRequestRef.current !== request) return;
      if (!useTorrents.getState().handedOff?.fallbacks.length) {
        _sync({ buffering: false });
        setError(`${reason} Akflix has no other source for this title. Go back and try again in a while.`);
        return;
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
      _sync({ buffering: true });
      toast.info("Trying another source", { description: reason });
      const next = await useTorrents.getState().startNextSource().catch(() => null);
      if (!next && directRequestRef.current === request) {
        _sync({ buffering: false });
        setError(`${reason} None of the other sources could start either. Go back and try again in a while.`);
      }
    },
    [_sync]
  );

  const watchFirstFrame = useCallback(
    (request: DirectPlaybackRequest, limitMs: number) => {
      clearTimeout(firstFrameTimer.current);
      if (!request.id.startsWith("torrent:")) return;
      firstFrameTimer.current = setTimeout(() => {
        const video = videoRef.current;
        if (!video || directRequestRef.current !== request || pictureShownRef.current === request) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime > 0.5) return;
        void moveToNextSource(request, "The source never delivered a picture.");
      }, limitMs);
    },
    [moveToNextSource]
  );

  useEffect(() => () => clearTimeout(firstFrameTimer.current), []);

  /** Local progressive playback bypasses Jellyfin's slow incomplete-file probe. */
  const loadDirect = useCallback(
    async (request: DirectPlaybackRequest) => {
      const video = videoRef.current;
      if (!video) return;
      const seq = ++loadSeq.current;
      teardown();
      directIdRef.current = request.playbackRequestId ?? null;
      directRequestRef.current = request;
      directResumeAppliedRef.current = null;
      playbackStallOpen.current = false;
      // Watch Now selects before this handoff. From this point onward the
      // release is immutable: buffering can pause playback, never replace it.
      lastLocalHistoryWrite.current = 0;
      setError(null);
      setSubTracks([]);
      setActiveSub(-1);
      setBufferedUntil(0);
      setScrubTime(null);
      setSeekFeedback(null);
      scrubTimeRef.current = null;
      nextEpisodeRef.current = null;
      _sync({
        buffering: true,
        hasNext: !!request.episodeQueue?.length,
        currentTime: request.compatibility?.startSeconds ?? 0,
        duration: request.durationSeconds ?? 0,
      });
      if ((request.compatibility?.startSeconds ?? 0) > 10) {
        directResumeAppliedRef.current = request.playbackRequestId ?? null;
      }
      const display = mediaDisplayFromRelease(request.title);
      _setSession({
        itemId: request.id,
        title: display.title,
        subtitle: request.subtitle?.trim() || display.subtitle,
        posterUrl: request.posterUrl ?? null,
        isEpisode: request.isEpisode ?? false,
        direct: true,
      });
      captionInputRef.current = request.compatibility?.inputUrl
        ?? (request.compatibility?.filename
          ? `media://Streaming Cache/${request.compatibility.filename}`
          : request.url);
      setCompatibilityStartSeconds(request.compatibility?.startSeconds ?? 0);
      const upcoming = request.episodeQueue?.[0];
      setNextTitle(upcoming ? `S${upcoming.season} E${upcoming.episode} · ${upcoming.title}` : undefined);
      const skipInput = captionInputRef.current;
      setSkipSubject(
        skipInput
          ? desktopSkipSubject({
              key: `direct:${request.playbackRequestId ?? request.id}`,
              show: request.catalogId ?? `release:${sourceKey(display.title)}`,
              season: request.season ?? 0,
              episode: request.episode ?? 0,
              file: skipInput,
              input: skipInput,
              isEpisode: !!request.isEpisode && request.season !== undefined && request.episode !== undefined,
              audioLanguage: request.compatibility?.audioLanguage ?? preferredAudioLanguage,
            })
          : null
      );
      video.src = request.url;
      video.preload = "auto";
      watchFirstFrame(request, FIRST_FRAME_LIMIT_MS);
      applyPlaybackRate(video, requestedPlaybackRateRef.current);
      video.volume = usePlayback.getState().volume;
      video.muted = usePlayback.getState().muted;
      await video.play().catch(() => {});
      if (seq === loadSeq.current) _sync({ buffering: false });

      if (request.catalogId && request.mediaType) {
        directSubtitleTracks(
          request.catalogId,
          request.mediaType,
          subtitleLanguage,
          request.season,
          request.episode
        )
          .then((tracks) => {
            if (seq !== loadSeq.current) {
              tracks.forEach((track) => URL.revokeObjectURL(track.url));
              return;
            }
            subtitleBlobUrlsRef.current = tracks.map((track) => track.url);
            const prepared = tracks.map((track, index) => ({
              index: 10_000 + index,
              label: track.label,
              language: track.language,
              url: track.url,
              vtt: track.vtt,
            }));
            setSubTracks(prepared);
            const preferred = prepared.find(
              (track) => track.language === subtitleLanguage
            );
            if (preferred && !manualCaptionRef.current) setActiveSub(preferred.index);
          })
          .catch(() => {});
      }
    },
    [_setSession, _sync, preferredAudioLanguage, subtitleLanguage, teardown, watchFirstFrame]
  );

  // React to open() requests from pages.
  useEffect(() => {
    if (!requestedItemId) return;
    if (jfSessionRef.current?.itemId === requestedItemId) return; // already playing
    load(requestedItemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedItemId]);

  useEffect(() => {
    if (!requestedDirect) return;
    if (directIdRef.current === requestedDirect.playbackRequestId) return;
    loadDirect(requestedDirect);
  }, [loadDirect, requestedDirect]);

  // Full teardown when the session is cleared (stop) or on unmount.
  useEffect(() => {
    if (!session && (jfSessionRef.current || directIdRef.current)) {
      teardown();
      directIdRef.current = null;
    }
  }, [session, teardown]);
  useEffect(() => () => teardown(), [teardown]);

  // "Stream now" is a temporary cache. Closing/finishing the player removes
  // its qBittorrent job and files; ordinary offline downloads are untouched.
  useEffect(() => {
    if (!session && !requestedItemId && !requestedDirect && activeStreamHash) {
      finishActiveStream().catch(() => {});
    }
  }, [activeStreamHash, finishActiveStream, requestedDirect, requestedItemId, session]);

  // ── Imperative controls registered with the store ────────────────────

  const playNext = useCallback(async (): Promise<boolean> => {
    const nextId = nextEpisodeRef.current;
    if (nextId) {
      // Load first, then update the route/store. Updating requestedItemId before
      // load() finishes makes the request effect race this direct call.
      await load(nextId);
      if (jfSessionRef.current?.itemId !== nextId) return false;
      usePlayback.setState({ requestedItemId: nextId });
      if (usePlayback.getState().mode === "expanded") {
        navigate(`/play/${nextId}`, { replace: true });
      }
      return true;
    }

    const current = directRequestRef.current;
    const next = current?.episodeQueue?.[0];
    if (!current || !next || !current.catalogId) return false;
    const {
      id: _id,
      url: _url,
      compatibility: _compatibility,
      resumeSeconds: _resumeSeconds,
      episodeQueue = [],
      ...base
    } = current;
    const nextMedia = {
      ...base,
      subtitle: `S${next.season} E${next.episode} · ${next.title}`,
      season: next.season,
      episode: next.episode,
      episodeQueue: episodeQueue.slice(1),
    };

    try {
      captionGenerationRef.current += 1;
      setCaptionTask(null);
      videoRef.current?.pause();
      _sync({ buffering: true, hasNext: false, currentTime: 0, duration: 0 });
      toast.info("Loading the next episode", {
        description: nextMedia.subtitle,
      });
      const torrentState = useTorrents.getState();
      const requestId = await torrentState.beginStreamRequest(nextMedia);
      const results = await torrentState.search(current.title, undefined, {
        imdbId: current.catalogId,
        type: "series",
        season: next.season,
        episode: next.episode,
      });
      if (useTorrents.getState().streamRequestId !== requestId) return false;
      let eligible = automaticSafeSources(results, preferredAudioLanguage);
      if (mobileApple) eligible = iosNativeSources(eligible);
      if (!eligible.length) throw new Error("No compatible source was found for the next episode.");

      const hosted = eligible.find((result) => result.streamUrl);
      if (hosted?.streamUrl) {
        usePlayback.getState().openDirect({
          ...nextMedia,
          id: hosted.guid,
          url: hosted.streamUrl,
        });
      } else {
        await torrentState.raceStreamSources(eligible, nextMedia, requestId);
      }
      if (usePlayback.getState().mode === "expanded") {
        navigate("/stream", { replace: true });
      }
      return true;
    } catch (reason) {
      toast.error("Could not play the next episode", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
      return false;
    }
  }, [load, mobileApple, navigate, preferredAudioLanguage, _sync]);

  /**
   * The extension check sends every MP4 to WebKit directly, but WebKit cannot
   * decode HEVC tagged "hev1" (MediaError) and drops DTS audio (no audio
   * track). The rolling FFmpeg conversion handles both, so move the same
   * release over once instead of reporting an interruption.
   */
  const convertDirectSource = useCallback(
    async (reason: string): Promise<boolean> => {
      const video = videoRef.current;
      const request = directRequestRef.current;
      if (!video || !request || request.compatibility) return false;
      if (compatibilityFallbackRef.current === request) return false;
      const hash = request.url.match(/^http:\/\/127\.0\.0\.1:3031\/torrents\/([a-f\d]{40})\/stream\/\d+$/i)?.[1];
      if (!hash) return false;
      compatibilityFallbackRef.current = request;
      const inputUrl = request.url;
      const streamId = hash.toLowerCase();
      const startSeconds =
        video.currentTime > 1 ? video.currentTime : Math.max(0, request.resumeSeconds ?? 0);
      setError(null);
      _sync({ buffering: true });
      toast.info("Converting this source for playback", { description: reason });
      try {
        const url = await startCompatibilityStreamUrl(inputUrl, streamId, preferredAudioLanguage, startSeconds);
        if (directRequestRef.current !== request) return true;
        request.compatibility = { streamId, audioLanguage: preferredAudioLanguage, inputUrl, startSeconds };
        request.url = url;
        directResumeAppliedRef.current = request.playbackRequestId ?? null;
        captionInputRef.current = inputUrl;
        setCompatibilityStartSeconds(startSeconds);
        video.src = url;
        video.load();
        watchFirstFrame(request, COMPATIBILITY_FIRST_FRAME_LIMIT_MS);
        applyPlaybackRate(video, requestedPlaybackRateRef.current);
        video.volume = usePlayback.getState().volume;
        video.muted = usePlayback.getState().muted;
        await video.play().catch(() => {});
      } catch (conversion) {
        if (directRequestRef.current !== request) return true;
        void moveToNextSource(
          request,
          `${reason} Akflix could not convert it either (${
            conversion instanceof Error ? conversion.message : String(conversion)
          }).`
        );
      }
      return true;
    },
    [_sync, moveToNextSource, preferredAudioLanguage, watchFirstFrame]
  );

  const showSeekFeedback = useCallback((delta: number) => {
    // A quick run of skips shows its total, matching where playback goes.
    setSeekFeedback((shown) => (shown === null ? delta : shown + delta) || null);
    clearTimeout(seekFeedbackTimer.current);
    seekFeedbackTimer.current = setTimeout(() => setSeekFeedback(null), 700);
  }, []);

  const jumpBy = useCallback(
    (delta: number) => {
      usePlayback.getState().controls?.seekBy(delta);
      showSeekFeedback(delta);
      poke();
    },
    [poke, showSeekFeedback]
  );

  const previewSeek = useCallback((seconds: number) => {
    scrubTimeRef.current = seconds;
    setScrubTime(seconds);
  }, []);

  const commitSeek = useCallback((seconds?: number) => {
    const target = seconds ?? scrubTimeRef.current;
    scrubTimeRef.current = null;
    setScrubTime(null);
    if (target === null || !Number.isFinite(target)) return;
    usePlayback.getState().controls?.seek(target);
    poke();
  }, [poke]);

  useEffect(() => {
    // WebKit can send pointerup outside the native range input after a fast
    // click or drag. Always finish the scrub at window level so its preview
    // cannot remain pinned while the video continues underneath it.
    const finishScrub = () => {
      if (!scrubPointerActiveRef.current) return;
      scrubPointerActiveRef.current = false;
      commitSeek();
    };
    const cancelScrub = () => {
      scrubPointerActiveRef.current = false;
      scrubTimeRef.current = null;
      setScrubTime(null);
    };
    window.addEventListener("pointerup", finishScrub);
    window.addEventListener("pointercancel", cancelScrub);
    return () => {
      window.removeEventListener("pointerup", finishScrub);
      window.removeEventListener("pointercancel", cancelScrub);
    };
  }, [commitSeek]);

  const clearPlaybackStall = useCallback(() => {
    clearTimeout(bufferingIndicatorTimer.current);
    clearTimeout(playbackStallTimer.current);
    playbackStallOpen.current = false;
  }, []);

  /**
   * WebKit can stop reading a direct stream whose response went quiet midway
   * (torrent peers gone for about a minute) and then wait forever without an
   * error, even once the engine has the bytes. Loading the same URL again at
   * the same position makes it request them anew. The release is unchanged.
   */
  const rereadDirectSource = useCallback(() => {
    const video = videoRef.current;
    const request = directRequestRef.current;
    if (!video || !request || request.compatibility || video.paused) return;
    const position = video.currentTime;
    rereadingRef.current = position;
    rereadCanPlayRef.current = true;
    video.src = request.url;
    video.load();
    video.currentTime = position;
    applyPlaybackRate(video, requestedPlaybackRateRef.current);
    void video.play().catch(() => {});
  }, []);

  const schedulePlaybackStall = useCallback(() => {
    const request = directRequestRef.current;
    const video = videoRef.current;
    if (!video || video.paused || video.ended) return;
    if (!request) {
      // Jellyfin sessions manage recovery server-side, but the player should
      // still report an actual wait to the user until `playing` or `canplay`.
      _sync({ buffering: true });
      return;
    }
    if (playbackStallOpen.current) return;

    playbackStallOpen.current = true;
    const requestId = request.playbackRequestId;
    const startedAt = video.currentTime;
    clearTimeout(bufferingIndicatorTimer.current);
    clearTimeout(playbackStallTimer.current);
    // WebKit emits brief `waiting` and `stalled` events while it switches
    // ranges or catches up internally. Do not flash a spinner unless playback
    // has genuinely stopped and there are no future frames ready.
    bufferingIndicatorTimer.current = setTimeout(() => {
      const activeVideo = videoRef.current;
      const activeRequest = directRequestRef.current;
      if (
        !activeVideo ||
        activeRequest?.playbackRequestId !== requestId ||
        activeVideo.paused ||
        activeVideo.ended
      ) {
        clearPlaybackStall();
        return;
      }
      const recovered =
        activeVideo.currentTime > startedAt + 0.15 ||
        activeVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      if (recovered) {
        clearPlaybackStall();
        _sync({ buffering: false });
        return;
      }
      _sync({ buffering: true });
    }, 700);

    const watchStall = (since: number) => {
      playbackStallTimer.current = setTimeout(() => {
        const activeVideo = videoRef.current;
        const activeRequest = directRequestRef.current;
        if (
          !activeVideo ||
          !activeRequest ||
          activeRequest.playbackRequestId !== requestId ||
          activeVideo.paused ||
          activeVideo.currentTime > since + 1
        ) {
          clearPlaybackStall();
          _sync({ buffering: false });
          return;
        }
        // A temporary peer slowdown is buffering, not permission to replace
        // the release. Keep the same timeline and wait for more data.
        _sync({ buffering: true });
        if (activeRequest.compatibility) {
          playbackStallOpen.current = false;
          return;
        }
        // A direct stream may be waiting on a response WebKit stopped
        // reading. Ask for the data again while it stays stuck.
        const position = activeVideo.currentTime;
        rereadDirectSource();
        watchStall(position);
      }, 15_000);
    };
    watchStall(startedAt);
  }, [_sync, clearPlaybackStall, rereadDirectSource]);

  useEffect(() => {
    _setControls({
      toggle: () => {
        const v = videoRef.current;
        if (!v || seeker.toggle()) return;
        if (v.paused) v.play();
        else {
          v.pause();
          const s = jfSessionRef.current;
          if (client && s)
            client
              .reportProgress(s.itemId, s.mediaSourceId, s.playSessionId, v.currentTime, true)
              .catch(() => {});
        }
      },
      seek: (sec) => seeker.seek(sec),
      seekBy: (delta) => seeker.seekBy(delta),
      setMuted: (m) => {
        const v = videoRef.current;
        if (v) {
          if (!m && v.volume === 0) {
            v.volume = 0.5;
            rememberVolume(v.volume);
          }
          v.muted = m;
          _sync({ muted: m, volume: v.volume });
        }
      },
      setVolume: (nextVolume) => {
        const v = videoRef.current;
        if (!v) return;
        const clamped = Math.max(0, Math.min(1, nextVolume));
        v.volume = clamped;
        v.muted = clamped === 0;
        rememberVolume(clamped);
        _sync({ volume: clamped, muted: v.muted });
      },
      setPlaybackRate: (rate) => {
        const v = videoRef.current;
        if (!v) return;
        requestedPlaybackRateRef.current = Math.max(0.5, Math.min(2, rate));
        applyPlaybackRate(v, requestedPlaybackRateRef.current);
        _sync({ playbackRate: requestedPlaybackRateRef.current });
      },
      next: playNext,
    });
    return () => _setControls(null);
  }, [client, playNext, seeker, _setControls, _sync]);

  // ── Progress reporting heartbeat ─────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const v = videoRef.current;
      const s = jfSessionRef.current;
      if (!client || !v || !s || v.paused) return;
      client
        .reportProgress(s.itemId, s.mediaSourceId, s.playSessionId, v.currentTime, false)
        .catch(() => {});
    }, PROGRESS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client]);

  const toggleFullscreen = useCallback(async () => {
    if (mobileApple) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
      return;
    } catch {
      // Browser preview fallback. The desktop app uses the native window API.
    }

    const surface = document.getElementById("player-surface");
    if (document.fullscreenElement) await document.exitFullscreen();
    else await surface?.requestFullscreen();
  }, [mobileApple]);

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current as WebKitVideoElement | null;
    if (!video) return;
    try {
      if (
        video.webkitSetPresentationMode &&
        video.webkitSupportsPresentationMode?.("picture-in-picture")
      ) {
        const entering = video.webkitPresentationMode !== "picture-in-picture";
        video.webkitSetPresentationMode(entering ? "picture-in-picture" : "inline");
        setPictureInPicture(entering);
        return;
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      } else {
        throw new Error("Picture in picture is unavailable for this video.");
      }
    } catch (reason) {
      toast.error("Could not open picture in picture", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current as WebKitVideoElement | null;
    if (!video) return;
    const update = () => {
      setPictureInPicture(
        document.pictureInPictureElement === video ||
          video.webkitPresentationMode === "picture-in-picture"
      );
    };
    video.addEventListener("enterpictureinpicture", update);
    video.addEventListener("leavepictureinpicture", update);
    video.addEventListener("webkitpresentationmodechanged", update);
    return () => {
      video.removeEventListener("enterpictureinpicture", update);
      video.removeEventListener("leavepictureinpicture", update);
      video.removeEventListener("webkitpresentationmodechanged", update);
    };
  }, [session?.itemId]);

  // ── Skip Intro / Recap, and Next episode at the credits ─────────────
  // The file's own end (probed), where the existing autoplay moves on; credits
  // may end before it (a post-credits scene).
  const mediaEnd = skipSubject?.duration() || duration;
  const skipState = {
    markers: skipMarkers,
    duration: mediaEnd,
    autoSkipped: autoSkippedRef.current,
    dismissed: skipDismissedRef.current,
    hasNext,
    creditsDismissed,
  };
  const skip = skipView({ ...skipState, time: currentTime, previousTime: null, autoSkip: false });

  const showSkipNotice = useCallback((notice: SkipNotice | null) => {
    clearTimeout(skipNoticeTimer.current);
    setSkipNotice(notice);
    if (notice) skipNoticeTimer.current = setTimeout(() => setSkipNotice(null), AUTO_SKIP_NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(skipNoticeTimer.current), []);
  const undoSkip = useCallback(
    (notice: SkipNotice) => {
      // The viewer wants to watch it: no button over it, no second auto-skip.
      skipDismissedRef.current.add(notice.kind);
      usePlayback.getState().controls?.seek(notice.from);
      showSkipNotice(null);
    },
    [showSkipNotice]
  );

  // Auto-skip: only when playback runs into an intro or recap (never after a
  // seek or resume into it), once per part, and never again after Watch it.
  useEffect(() => {
    const previousTime = skipTimeRef.current;
    skipTimeRef.current = currentTime;
    if (!autoSkipIntro || seeker.replacing() || scrubTimeRef.current !== null) return;
    const decision = skipView({ ...skipState, time: currentTime, previousTime, autoSkip: true }).autoSkip;
    const segment = decision ? skipMarkers[decision.kind] : undefined;
    if (!decision || !segment) return;
    autoSkippedRef.current.add(decision.kind);
    usePlayback.getState().controls?.seek(decision.target);
    const notice = { kind: decision.kind, from: segment.start };
    if (usePlayback.getState().mode === "expanded") {
      showSkipNotice(notice);
    } else {
      // The mini player has no room for the notice: the same choice as a toast.
      toast(decision.kind === "intro" ? "Intro skipped" : "Recap skipped", {
        duration: AUTO_SKIP_NOTICE_MS,
        action: { label: "Watch it", onClick: () => undoSkip(notice) },
      });
    }
    // Decided per time update; the markers and settings are read as they are now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime]);

  const skipButton = skip.button;
  const skipNow = useCallback(() => {
    if (!skipButton) return;
    showSkipNotice(null);
    usePlayback.getState().controls?.seek(skipButton.target);
  }, [showSkipNotice, skipButton]);
  const undoAutoSkip = useCallback(() => {
    if (skipNotice) undoSkip(skipNotice);
  }, [skipNotice, undoSkip]);
  const upNext =
    skip.nextEpisode && skipMarkers.credits
      ? {
          title: nextTitle,
          endsIn: mediaEnd - currentTime,
          progress: (currentTime - skipMarkers.credits.start) / Math.max(1, mediaEnd - skipMarkers.credits.start),
        }
      : null;
  skipActionsRef.current = {
    skip: skipButton ? skipNow : null,
    next: upNext ? () => void usePlayback.getState().controls?.next() : null,
  };

  // ── Global keyboard shortcuts (active whenever something is loaded) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!usePlayback.getState().session) return;
      if (isTypingTarget(e.target)) return;
      const v = videoRef.current;
      const ctrl = usePlayback.getState().controls;
      if (!v || !ctrl) return;
      const expanded = usePlayback.getState().mode === "expanded";
      if (expanded) poke();

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (expanded && /^\d$/.test(key)) {
        e.preventDefault();
        const mediaDuration = usePlayback.getState().duration;
        if (mediaDuration > 0) ctrl.seek((mediaDuration * Number(key)) / 10);
        return;
      }

      switch (key) {
        case " ":
        case "k":
          e.preventDefault();
          ctrl.toggle();
          break;
        case "ArrowLeft":
        case "j":
          if (expanded) {
            e.preventDefault();
            jumpBy(e.shiftKey ? -30 : -SEEK_SECONDS);
          }
          break;
        case "ArrowRight":
        case "l":
          if (expanded) {
            e.preventDefault();
            jumpBy(e.shiftKey ? 30 : SEEK_SECONDS);
          }
          break;
        case "ArrowUp":
          if (expanded) {
            e.preventDefault();
            ctrl.setVolume(v.volume + 0.05);
          }
          break;
        case "ArrowDown":
          if (expanded) {
            e.preventDefault();
            ctrl.setVolume(v.volume - 0.05);
          }
          break;
        case "Home":
          if (expanded) {
            e.preventDefault();
            ctrl.seek(0);
          }
          break;
        case "End":
          if (expanded) {
            e.preventDefault();
            ctrl.seek(Math.max(0, usePlayback.getState().duration - 1));
          }
          break;
        case "f":
          if (usePlayback.getState().mode === "expanded") void toggleFullscreen();
          break;
        case "m":
          ctrl.setMuted(!v.muted);
          break;
        case "s":
          if (expanded && skipActionsRef.current.skip) {
            e.preventDefault();
            skipActionsRef.current.skip();
          }
          break;
        case "n":
          if (expanded && skipActionsRef.current.next) {
            e.preventDefault();
            skipActionsRef.current.next();
          }
          break;
        case "<":
        case ",": {
          const currentIndex = PLAYBACK_RATES.findIndex((rate) => rate >= v.playbackRate);
          ctrl.setPlaybackRate(PLAYBACK_RATES[Math.max(0, currentIndex - 1)]);
          break;
        }
        case ">":
        case ".": {
          const currentIndex = PLAYBACK_RATES.findIndex((rate) => rate > v.playbackRate);
          ctrl.setPlaybackRate(
            currentIndex < 0 ? PLAYBACK_RATES[PLAYBACK_RATES.length - 1] : PLAYBACK_RATES[currentIndex]
          );
          break;
        }
        case "Escape":
          if (expanded && !document.fullscreenElement) navigate(-1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpBy, navigate, poke, toggleFullscreen]);

  // ── Episode-specific generated and automatically aligned captions ────
  const captionKey = manualCaptionKey(session, directRequestRef.current);

  useEffect(() => {
    const stored = captionKey ? loadManualCaption(captionKey) : null;
    manualCaptionRef.current = stored;
    setManualCaption(stored);
    if (stored) setActiveSub(MANUAL_SUBTITLE_INDEX);
  }, [captionKey]);

  useEffect(() => {
    const ownedUrls: string[] = [];
    const prepared = subTracks.map((track) => {
      if (!track.vtt || compatibilityStartSeconds <= 0.05) return track;
      const url = URL.createObjectURL(
        new Blob([offsetSubtitle(track.vtt, -compatibilityStartSeconds)], {
          type: "text/vtt",
        })
      );
      ownedUrls.push(url);
      return { ...track, url };
    });
    setPlaybackSubTracks(prepared);
    return () => ownedUrls.forEach((url) => URL.revokeObjectURL(url));
  }, [compatibilityStartSeconds, subTracks]);

  useEffect(() => {
    if (!manualCaption) {
      setManualTrack(null);
      return;
    }
    const vtt = manualCaption.kind === "generated"
      ? cuesToVtt(sequentialCues(parseVttCues(manualCaption.vtt)))
      : manualCaption.vtt;
    const url = URL.createObjectURL(
      new Blob([offsetSubtitle(
        vtt,
        manualCaption.offsetSeconds - compatibilityStartSeconds
      )], {
        type: "text/vtt",
      })
    );
    setManualTrack({
      index: MANUAL_SUBTITLE_INDEX,
      label: manualCaption.name,
      language: subtitleLanguage,
      url,
      manual: true,
    });
    return () => URL.revokeObjectURL(url);
  }, [compatibilityStartSeconds, manualCaption, subtitleLanguage]);

  const toggleGeneratedCaptions = useCallback(async () => {
    if (captionTask === "generating") {
      captionGenerationRef.current += 1;
      setCaptionTask(null);
      toast.info("Live caption generation paused", {
        description: "Everything generated so far remains saved for this episode.",
      });
      return;
    }
    const input = captionInputRef.current;
    if (!captionKey || !input) {
      toast.error("Captions are not ready yet", {
        description: "Start the video, then try Generate live captions again.",
      });
      return;
    }

    const generation = ++captionGenerationRef.current;
    const current = manualCaptionRef.current;
    let generated: CaptionCue[] = current?.kind === "generated" ? parseVttCues(current.vtt) : [];
    let generatedRanges = current?.kind === "generated"
      ? current.generatedRanges?.length
        ? mergeCaptionRanges(current.generatedRanges)
        : inferredCaptionRanges(generated)
      : [];
    setCaptionTask("generating");
    setActiveSub(MANUAL_SUBTITLE_INDEX);
    toast.success("Live captions started", {
      description: "Akflix is listening privately and preparing dialogue a little ahead of playback.",
    });

    try {
      while (
        captionGenerationRef.current === generation &&
        manualCaptionKey(usePlayback.getState().session, directRequestRef.current) === captionKey
      ) {
        const playbackTime = usePlayback.getState().currentTime;
        const activeRange = generatedRanges.find(
          (range) => playbackTime >= range.start - 1 && playbackTime <= range.end
        );
        if (activeRange && activeRange.end >= playbackTime + 24) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_200));
          continue;
        }
        const nextStart = activeRange
          ? Math.max(playbackTime - 1, activeRange.end - 2)
          : Math.max(0, playbackTime - 1);
        const cues = await transcribeCaptionChunk(input, nextStart, 20, "eng");
        if (captionGenerationRef.current !== generation) return;
        const playbackAfterRecognition = usePlayback.getState().currentTime;
        if (Math.abs(playbackAfterRecognition - nextStart) > 28) continue;
        generated = [...generated, ...cues];
        const generatedUntil = nextStart + 20;
        generatedRanges = mergeCaptionRanges([
          ...generatedRanges,
          { start: nextStart, end: generatedUntil },
        ]);
        const caption: ManualCaption = {
          name: "English · Generated by Akflix",
          vtt: cuesToVtt(generated),
          offsetSeconds: manualCaptionRef.current?.offsetSeconds ?? 0,
          kind: "generated",
          generatedUntil,
          generatedRanges,
        };
        saveManualCaption(captionKey, caption);
        manualCaptionRef.current = caption;
        setManualCaption(caption);
        setActiveSub(MANUAL_SUBTITLE_INDEX);
      }
    } catch (reason) {
      if (captionGenerationRef.current !== generation) return;
      toast.error("Live captions paused", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (captionGenerationRef.current === generation) setCaptionTask(null);
    }
  }, [captionKey, captionTask]);

  const autoSyncCurrentCaption = useCallback(async () => {
    const input = captionInputRef.current;
    const selected = subTracks.find((track) => track.index === activeSub);
    if (!captionKey || !input || !selected || captionTask) {
      toast.info("Select a caption track first", {
        description: "Choose one of the loaded captions, then press Auto sync.",
      });
      return;
    }
    captionGenerationRef.current += 1;
    setCaptionTask("syncing");
    try {
      const response = selected.url.startsWith("blob:")
        ? await fetch(selected.url)
        : await httpRaw(selected.url);
      if (!response.ok) throw new Error(`Could not read this caption track (HTTP ${response.status})`);
      const vtt = await response.text();
      const subtitleCues = parseVttCues(vtt);
      const sampleStart = Math.max(
        0,
        Math.min(usePlayback.getState().currentTime - 3, Math.max(0, usePlayback.getState().duration - 30))
      );
      const speechCues = await transcribeCaptionChunk(input, sampleStart, 30, "eng");
      const offsetSeconds = estimateCaptionOffset(subtitleCues, speechCues);
      if (offsetSeconds === null) {
        throw new Error("Akflix could not confidently match enough spoken words. Try again during a dialogue-heavy scene.");
      }
      const caption: ManualCaption = {
        name: `${selected.label} · Auto synced`,
        vtt,
        offsetSeconds,
        kind: "synced",
      };
      saveManualCaption(captionKey, caption);
      manualCaptionRef.current = caption;
      setManualCaption(caption);
      setActiveSub(MANUAL_SUBTITLE_INDEX);
      toast.success("Captions synchronized", {
        description: `Akflix matched the dialogue and applied a ${offsetSeconds > 0 ? "+" : ""}${offsetSeconds.toFixed(1)} second correction.`,
      });
    } catch (reason) {
      toast.error("Could not synchronize captions", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setCaptionTask(null);
    }
  }, [activeSub, captionKey, captionTask, subTracks]);

  const adjustManualCaption = useCallback(
    (delta: number) => {
      if (!captionKey || !manualCaptionRef.current) return;
      const next: ManualCaption = {
        ...manualCaptionRef.current,
        offsetSeconds: Math.max(
          -120,
          Math.min(120, Math.round((manualCaptionRef.current.offsetSeconds + delta) * 10) / 10)
        ),
      };
      saveManualCaption(captionKey, next);
      manualCaptionRef.current = next;
      setManualCaption(next);
      setActiveSub(MANUAL_SUBTITLE_INDEX);
    },
    [captionKey]
  );

  const deleteManualCaption = useCallback(() => {
    if (!captionKey) return;
    captionGenerationRef.current += 1;
    setCaptionTask(null);
    removeManualCaption(captionKey);
    manualCaptionRef.current = null;
    setManualCaption(null);
    setManualTrack(null);
    setActiveSub(-1);
    toast.success("Akflix captions removed");
  }, [captionKey]);

  // ── Subtitle track switching ─────────────────────────────────────────
  // One caption renderer: the selected <track>. Its element renders a step
  // after the selection, and WebKit's automatic caption selection changes
  // modes on its own whenever tracks are added (each load adds the file's
  // in-band tracks, each fetch or offset change adds ours), so the choice is
  // applied again whenever the track list changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;
    const apply = () => {
      const selected = Array.from(video.getElementsByTagName("track")).find(
        (element) => element.dataset.index === String(activeSub)
      );
      showOnlyCaptionTrack(tracks, selected?.track ?? null);
    };
    apply();
    tracks.addEventListener("addtrack", apply);
    tracks.addEventListener("change", apply);
    return () => {
      tracks.removeEventListener("addtrack", apply);
      tracks.removeEventListener("change", apply);
    };
  }, [activeSub, session]);

  // ── Caption placement ────────────────────────────────────────────────
  // WebKit lays captions out over the whole element, so with a letterboxed
  // picture they sat in the black bar at the window's edge. Frame them to
  // the picture instead (index.css), clear of the controls while they show.
  // Picture in picture and native fullscreen keep WebKit's own placement.
  useEffect(() => {
    const video = videoRef.current as WebKitVideoElement | null;
    if (!video) return;
    const place = () => {
      const inline = !pictureInPicture && (video.webkitPresentationMode ?? "inline") === "inline";
      const frame = inline
        ? captionFrame(
            { width: video.clientWidth, height: video.clientHeight },
            { width: video.videoWidth, height: video.videoHeight },
            mode === "expanded" && controlsVisible ? controlsBarRef.current?.offsetHeight ?? 0 : 0
          )
        : null;
      if (!frame) {
        delete video.dataset.captionFrame;
        video.style.removeProperty("--caption-size");
        return;
      }
      video.style.setProperty("--caption-top", `${frame.top}px`);
      video.style.setProperty("--caption-left", `${frame.left}px`);
      video.style.setProperty("--caption-width", `${frame.width}px`);
      video.style.setProperty("--caption-height", `${frame.height}px`);
      video.style.setProperty("--caption-size", `${frame.fontSize}px`);
      video.dataset.captionFrame = "";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(video);
    video.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", place);
    };
  }, [controlsVisible, mode, pictureInPicture, session]);

  // ── Render ───────────────────────────────────────────────────────────

  if (!session && !requestedItemId && !requestedDirect) return null;

  const expanded = mode === "expanded";
  const allSubTracks = manualTrack ? [manualTrack, ...playbackSubTracks] : playbackSubTracks;
  const displayedTime = scrubTime ?? currentTime;
  const progressPercent = duration > 0 ? Math.min(100, (displayedTime / duration) * 100) : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (bufferedUntil / duration) * 100) : 0;
  const timelineStyle = {
    "--range-progress": `${progressPercent}%`,
    "--range-buffered": `${Math.max(progressPercent, bufferedPercent)}%`,
  } as CSSProperties;
  const volumePercent = muted ? 0 : volume * 100;
  const volumeStyle = {
    "--range-progress": `${volumePercent}%`,
    "--range-buffered": `${volumePercent}%`,
  } as CSSProperties;
  const onEnded = async () => {
    if (seeker.replacing()) return;
    const finishedRequest = directRequestRef.current;
    const nextDirectEpisode = finishedRequest?.episodeQueue?.[0];
    const advanced = await playNext();

    if (nextDirectEpisode) {
      // Keep the series in Continue Watching at the exact next episode,
      // including when automatic playback could not find a source yet.
      queueDirectEpisodeProgress(finishedRequest, nextDirectEpisode);
    } else if (!advanced) {
      saveDirectProgress(finishedRequest, videoRef.current, true);
    }

    if (!advanced) {
      stop();
      if (usePlayback.getState().mode === "expanded") navigate(-1);
    }
  };

  return (
    <>
      {/* Video surface: fullscreen when expanded, PiP card when minimized. */}
      <motion.div
        id="player-surface"
        layout
        onMouseMove={expanded ? poke : undefined}
        onClick={() => {
          if (expanded && mobileApple) {
            if (controlsVisible) {
              clearTimeout(hideTimer.current);
              setControlsVisible(false);
            } else {
              poke();
            }
          } else if (expanded) poke();
          else if (session) {
            usePlayback.getState().expand();
            navigate(session.direct ? "/stream" : `/play/${session.itemId}`);
          }
        }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        className={
          expanded
            ? "fixed inset-0 z-[60] bg-black"
            : mobileApple
              ? "pointer-events-none fixed bottom-0 right-0 z-[-1] h-px w-px overflow-hidden opacity-0"
              : "fixed bottom-24 right-4 z-40 aspect-video w-64 cursor-pointer overflow-hidden rounded-lg border border-zinc-700 bg-black shadow-2xl"
        }
      >
        <video
          ref={videoRef}
          className="h-full w-full"
          playsInline
          preload="auto"
          onPlay={() => {
            _sync({ isPlaying: true });
            if (session?.direct && activeStreamHash) {
              setCompatibilityStreamPaused(activeStreamHash, false).catch(() => {});
            }
          }}
          onPause={() => {
            // A converter restart pauses the conversion it replaces. That is
            // not the viewer pausing: keep the play state and history, and
            // never let this pause reach (and freeze) the new converter.
            // Reloading a stuck direct stream pauses it the same way.
            if (seeker.replacing() || rereadingRef.current !== null) return;
            _sync({ isPlaying: false });
            saveDirectProgress(directRequestRef.current, videoRef.current);
            if (session?.direct && activeStreamHash) {
              setCompatibilityStreamPaused(activeStreamHash, true).catch(() => {});
            }
          }}
          onWaiting={schedulePlaybackStall}
          onStalled={schedulePlaybackStall}
          onLoadedData={() => {
            pictureShownRef.current = directRequestRef.current;
          }}
          onPlaying={() => {
            if (seeker.replacing()) return;
            clearPlaybackStall();
            _sync({ buffering: false });
          }}
          onCanPlay={(e) => {
            if (seeker.replacing()) return;
            // A stuck stream reloaded at its position is not a new start.
            const reread = rereadCanPlayRef.current;
            rereadCanPlayRef.current = false;
            clearPlaybackStall();
            _sync({ buffering: false });
            const request = directRequestRef.current;
            // WebKit drops DTS (and similar) audio tracks and plays silence.
            // Tracks are only listed from canplay on (0 at loadedmetadata for
            // every file); the conversion re-encodes the audio to AAC.
            const audioTracks = (e.currentTarget as HTMLVideoElement & { audioTracks?: { length: number } })
              .audioTracks;
            if (request && !request.compatibility && audioTracks?.length === 0) {
              void convertDirectSource("This file's audio format has no sound in the desktop player.");
            }
            const target = request?.resumeSeconds ?? 0;
            if (
              !reread &&
              request &&
              !request.compatibility &&
              target > 10 &&
              e.currentTarget.currentTime < target - 2
            ) {
              e.currentTarget.currentTime = target;
            }
          }}
          onTimeUpdate={(e) => {
            // A converter restart pauses and reloads this element, and pause()
            // reports the old position. The store already holds the skip
            // target; keep it so repeated skips add up and history stays put.
            // The same holds while a stuck direct stream reloads.
            if (seeker.replacing() || rereadingRef.current !== null) return;
            seeker.settle();
            const video = e.currentTarget;
            const request = directRequestRef.current;
            const timelineTime = request?.compatibility
              ? request.compatibility.startSeconds + video.currentTime
              : video.currentTime;
            const recovered =
              usePlayback.getState().buffering &&
              video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
            if (recovered) clearPlaybackStall();
            _sync({
              currentTime: timelineTime,
              ...(recovered ? { buffering: false } : {}),
            });
            if (
              directRequestRef.current &&
              Date.now() - lastLocalHistoryWrite.current >= LOCAL_HISTORY_INTERVAL_MS
            ) {
              lastLocalHistoryWrite.current = Date.now();
              saveDirectProgress(directRequestRef.current, video);
            }
          }}
          onSeeked={() => seeker.settle()}
          onDurationChange={(e) => {
            const request = directRequestRef.current;
            const mediaDuration =
              request?.durationSeconds && request.durationSeconds > 0
                ? request.durationSeconds
                : e.currentTarget.duration;
            _sync({ duration: Number.isFinite(mediaDuration) ? mediaDuration : 0 });
          }}
          onProgress={(e) => {
            const video = e.currentTarget;
            let furthest = 0;
            for (let index = 0; index < video.buffered.length; index += 1) {
              furthest = Math.max(furthest, video.buffered.end(index));
            }
            const request = directRequestRef.current;
            setBufferedUntil(
              request?.compatibility ? request.compatibility.startSeconds + furthest : furthest
            );
          }}
          onLoadedMetadata={(e) => {
            const request = directRequestRef.current;
            const video = e.currentTarget;
            applyPlaybackRate(video, requestedPlaybackRateRef.current);
            const rereadPosition = rereadingRef.current;
            if (rereadPosition !== null) {
              // The position set with the reload may not survive loading.
              rereadingRef.current = null;
              if (Math.abs(video.currentTime - rereadPosition) > 0.5) {
                video.currentTime = rereadPosition;
              }
              return;
            }
            const media = request ? directHistoryTitle(request) : null;
            if (
              !request ||
              !media ||
              directResumeAppliedRef.current === request.playbackRequestId
            ) return;
            const profileId = useAuth.getState().activeProfileId ?? "akflix-local";
            const saved = useHistory.getState().entries.find(
              (entry) =>
                entry.profileId === profileId &&
                entry.media.source === media.source &&
                entry.media.type === media.type &&
                entry.media.id === media.id &&
                entry.season === request.season &&
                entry.episode === request.episode &&
                !entry.completed
            );
            const mediaDuration = request.durationSeconds ?? video.duration;
            const target = request.resumeSeconds ?? saved?.position ?? 0;
            if (target > 10 && target < mediaDuration - 5) {
              seeker.seek(target);
              directResumeAppliedRef.current = request.playbackRequestId ?? null;
              toast.info("Resuming where you left off", {
                description: `${formatClock(target)} into ${request.title}`,
              });
            } else {
              directResumeAppliedRef.current = request.playbackRequestId ?? null;
            }
          }}
          onError={(e) => {
            rereadingRef.current = null;
            // The conversion a restart replaced can fail on its way out.
            if (seeker.replacing()) return;
            const mediaError = e.currentTarget.error;
            const directRequest = directRequestRef.current;
            if (
              session?.direct &&
              directRequest &&
              !directRequest.compatibility &&
              (mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
                mediaError?.code === MediaError.MEDIA_ERR_DECODE)
            ) {
              const reason = `The desktop player can't decode this file's format (media error ${mediaError.code}${
                mediaError.message ? `: ${mediaError.message}` : ""
              }).`;
              void convertDirectSource(reason).then((handled) => {
                if (handled) return;
                setError(`${reason} Choose another source.`);
                _sync({ buffering: false });
              });
              return;
            }
            if (
              session?.direct &&
              directRequest?.id.startsWith("torrent:") &&
              pictureShownRef.current !== directRequest
            ) {
              // Never showed a picture: not an interruption to wait out.
              void moveToNextSource(directRequest, "The source stopped before the first picture.");
              return;
            }
            setError(
              session?.direct && directRequest
                ? "The selected source was interrupted. Akflix kept the same release and playback position. Wait for it to recover or choose another stream yourself."
                : mediaError?.message ||
                    "This file is not playable yet. Let it buffer longer or choose a smaller 1080p source."
            );
            _sync({ buffering: false });
          }}
          onVolumeChange={(e) => {
            rememberVolume(e.currentTarget.volume);
            _sync({ muted: e.currentTarget.muted, volume: e.currentTarget.volume });
          }}
          onRateChange={(e) => {
            const video = e.currentTarget;
            const requested = requestedPlaybackRateRef.current;
            if (Math.abs(video.playbackRate - requested) > 0.01) {
              applyPlaybackRate(video, requested);
              return;
            }
            _sync({ playbackRate: requested });
          }}
          onEnded={onEnded}
          onDoubleClick={(event) => {
            if (mobileApple || !expanded) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - bounds.left) / bounds.width;
            if (position < 0.35) jumpBy(-SEEK_SECONDS);
            else if (position > 0.65) jumpBy(SEEK_SECONDS);
            else void toggleFullscreen();
          }}
        >
          {allSubTracks.map((s) => (
            <track
              key={`${s.index}:${s.url}`}
              id={String(s.index)}
              data-index={s.index}
              kind="subtitles"
              label={s.label}
              srcLang={s.language ?? "und"}
              src={s.url}
            />
          ))}
        </video>

        {/* Buffering spinner */}
        {buffering && !error && (
          <div role="status" aria-label="Buffering" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="ak-spinner h-12 w-12" aria-hidden="true" />
          </div>
        )}

        <AnimatePresence>
          {expanded && seekFeedback !== null && (
            <motion.div
              initial={{ opacity: 0, scale: 0.82 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.16 }}
              className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-1 rounded-full bg-black/55 px-6 py-4 text-white shadow-2xl backdrop-blur-xl ${
                seekFeedback < 0 ? "left-[22%]" : "right-[22%]"
              }`}
            >
              {seekFeedback < 0 ? <RotateCcw size={27} /> : <RotateCw size={27} />}
              <span className="text-xs font-bold tabular-nums">
                {seekFeedback > 0 ? "+" : ""}{seekFeedback}s
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error state */}
        {error && expanded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-8">
            <div role="alert" className="flex max-w-lg flex-col items-center gap-4 rounded-3xl bg-white px-8 py-7 text-center text-black shadow-2xl">
              <AlertTriangle size={30} aria-hidden="true" />
              <p className="text-base font-bold">This video couldn't play</p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-black/70">{error}</p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  stop();
                  navigate(-1);
                }}
                className="flex min-h-11 items-center gap-2 rounded-full bg-black px-5 text-sm font-semibold text-white transition hover:bg-zinc-800"
              >
                <ArrowLeft size={16} aria-hidden="true" /> {t("player.back")}
              </button>
            </div>
          </div>
        )}

        {/* Expanded controls overlay.
            Plain CSS transitions, deliberately no AnimatePresence: exit-gated
            animation wedges when this parent re-renders on every timeupdate,
            leaving a zombie overlay at opacity 0. CSS can't get stuck. */}
        {expanded && !error && (
          <div
            className={`absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/60 via-transparent to-black/80 transition-opacity duration-300 ${
              controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
              {/* Top bar */}
              <div
                data-tauri-drag-region
                className={`flex items-center gap-3 px-4 pb-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] transition-transform duration-300 md:gap-4 md:p-5 ${
                  controlsVisible ? "translate-y-0" : "-translate-y-3"
                }`}
              >
                <motion.button
                  whileTap={mobileApple ? { scale: 0.88 } : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(-1); // route unmount → minimize, playback continues
                  }}
                  aria-label={t("player.back")}
                  className={mobileApple ? "ios-circle-button !h-10 !w-10 shrink-0" : "text-zinc-300 transition hover:text-white"}
                >
                  <ArrowLeft size={26} />
                </motion.button>
                <div className="min-w-0">
                  <h1 className="truncate text-[15px] font-bold md:text-lg md:font-medium">{session?.title}</h1>
                  {session?.subtitle && (
                    <p className="truncate text-[11px] text-zinc-400 md:text-sm">{session.subtitle}</p>
                  )}
                </div>
              </div>

              {/* Bottom bar */}
              <div
                ref={controlsBarRef}
                className={`px-4 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] transition-transform duration-300 md:p-5 ${
                  controlsVisible ? "translate-y-0" : "translate-y-3"
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Seek preview stays local while dragging, then commits once on release. */}
                <div className="mb-5 flex items-center gap-2 text-[10px] text-zinc-300 md:mb-3 md:gap-3 md:text-xs">
                  <span className="w-10 text-right font-medium tabular-nums md:w-14">
                    {formatClock(displayedTime)}
                  </span>
                  <div className="group relative flex-1">
                    <AnimatePresence>
                      {scrubTime !== null && (
                        <motion.div
                          initial={{ opacity: 0, y: 4, scale: 0.92 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 4, scale: 0.94 }}
                          className="pointer-events-none absolute bottom-7 z-10 -translate-x-1/2 rounded-lg border border-white/10 bg-black/85 px-2.5 py-1.5 text-xs font-bold tabular-nums shadow-xl backdrop-blur-xl"
                          style={{ left: `${Math.max(4, Math.min(96, progressPercent))}%` }}
                        >
                          {formatClock(scrubTime)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={0.25}
                      value={displayedTime}
                      disabled={duration <= 0}
                      aria-label="Playback position"
                      aria-valuetext={`${formatClock(displayedTime)} of ${formatClock(duration)}`}
                      onPointerDown={(event) => {
                        scrubPointerActiveRef.current = true;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        previewSeek(Number(event.currentTarget.value));
                      }}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (scrubPointerActiveRef.current) previewSeek(value);
                        else commitSeek(value);
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        if (scrubPointerActiveRef.current) {
                          scrubPointerActiveRef.current = false;
                          commitSeek(Number(event.currentTarget.value));
                        }
                      }}
                      onPointerCancel={() => {
                        scrubPointerActiveRef.current = false;
                        scrubTimeRef.current = null;
                        setScrubTime(null);
                      }}
                      onLostPointerCapture={() => {
                        if (scrubPointerActiveRef.current) {
                          scrubPointerActiveRef.current = false;
                          commitSeek();
                        }
                      }}
                      onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
                      onBlur={() => {
                        if (scrubTimeRef.current !== null) commitSeek();
                      }}
                      style={timelineStyle}
                      className="akflix-range w-full"
                    />
                  </div>
                  <span className="w-10 font-medium tabular-nums text-zinc-400 md:w-14">
                    {formatClock(duration)}
                  </span>
                </div>

                <div className="flex items-center justify-center gap-5 md:justify-start md:gap-3">
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.86 } : undefined}
                    onClick={() => usePlayback.getState().controls?.toggle()}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause (Space)" : "Play (Space)"}
                    className={mobileApple ? "order-2 flex h-14 w-14 items-center justify-center rounded-full bg-white text-black" : "flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-lg transition hover:scale-105 hover:bg-zinc-200"}
                  >
                    {isPlaying ? (
                      <Pause size={mobileApple ? 25 : 28} fill={mobileApple ? "currentColor" : "none"} />
                    ) : (
                      <Play size={mobileApple ? 25 : 28} fill="currentColor" className={mobileApple ? "ml-1" : ""} />
                    )}
                  </motion.button>
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.82 } : undefined}
                    onClick={() => jumpBy(-SEEK_SECONDS)}
                    aria-label="Back 10 seconds"
                    title="Back 10 seconds"
                    className={mobileApple ? "order-1 flex h-11 w-11 items-center justify-center text-white" : "flex h-10 w-10 items-center justify-center rounded-full text-zinc-200 transition hover:bg-white/10 hover:text-white"}
                  >
                    <RotateCcw size={mobileApple ? 27 : 22} />
                  </motion.button>
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.82 } : undefined}
                    onClick={() => jumpBy(SEEK_SECONDS)}
                    aria-label="Forward 10 seconds"
                    title="Forward 10 seconds"
                    className={mobileApple ? "order-3 flex h-11 w-11 items-center justify-center text-white" : "flex h-10 w-10 items-center justify-center rounded-full text-zinc-200 transition hover:bg-white/10 hover:text-white"}
                  >
                    <RotateCw size={mobileApple ? 27 : 22} />
                  </motion.button>
                  {!mobileApple && (
                    <button
                      onClick={() => commitSeek(0)}
                      disabled={duration <= 0}
                      title="Restart from beginning"
                      className="desktop-control desktop-secondary"
                    >
                      <RotateCcw size={17} /> Restart
                    </button>
                  )}
                  {hasNext && (
                    <motion.button
                      whileTap={{ scale: 0.86 }}
                      whileHover={!mobileApple ? { scale: 1.08 } : undefined}
                      onClick={() => usePlayback.getState().controls?.next()}
                      aria-label="Next episode"
                      title="Next episode"
                      className={mobileApple ? "order-4 text-zinc-300" : "desktop-control desktop-secondary"}
                    >
                      <SkipForward size={24} />
                      {!mobileApple && <span>Next episode</span>}
                    </motion.button>
                  )}
                  {!mobileApple && (
                    <div
                      className="group/volume ml-1 flex items-center gap-2 rounded-full px-2 py-1 transition hover:bg-white/[0.06]"
                      onWheel={(event) => {
                        event.preventDefault();
                        usePlayback.getState().controls?.setVolume(
                          usePlayback.getState().volume + (event.deltaY < 0 ? 0.05 : -0.05)
                        );
                      }}
                    >
                      <button
                        onClick={() => usePlayback.getState().controls?.setMuted(!muted)}
                        aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                        title={muted || volume === 0 ? "Unmute" : "Mute"}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-200 transition hover:text-white"
                      >
                        {muted || volume === 0 ? (
                          <VolumeX size={21} />
                        ) : volume < 0.5 ? (
                          <Volume1 size={21} />
                        ) : (
                          <Volume2 size={21} />
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={muted ? 0 : volume}
                        onChange={(event) =>
                          usePlayback.getState().controls?.setVolume(Number(event.target.value))
                        }
                        aria-label="Volume"
                        aria-valuetext={`${Math.round(volumePercent)} percent`}
                        title={`Volume ${Math.round(volumePercent)}%`}
                        style={volumeStyle}
                        className="akflix-range akflix-volume w-24"
                      />
                    </div>
                  )}

                  <div className={mobileApple ? "absolute bottom-[calc(env(safe-area-inset-bottom,0px)+27px)] right-4 flex items-center gap-3" : "ml-auto flex items-center gap-5"}>
                    <div className="relative">
                        <motion.button
                          whileTap={{ scale: 0.86 }}
                          onClick={() => {
                            setSpeedMenuOpen(false);
                            setSubMenuOpen((o) => !o);
                          }}
                          aria-label={t("player.subtitles")}
                          aria-pressed={activeSub >= 0}
                          aria-expanded={subMenuOpen}
                          className={`rounded-lg p-1 transition ${
                            activeSub >= 0
                              ? "bg-white text-black"
                              : "text-zinc-300 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          <Subtitles size={22} />
                        </motion.button>
                        <AnimatePresence>
                          {subMenuOpen && (
                            <motion.div
                              initial={{ opacity: 0, y: 12, scale: 0.94 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: 8, scale: 0.96 }}
                              transition={{ type: "spring", stiffness: 430, damping: 32 }}
                              role="menu"
                              aria-label="Captions"
                              className="absolute bottom-10 right-0 max-h-[70vh] w-80 origin-bottom-right overflow-y-auto rounded-2xl border border-white/15 bg-[#101010]/95 p-1.5 shadow-2xl backdrop-blur-xl"
                            >
                              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
                                Captions
                              </p>
                              <button
                                onClick={() => void toggleGeneratedCaptions()}
                                disabled={captionTask === "syncing" || !captionKey}
                                className="mb-1 flex w-full items-center gap-3 rounded-xl border border-white/20 bg-white/[0.06] px-3 py-2.5 text-left transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-black">
                                  <AudioLines size={16} className={captionTask === "generating" ? "animate-pulse" : ""} />
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-sm font-semibold text-zinc-100">
                                    {captionTask === "generating" ? "Pause live captions" : "Generate live captions"}
                                  </span>
                                  <span className="block text-[10px] text-zinc-400">
                                    Private speech recognition, saved for this episode
                                  </span>
                                </span>
                              </button>

                              <button
                                onClick={() => void autoSyncCurrentCaption()}
                                disabled={!!captionTask || !subTracks.some((track) => track.index === activeSub)}
                                className="mb-1 flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-left transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-zinc-300">
                                  {captionTask === "syncing" ? <LoaderCircle size={16} className="animate-spin" /> : <RotateCw size={16} />}
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-sm font-semibold text-zinc-200">
                                    {captionTask === "syncing" ? "Matching dialogue..." : "Auto sync selected captions"}
                                  </span>
                                  <span className="block text-[10px] text-zinc-400">
                                    Listens and corrects the caption timing
                                  </span>
                                </span>
                              </button>

                              {manualCaption && (
                                <div className="mb-1 rounded-xl border border-white/[0.08] bg-black/25 p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="truncate text-xs font-semibold text-zinc-200">
                                        {manualCaption.name}
                                      </p>
                                      <p className="mt-0.5 text-[10px] text-zinc-400">
                                        {manualCaption.kind === "generated" ? "Generated from the video audio" : "Timing matched to spoken dialogue"}
                                      </p>
                                    </div>
                                    <button
                                      onClick={deleteManualCaption}
                                      aria-label="Remove Akflix captions"
                                      title="Remove Akflix captions"
                                      className="rounded-lg p-1.5 text-zinc-300 transition hover:bg-white hover:text-black"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                  <div className="mt-3 flex items-center justify-between gap-2">
                                    <button
                                      onClick={() => adjustManualCaption(-0.5)}
                                      className="flex h-8 items-center gap-1 rounded-lg bg-white/[0.06] px-2.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-white/10"
                                    >
                                      <Minus size={12} /> 0.5s
                                    </button>
                                    <button
                                      onClick={() => adjustManualCaption(-manualCaption.offsetSeconds)}
                                      title="Reset caption timing"
                                      className="min-w-[72px] rounded-lg px-2 py-1 text-center text-[11px] font-bold tabular-nums text-white transition hover:bg-white/[0.08]"
                                    >
                                      {manualCaption.offsetSeconds > 0 ? "+" : ""}
                                      {manualCaption.offsetSeconds.toFixed(1)}s
                                    </button>
                                    <button
                                      onClick={() => adjustManualCaption(0.5)}
                                      className="flex h-8 items-center gap-1 rounded-lg bg-white/[0.06] px-2.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-white/10"
                                    >
                                      <Plus size={12} /> 0.5s
                                    </button>
                                  </div>
                                  <p className="mt-2 text-[9px] leading-4 text-zinc-400">
                                    Timing is automatic. Minus and plus are available for a final personal adjustment.
                                  </p>
                                </div>
                              )}

                              <div className="my-1 border-t border-white/[0.06]" />
                              <button
                                onClick={() => {
                                  setActiveSub(-1);
                                  setSubMenuOpen(false);
                                }}
                                role="menuitemradio"
                                aria-checked={activeSub === -1}
                                className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                  activeSub === -1 ? "font-semibold text-white" : "text-zinc-300"
                                }`}
                              >
                                {t("player.subtitlesOff")}
                                {activeSub === -1 && <Check size={15} aria-hidden="true" />}
                              </button>
                              {allSubTracks.map((s) => (
                                <button
                                  key={s.index}
                                  onClick={() => {
                                    setActiveSub(s.index);
                                    setSubMenuOpen(false);
                                  }}
                                  role="menuitemradio"
                                  aria-checked={activeSub === s.index}
                                  className={`block w-full truncate rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                    activeSub === s.index ? "font-semibold text-white" : "text-zinc-300"
                                  }`}
                                >
                                  <span className="flex items-center justify-between gap-2">
                                    <span className="truncate">{s.label}</span>
                                    <span className="flex shrink-0 items-center gap-2">
                                      {s.manual && (
                                        <span className="rounded-full border border-white/30 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-zinc-200">
                                          Akflix
                                        </span>
                                      )}
                                      {activeSub === s.index && <Check size={15} aria-hidden="true" />}
                                    </span>
                                  </span>
                                </button>
                              ))}
                              {!allSubTracks.length && (
                                <p className="px-3 py-2 text-xs leading-5 text-zinc-400">
                                  No captions are available for this source.
                                </p>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                    <div className="relative">
                      <motion.button
                        whileTap={{ scale: 0.86 }}
                        onClick={() => {
                          setSubMenuOpen(false);
                          setSpeedMenuOpen((open) => !open);
                        }}
                        aria-label={`Playback speed ${playbackRate}x`}
                        aria-expanded={speedMenuOpen}
                        className={`flex items-center gap-1 rounded-lg px-1 py-0.5 transition ${playbackRate !== 1 ? "bg-white text-black" : "text-zinc-300 hover:bg-white/10 hover:text-white"}`}
                      >
                        <Gauge size={21} />
                        <span className="text-[11px] font-bold tabular-nums">{playbackRate}x</span>
                      </motion.button>
                      <AnimatePresence>
                        {speedMenuOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 12, scale: 0.94 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.96 }}
                            transition={{ type: "spring", stiffness: 430, damping: 32 }}
                            role="menu"
                            aria-label="Playback speed"
                            className="absolute bottom-10 right-0 w-40 origin-bottom-right overflow-hidden rounded-2xl border border-white/15 bg-[#101010]/95 p-1.5 shadow-2xl backdrop-blur-xl"
                          >
                            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
                              Playback speed
                            </p>
                            {PLAYBACK_RATES.map((rate) => (
                              <button
                                key={rate}
                                onClick={() => {
                                  usePlayback.getState().controls?.setPlaybackRate(rate);
                                  setSpeedMenuOpen(false);
                                }}
                                role="menuitemradio"
                                aria-checked={playbackRate === rate}
                                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                  playbackRate === rate ? "font-semibold text-white" : "text-zinc-300"
                                }`}
                              >
                                <span>{rate === 1 ? "Normal" : `${rate}x`}</span>
                                {playbackRate === rate && <Check size={15} aria-hidden="true" />}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void togglePictureInPicture();
                      }}
                      aria-label={pictureInPicture ? "Close picture in picture" : "Picture in picture"}
                      title={pictureInPicture ? "Close picture in picture" : "Picture in picture"}
                      aria-pressed={pictureInPicture}
                      className={`rounded-lg p-1 transition ${
                        pictureInPicture ? "bg-white text-black" : "text-zinc-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <PictureInPicture2 size={22} />
                    </button>

                    {!mobileApple && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleFullscreen();
                        }}
                        aria-label="Fullscreen"
                        className="rounded-lg p-1 text-zinc-300 transition hover:bg-white/10 hover:text-white"
                      >
                        <Maximize size={22} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
          </div>
        )}
        {expanded && !error && (
          <SkipControls
            button={skipButton}
            notice={skipNotice}
            upNext={upNext}
            raised={controlsVisible}
            touch={mobileApple}
            onSkip={skipNow}
            onUndo={undoAutoSkip}
            onNext={() => void usePlayback.getState().controls?.next()}
            onWatchCredits={() => setCreditsDismissed(true)}
          />
        )}
      </motion.div>

      {/* Bottom Now-Playing bar (mini mode only). Entrance-only animation —
          it unmounts instantly, which is what you want when expanding. */}
      {!expanded && session && <MiniPlayer />}

      {/* In-flow spacer so page content can scroll clear of the fixed bar. */}
      {!expanded && session && <div className={mobileApple ? "h-24" : "h-20"} aria-hidden />}
    </>
  );
}
