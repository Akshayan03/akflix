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

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type Hls from "hls.js";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Gauge,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Subtitles,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth, useJellyfinClient } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import { usePlayback } from "@/stores/playbackStore";
import type { DirectEpisodeTarget, DirectPlaybackRequest } from "@/stores/playbackStore";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import { formatClock, ticksToSeconds } from "@/lib/utils";
import { isAppleMobile } from "@/lib/platform";
import {
  setCompatibilityStreamPaused,
  startCompatibilityStream,
  startCompatibilityStreamUrl,
} from "@/lib/compatStream";
import { iosNativeSources } from "@/lib/iosSourceCompatibility";
import { englishSafeSources } from "@/lib/sourceLanguage";
import { directSubtitleTracks } from "@/api/subtitles";
import MiniPlayer from "@/components/MiniPlayer";
import type { MediaSource, MediaStream } from "@/types/jellyfin";
import { useHistory, type HistoryTitle } from "@/stores/historyStore";

const PROGRESS_INTERVAL_MS = 10_000;
const LOCAL_HISTORY_INTERVAL_MS = 5_000;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

interface SubTrack {
  index: number;
  label: string;
  language?: string;
  url: string;
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)
  );
};

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
  completed = false
) {
  if (!request || !video) return;
  const media = directHistoryTitle(request);
  if (!media) return;
  const currentTime = request.compatibility
    ? request.compatibility.startSeconds + video.currentTime
    : video.currentTime;
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
  const activeStreamHash = useTorrents((s) => s.activeStreamHash);
  const finishActiveStream = useTorrents((s) => s.finishActiveStream);

  const {
    requestedItemId,
    requestedDirect,
    session,
    mode,
    isPlaying,
    muted,
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
  const directIdRef = useRef<string | null>(null);
  const directRequestRef = useRef<DirectPlaybackRequest | null>(null);
  const directRetryRef = useRef(0);
  const directRetryTimer = useRef<ReturnType<typeof setTimeout>>();
  const compatibilitySeekTimer = useRef<ReturnType<typeof setTimeout>>();
  const compatibilitySeekSequence = useRef(0);
  const directResumeAppliedRef = useRef<string | null>(null);
  const lastLocalHistoryWrite = useRef(0);
  const loadSeq = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const subtitleBlobUrlsRef = useRef<string[]>([]);

  const [subTracks, setSubTracks] = useState<SubTrack[]>([]);
  const [activeSub, setActiveSub] = useState(-1);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Teardown helpers ─────────────────────────────────────────────────

  const reportStopped = useCallback(() => {
    const v = videoRef.current;
    clearTimeout(directRetryTimer.current);
    clearTimeout(compatibilitySeekTimer.current);
    const s = jfSessionRef.current;
    if (client && v && s) {
      client
        .reportStopped(s.itemId, s.mediaSourceId, s.playSessionId, v.currentTime)
        .catch(() => {});
    }
    jfSessionRef.current = null;
  }, [client]);

  const teardown = useCallback(() => {
    saveDirectProgress(directRequestRef.current, videoRef.current);
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
  }, [reportStopped]);

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
              _sync({ hasNext: !!next });
            })
            .catch(() => {});
        }

        // Attach the stream.
        const { url, isHls } = client.streamUrl(itemId, source as MediaSource, info.PlaySessionId);
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
        video.playbackRate = usePlayback.getState().playbackRate;
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
    [client, subtitleLanguage, teardown, _setSession, _sync, t]
  );

  /** Local progressive playback bypasses Jellyfin's slow incomplete-file probe. */
  const loadDirect = useCallback(
    async (request: DirectPlaybackRequest) => {
      const video = videoRef.current;
      if (!video) return;
      const seq = ++loadSeq.current;
      teardown();
      directIdRef.current = request.id;
      directRequestRef.current = request;
      directRetryRef.current = 0;
      directResumeAppliedRef.current = null;
      lastLocalHistoryWrite.current = 0;
      setError(null);
      setSubTracks([]);
      setActiveSub(-1);
      nextEpisodeRef.current = null;
      _sync({
        buffering: true,
        hasNext: !!request.episodeQueue?.length,
        currentTime: 0,
        duration: request.durationSeconds ?? 0,
      });
      _setSession({
        itemId: request.id,
        title: request.title,
        subtitle: request.subtitle,
        posterUrl: request.posterUrl ?? null,
        isEpisode: request.isEpisode ?? false,
        direct: true,
      });
      video.src = request.url;
      video.preload = "auto";
      video.playbackRate = usePlayback.getState().playbackRate;
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
            }));
            setSubTracks(prepared);
            const preferred = prepared.find(
              (track) => track.language === subtitleLanguage
            );
            if (preferred) setActiveSub(preferred.index);
          })
          .catch(() => {});
      }
    },
    [_setSession, _sync, subtitleLanguage, teardown]
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
    if (directIdRef.current === requestedDirect.id) return;
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
      videoRef.current?.pause();
      _sync({ buffering: true, hasNext: false, currentTime: 0, duration: 0 });
      toast.info("Loading the next episode", {
        description: nextMedia.subtitle,
      });
      const torrentState = useTorrents.getState();
      const results = await torrentState.search(current.title, undefined, {
        imdbId: current.catalogId,
        type: "series",
        season: next.season,
        episode: next.episode,
      });
      let eligible = englishSafeSources(results);
      if (mobileApple) eligible = iosNativeSources(eligible);
      if (!eligible.length) throw new Error("No compatible source was found for the next episode.");

      await finishActiveStream().catch(() => {});
      const hosted = eligible.find((result) => result.streamUrl);
      if (hosted?.streamUrl) {
        usePlayback.getState().openDirect({
          ...nextMedia,
          id: hosted.guid,
          url: hosted.streamUrl,
        });
      } else {
        await torrentState.raceStreamSources(eligible, nextMedia);
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
  }, [finishActiveStream, load, mobileApple, navigate, _sync]);

  const seekPlayback = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const request = directRequestRef.current;
      const compatibility = request?.compatibility;
      if (!request || !compatibility) {
        video.currentTime = Math.max(0, seconds);
        return;
      }

      const limit = request.durationSeconds ?? Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(seconds, Math.max(0, limit - 1)));
      const sequence = ++compatibilitySeekSequence.current;
      clearTimeout(compatibilitySeekTimer.current);
      _sync({ currentTime: target, buffering: true });

      compatibilitySeekTimer.current = setTimeout(() => {
        const restart = async () => {
          const activeRequest = directRequestRef.current;
          if (
            sequence !== compatibilitySeekSequence.current ||
            activeRequest?.id !== request.id ||
            !activeRequest.compatibility
          ) {
            return;
          }

          video.pause();
          try {
            const source = activeRequest.compatibility;
            const url = source.inputUrl
              ? await startCompatibilityStreamUrl(
                  source.inputUrl,
                  source.streamId,
                  source.audioLanguage,
                  target
                )
              : source.filename
                ? await startCompatibilityStream(
                    source.filename,
                    source.streamId,
                    source.audioLanguage,
                    target
                  )
                : null;
            if (!url) throw new Error("The conversion source is unavailable.");
            if (
              sequence !== compatibilitySeekSequence.current ||
              directRequestRef.current?.id !== request.id
            ) {
              return;
            }

            source.startSeconds = target;
            activeRequest.url = url;
            directRetryRef.current = 0;
            setError(null);
            video.src = `${url}${url.includes("?") ? "&" : "?"}seek=${Date.now()}`;
            video.load();
            video.playbackRate = usePlayback.getState().playbackRate;
            await video.play().catch(() => {});
          } catch (reason) {
            _sync({ buffering: false });
            toast.error("Could not jump to that point", {
              description: reason instanceof Error ? reason.message : String(reason),
            });
          }
        };
        void restart();
      }, 280);
    },
    [_sync]
  );

  useEffect(() => {
    _setControls({
      toggle: () => {
        const v = videoRef.current;
        if (!v) return;
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
      seek: (sec) => {
        seekPlayback(sec);
      },
      seekBy: (delta) => {
        seekPlayback(usePlayback.getState().currentTime + delta);
      },
      setMuted: (m) => {
        const v = videoRef.current;
        if (v) {
          v.muted = m;
          _sync({ muted: m });
        }
      },
      setPlaybackRate: (rate) => {
        const v = videoRef.current;
        if (!v) return;
        v.playbackRate = rate;
        _sync({ playbackRate: rate });
      },
      next: playNext,
    });
    return () => _setControls(null);
  }, [client, playNext, seekPlayback, _setControls, _sync]);

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

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          ctrl.toggle();
          break;
        case "ArrowLeft":
          if (expanded) ctrl.seekBy(-10);
          break;
        case "ArrowRight":
          if (expanded) ctrl.seekBy(10);
          break;
        case "f":
          if (expanded)
            document.fullscreenElement
              ? document.exitFullscreen()
              : document.getElementById("player-surface")?.requestFullscreen();
          break;
        case "m":
          ctrl.setMuted(!v.muted);
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
  }, []);

  // ── Controls auto-hide ───────────────────────────────────────────────
  const poke = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // Keep controls up while paused or while a menu is open.
      const v = videoRef.current;
      if (v && !v.paused && !subMenuOpen && !speedMenuOpen) setControlsVisible(false);
    }, 3000);
  }, [speedMenuOpen, subMenuOpen]);

  useEffect(() => {
    if (mode === "expanded") poke();
    return () => clearTimeout(hideTimer.current);
  }, [mode, poke]);

  // ── Subtitle track switching ─────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    for (const track of Array.from(v.textTracks)) {
      track.mode = Number(track.id) === activeSub ? "showing" : "hidden";
    }
  }, [activeSub, subTracks]);

  // ── Render ───────────────────────────────────────────────────────────

  if (!session && !requestedItemId && !requestedDirect) return null;

  const expanded = mode === "expanded";
  const onEnded = async () => {
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
            _sync({ isPlaying: false });
            saveDirectProgress(directRequestRef.current, videoRef.current);
            if (session?.direct && activeStreamHash) {
              setCompatibilityStreamPaused(activeStreamHash, true).catch(() => {});
            }
          }}
          onWaiting={() => _sync({ buffering: true })}
          onPlaying={() => _sync({ buffering: false })}
          onTimeUpdate={(e) => {
            const video = e.currentTarget;
            const request = directRequestRef.current;
            const timelineTime = request?.compatibility
              ? request.compatibility.startSeconds + video.currentTime
              : video.currentTime;
            _sync({ currentTime: timelineTime });
            if (
              directRequestRef.current &&
              Date.now() - lastLocalHistoryWrite.current >= LOCAL_HISTORY_INTERVAL_MS
            ) {
              lastLocalHistoryWrite.current = Date.now();
              saveDirectProgress(directRequestRef.current, video);
            }
          }}
          onDurationChange={(e) => {
            const request = directRequestRef.current;
            const mediaDuration =
              request?.durationSeconds && request.durationSeconds > 0
                ? request.durationSeconds
                : e.currentTarget.duration;
            _sync({ duration: Number.isFinite(mediaDuration) ? mediaDuration : 0 });
          }}
          onLoadedMetadata={(e) => {
            const request = directRequestRef.current;
            const video = e.currentTarget;
            const media = request ? directHistoryTitle(request) : null;
            if (!request || !media || directResumeAppliedRef.current === request.id) return;
            directResumeAppliedRef.current = request.id;
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
            if (saved && saved.position > 10 && saved.position < mediaDuration - 5) {
              seekPlayback(saved.position);
              toast.info("Resuming where you left off", {
                description: `${formatClock(saved.position)} into ${request.title}`,
              });
            }
          }}
          onError={(e) => {
            const mediaError = e.currentTarget.error;
            const directRequest = directRequestRef.current;
            if (session?.direct && directRequest && directRetryRef.current < 6) {
              const attempt = ++directRetryRef.current;
              setError(null);
              _sync({ buffering: true });
              clearTimeout(directRetryTimer.current);
              directRetryTimer.current = setTimeout(() => {
                const video = videoRef.current;
                if (!video || directRequestRef.current?.id !== directRequest.id) return;
                // Hosted playback URLs are often signed. Appending a query
                // parameter invalidates their signature, so only cache-bust
                // Akflix's own local stream gateway.
                video.src = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//i.test(
                  directRequest.url
                )
                  ? `${directRequest.url}${directRequest.url.includes("?") ? "&" : "?"}retry=${attempt}`
                  : directRequest.url;
                video.load();
                video.play().catch(() => {});
              }, Math.min(6_000, 1_250 * attempt));
              return;
            }
            setError(
              mediaError?.message ||
                "This file is not playable yet. Let it buffer longer or choose a smaller 1080p source."
            );
            _sync({ buffering: false });
          }}
          onVolumeChange={(e) => _sync({ muted: e.currentTarget.muted })}
          onRateChange={(e) => _sync({ playbackRate: e.currentTarget.playbackRate })}
          onEnded={onEnded}
          onDoubleClick={() => !mobileApple && expanded && usePlayback.getState().controls?.toggle()}
        >
          {subTracks.map((s) => (
            <track
              key={s.index}
              id={String(s.index)}
              kind="subtitles"
              label={s.label}
              srcLang={s.language ?? "und"}
              src={s.url}
            />
          ))}
        </video>

        {/* Buffering spinner */}
        {buffering && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-brand" />
          </div>
        )}

        {/* Error state */}
        {error && expanded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8">
            <p className="max-w-lg whitespace-pre-wrap text-center text-sm text-red-400">
              {error}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                stop();
                navigate(-1);
              }}
              className="rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
            >
              {t("player.back")}
            </button>
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
                className={`px-4 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] transition-transform duration-300 md:p-5 ${
                  controlsVisible ? "translate-y-0" : "translate-y-3"
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Scrubber */}
                <div className="mb-5 flex items-center gap-2 text-[10px] text-zinc-300 md:mb-3 md:gap-3 md:text-xs">
                  <span className="w-10 text-right tabular-nums md:w-14">
                    {formatClock(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={1}
                    value={currentTime}
                    onChange={(e) =>
                      usePlayback.getState().controls?.seek(Number(e.target.value))
                    }
                    className="h-1 flex-1 cursor-pointer accent-brand"
                  />
                  <span className="w-10 tabular-nums md:w-14">{formatClock(duration)}</span>
                </div>

                <div className="flex items-center justify-center gap-6 md:justify-start md:gap-5">
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.86 } : undefined}
                    onClick={() => usePlayback.getState().controls?.toggle()}
                    aria-label="Play/Pause"
                    className={mobileApple ? "order-2 flex h-14 w-14 items-center justify-center rounded-full bg-white text-black" : "transition hover:text-brand"}
                  >
                    {isPlaying ? (
                      <Pause size={mobileApple ? 25 : 28} fill={mobileApple ? "currentColor" : "none"} />
                    ) : (
                      <Play size={mobileApple ? 25 : 28} fill="currentColor" className={mobileApple ? "ml-1" : ""} />
                    )}
                  </motion.button>
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.82 } : undefined}
                    onClick={() => usePlayback.getState().controls?.seekBy(-10)}
                    aria-label="Back 10s"
                    className={mobileApple ? "order-1 flex h-11 w-11 items-center justify-center text-white" : "text-zinc-300 transition hover:text-white"}
                  >
                    <RotateCcw size={mobileApple ? 27 : 22} />
                  </motion.button>
                  <motion.button
                    whileTap={mobileApple ? { scale: 0.82 } : undefined}
                    onClick={() => usePlayback.getState().controls?.seekBy(10)}
                    aria-label="Forward 10s"
                    className={mobileApple ? "order-3 flex h-11 w-11 items-center justify-center text-white" : "text-zinc-300 transition hover:text-white"}
                  >
                    <RotateCw size={mobileApple ? 27 : 22} />
                  </motion.button>
                  {hasNext && (
                    <motion.button
                      whileTap={{ scale: 0.86 }}
                      whileHover={!mobileApple ? { scale: 1.08 } : undefined}
                      onClick={() => usePlayback.getState().controls?.next()}
                      aria-label="Next episode"
                      className={`${mobileApple ? "order-4" : ""} text-zinc-300 transition hover:text-white`}
                    >
                      <SkipForward size={24} />
                    </motion.button>
                  )}
                  <button
                    onClick={() => usePlayback.getState().controls?.setMuted(!muted)}
                    aria-label="Mute"
                    className={`${mobileApple ? "hidden" : ""} text-zinc-300 transition hover:text-white`}
                  >
                    {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
                  </button>

                  <div className={mobileApple ? "absolute bottom-[calc(env(safe-area-inset-bottom,0px)+27px)] right-4 flex items-center gap-3" : "ml-auto flex items-center gap-5"}>
                    <div className="relative">
                        <motion.button
                          whileTap={{ scale: 0.86 }}
                          onClick={() => {
                            setSpeedMenuOpen(false);
                            setSubMenuOpen((o) => !o);
                          }}
                          aria-label={t("player.subtitles")}
                          className={
                            activeSub >= 0
                              ? "text-brand"
                              : "text-zinc-300 transition hover:text-white"
                          }
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
                              className="absolute bottom-10 right-0 w-56 origin-bottom-right overflow-hidden rounded-2xl border border-white/10 bg-[#15130f]/95 p-1.5 shadow-2xl backdrop-blur-xl"
                            >
                              <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                                Captions
                              </p>
                              <button
                                onClick={() => {
                                  setActiveSub(-1);
                                  setSubMenuOpen(false);
                                }}
                                className={`block w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                  activeSub === -1 ? "text-brand" : ""
                                }`}
                              >
                                {t("player.subtitlesOff")}
                              </button>
                              {subTracks.map((s) => (
                                <button
                                  key={s.index}
                                  onClick={() => {
                                    setActiveSub(s.index);
                                    setSubMenuOpen(false);
                                  }}
                                  className={`block w-full truncate rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                    activeSub === s.index ? "text-brand" : ""
                                  }`}
                                >
                                  {s.label}
                                </button>
                              ))}
                              {!subTracks.length && (
                                <p className="px-3 py-2 text-xs leading-5 text-zinc-500">
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
                        className="flex items-center gap-1 text-zinc-300 transition hover:text-white"
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
                            className="absolute bottom-10 right-0 w-40 origin-bottom-right overflow-hidden rounded-2xl border border-white/10 bg-[#15130f]/95 p-1.5 shadow-2xl backdrop-blur-xl"
                          >
                            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                              Playback speed
                            </p>
                            {PLAYBACK_RATES.map((rate) => (
                              <button
                                key={rate}
                                onClick={() => {
                                  usePlayback.getState().controls?.setPlaybackRate(rate);
                                  setSpeedMenuOpen(false);
                                }}
                                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                                  playbackRate === rate ? "text-brand" : "text-zinc-200"
                                }`}
                              >
                                <span>{rate === 1 ? "Normal" : `${rate}x`}</span>
                                {playbackRate === rate && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {!mobileApple && <button
                      onClick={() =>
                        document.fullscreenElement
                          ? document.exitFullscreen()
                          : document.getElementById("player-surface")?.requestFullscreen()
                      }
                      aria-label="Fullscreen"
                      className="text-zinc-300 transition hover:text-white"
                    >
                      <Maximize size={22} />
                    </button>}
                  </div>
                </div>
              </div>
          </div>
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
