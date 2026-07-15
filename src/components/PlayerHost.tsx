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
import { motion } from "framer-motion";
import {
  ArrowLeft,
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
import { useJellyfinClient } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import { usePlayback } from "@/stores/playbackStore";
import type { DirectPlaybackRequest } from "@/stores/playbackStore";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import { formatClock, ticksToSeconds } from "@/lib/utils";
import { setCompatibilityStreamPaused } from "@/lib/compatStream";
import MiniPlayer from "@/components/MiniPlayer";
import type { MediaSource, MediaStream } from "@/types/jellyfin";

const PROGRESS_INTERVAL_MS = 10_000;

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

export default function PlayerHost() {
  const t = useT();
  const navigate = useNavigate();
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
  const loadSeq = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  const [subTracks, setSubTracks] = useState<SubTrack[]>([]);
  const [activeSub, setActiveSub] = useState(-1);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Teardown helpers ─────────────────────────────────────────────────

  const reportStopped = useCallback(() => {
    const v = videoRef.current;
    clearTimeout(directRetryTimer.current);
    const s = jfSessionRef.current;
    if (client && v && s) {
      client
        .reportStopped(s.itemId, s.mediaSourceId, s.playSessionId, v.currentTime)
        .catch(() => {});
    }
    jfSessionRef.current = null;
  }, [client]);

  const teardown = useCallback(() => {
    reportStopped();
    hlsRef.current?.destroy();
    hlsRef.current = null;
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
        if (isEpisode && item.SeriesId && item.SeasonId) {
          client
            .episodes(item.SeriesId, item.SeasonId)
            .then((r) => {
              if (seq !== loadSeq.current) return;
              const i = r.Items.findIndex((e) => e.Id === itemId);
              const next = i >= 0 ? r.Items[i + 1] : undefined;
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
      setError(null);
      setSubTracks([]);
      setActiveSub(-1);
      nextEpisodeRef.current = null;
      _sync({ buffering: true, hasNext: false, currentTime: 0, duration: 0 });
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
      await video.play().catch(() => {});
      if (seq === loadSeq.current) _sync({ buffering: false });
    },
    [_setSession, _sync, teardown]
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
    if (!nextId) return false;
    // Load first, then update the route/store. Updating requestedItemId before
    // load() finishes makes the request effect race this direct call and can
    // negotiate the next episode twice on a slow server.
    await load(nextId);
    if (jfSessionRef.current?.itemId !== nextId) return false;
    usePlayback.setState({ requestedItemId: nextId });
    if (usePlayback.getState().mode === "expanded") {
      navigate(`/play/${nextId}`, { replace: true });
    }
    return true;
  }, [load, navigate]);

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
        const v = videoRef.current;
        if (v) v.currentTime = sec;
      },
      seekBy: (delta) => {
        const v = videoRef.current;
        if (v) v.currentTime += delta;
      },
      setMuted: (m) => {
        const v = videoRef.current;
        if (v) {
          v.muted = m;
          _sync({ muted: m });
        }
      },
      next: playNext,
    });
    return () => _setControls(null);
  }, [client, playNext, _setControls, _sync]);

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
      if (v && !v.paused && !subMenuOpen) setControlsVisible(false);
    }, 3000);
  }, [subMenuOpen]);

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
    if (session?.direct || !(await playNext())) {
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
          if (expanded) poke();
          else if (session) {
            usePlayback.getState().expand();
            navigate(session.direct ? "/stream" : `/play/${session.itemId}`);
          }
        }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        className={
          expanded
            ? "fixed inset-0 z-50 bg-black"
            : "fixed bottom-24 right-4 z-40 aspect-video w-64 cursor-pointer overflow-hidden rounded-lg border border-zinc-700 bg-black shadow-2xl"
        }
      >
        <video
          ref={videoRef}
          className="h-full w-full"
          onPlay={() => {
            _sync({ isPlaying: true });
            if (session?.direct && activeStreamHash) {
              setCompatibilityStreamPaused(activeStreamHash, false).catch(() => {});
            }
          }}
          onPause={() => {
            _sync({ isPlaying: false });
            if (session?.direct && activeStreamHash) {
              setCompatibilityStreamPaused(activeStreamHash, true).catch(() => {});
            }
          }}
          onWaiting={() => _sync({ buffering: true })}
          onPlaying={() => _sync({ buffering: false })}
          onTimeUpdate={(e) => _sync({ currentTime: e.currentTarget.currentTime })}
          onDurationChange={(e) => _sync({ duration: e.currentTarget.duration })}
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
                video.src = `${directRequest.url}${directRequest.url.includes("?") ? "&" : "?"}retry=${attempt}`;
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
          onEnded={onEnded}
          onDoubleClick={() => expanded && usePlayback.getState().controls?.toggle()}
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
                className={`flex items-center gap-4 p-5 transition-transform duration-300 ${
                  controlsVisible ? "translate-y-0" : "-translate-y-3"
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(-1); // route unmount → minimize, playback continues
                  }}
                  aria-label={t("player.back")}
                  className="text-zinc-300 transition hover:text-white"
                >
                  <ArrowLeft size={26} />
                </button>
                <div className="min-w-0">
                  <h1 className="truncate text-lg font-medium">{session?.title}</h1>
                  {session?.subtitle && (
                    <p className="truncate text-sm text-zinc-400">{session.subtitle}</p>
                  )}
                </div>
              </div>

              {/* Bottom bar */}
              <div
                className={`p-5 transition-transform duration-300 ${
                  controlsVisible ? "translate-y-0" : "translate-y-3"
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Scrubber */}
                <div className="mb-3 flex items-center gap-3 text-xs text-zinc-300">
                  <span className="w-14 text-right tabular-nums">
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
                  <span className="w-14 tabular-nums">{formatClock(duration)}</span>
                </div>

                <div className="flex items-center gap-5">
                  <button
                    onClick={() => usePlayback.getState().controls?.toggle()}
                    aria-label="Play/Pause"
                    className="transition hover:text-brand"
                  >
                    {isPlaying ? (
                      <Pause size={28} />
                    ) : (
                      <Play size={28} fill="currentColor" />
                    )}
                  </button>
                  <button
                    onClick={() => usePlayback.getState().controls?.seekBy(-10)}
                    aria-label="Back 10s"
                    className="text-zinc-300 transition hover:text-white"
                  >
                    <RotateCcw size={22} />
                  </button>
                  <button
                    onClick={() => usePlayback.getState().controls?.seekBy(10)}
                    aria-label="Forward 10s"
                    className="text-zinc-300 transition hover:text-white"
                  >
                    <RotateCw size={22} />
                  </button>
                  {hasNext && (
                    <button
                      onClick={() => usePlayback.getState().controls?.next()}
                      aria-label="Next episode"
                      className="text-zinc-300 transition hover:text-white"
                    >
                      <SkipForward size={24} />
                    </button>
                  )}
                  <button
                    onClick={() => usePlayback.getState().controls?.setMuted(!muted)}
                    aria-label="Mute"
                    className="text-zinc-300 transition hover:text-white"
                  >
                    {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
                  </button>

                  <div className="ml-auto flex items-center gap-5">
                    {subTracks.length > 0 && (
                      <div className="relative">
                        <button
                          onClick={() => setSubMenuOpen((o) => !o)}
                          aria-label={t("player.subtitles")}
                          className={
                            activeSub >= 0
                              ? "text-brand"
                              : "text-zinc-300 transition hover:text-white"
                          }
                        >
                          <Subtitles size={22} />
                        </button>
                        {subMenuOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="absolute bottom-10 right-0 w-52 rounded-md border border-zinc-800 bg-surface-raised py-1 shadow-xl"
                          >
                              <button
                                onClick={() => {
                                  setActiveSub(-1);
                                  setSubMenuOpen(false);
                                }}
                                className={`block w-full px-4 py-2 text-left text-sm hover:bg-white/10 ${
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
                                className={`block w-full truncate px-4 py-2 text-left text-sm hover:bg-white/10 ${
                                  activeSub === s.index ? "text-brand" : ""
                                }`}
                              >
                                {s.label}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() =>
                        document.fullscreenElement
                          ? document.exitFullscreen()
                          : document.getElementById("player-surface")?.requestFullscreen()
                      }
                      aria-label="Fullscreen"
                      className="text-zinc-300 transition hover:text-white"
                    >
                      <Maximize size={22} />
                    </button>
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
      {!expanded && session && <div className="h-20" aria-hidden />}
    </>
  );
}
