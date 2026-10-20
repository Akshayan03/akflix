/**
 * Global temporary-stream coordinator.
 *
 * Torrentio's free sources are BitTorrent hashes, not hosted video URLs. A
 * "Stream now" session therefore receives sequential pieces into a temporary
 * qBittorrent cache and plays that growing file through the local range
 * gateway as soon as the opening pieces are ready. Jellyfin is deliberately
 * bypassed for temporary streams because probing an incomplete sparse file
 * can block for minutes. Offline downloads still import through Jellyfin.
 */

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTorrents } from "@/stores/torrentStore";
import { usePlayback } from "@/stores/playbackStore";
import { formatBytes, formatSpeed } from "@/lib/utils";
import { startCompatibilityStream, startCompatibilityStreamUrl } from "@/lib/compatStream";
import { useSettings } from "@/stores/settingsStore";
import Artwork from "@/components/Artwork";
import { mediaDisplayFromRelease } from "@/lib/mediaTitle";
import { decideStart, START_LIMITS, STAGE_LABELS, startStage, waitForFirstBytes } from "@/lib/streamStart";

const MIB = 1024 * 1024;
const STREAM_GATEWAY = "http://127.0.0.1:8097";

/** Roughly 20-45 seconds of a stream-friendly source, capped for fast starts. */
function needsCompatibility(filename: string | null): boolean {
  return !!filename && !/\.(mp4|m4v|mov|webm)$/i.test(filename);
}

function openingBuffer(size: number, compatibility = false): number {
  if (compatibility) return Math.max(6 * MIB, Math.min(12 * MIB, size * 0.003));
  return Math.max(3 * MIB, Math.min(8 * MIB, size * 0.001));
}

function gatewayUrl(filename: string): string {
  return `${STREAM_GATEWAY}/Streaming%20Cache/${filename
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export default function StreamController() {
  const navigate = useNavigate();
  const openDirect = usePlayback((state) => state.openDirect);
  const audioLanguage = useSettings((state) => state.audioLanguage);
  const {
    torrents,
    pendingStreamHash,
    startPolling,
    stopPolling,
    markStreamReady,
    cancelPendingStream,
    prepareStreamFile,
    pendingStreamFileName,
    pendingStreamFileIndex,
    pendingStreamFileSize,
    pendingStreamHeadBytes,
    pendingStreamFallbacks,
    pendingStreamStartedAt,
    pendingStreamMedia,
    streamRequestId,
    failoverPendingStream,
    streamUrl,
    sourceRaceActive,
    sourceRaceMedia,
    cancelSourceRace,
    streamLaunchPhase,
    streamLaunchMedia,
    streamStartAttempt,
  } = useTorrents();
  const priorityBusy = useRef<number | null>(null);
  const handoffBusy = useRef<number | null>(null);
  const retryAfter = useRef(0);
  const failoverBusy = useRef<number | null>(null);
  /** `${requestId}:${hash}` whose first video byte was served, and when. */
  const firstByte = useRef<{ key: string; at: number } | null>(null);
  /** Failed player handoffs (a conversion that never started) for `${requestId}:${hash}`. */
  const handoffFailures = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  /** `${requestId}:${hash}` whose next source has been warmed up beside it. */
  const warmedFor = useRef("");

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  useEffect(() => {
    retryAfter.current = 0;
  }, [streamRequestId]);

  const torrent = pendingStreamHash
    ? torrents.find((entry) => entry.hash === pendingStreamHash)
    : undefined;
  const embeddedUrl =
    pendingStreamHash && pendingStreamFileIndex !== null
      ? streamUrl(pendingStreamHash, pendingStreamFileIndex)
      : null;
  const fallbackMedia = mediaDisplayFromRelease(
    pendingStreamFileName || torrent?.name || ""
  );
  const displayMedia = pendingStreamMedia ?? sourceRaceMedia ?? streamLaunchMedia;
  const displayTitle = displayMedia?.title?.trim() || fallbackMedia.title;
  const displaySubtitle = displayMedia?.subtitle?.trim() || fallbackMedia.subtitle;

  useEffect(() => {
    if (!pendingStreamHash || pendingStreamFileName || priorityBusy.current === streamRequestId) return;
    const requestId = streamRequestId;
    priorityBusy.current = requestId;
    prepareStreamFile(requestId)
      .catch(async (reason) => {
        // Without a selected file the engine keeps fetching the whole torrent
        // and the stall timer never fires. Move on to the next source.
        if (useTorrents.getState().streamRequestId !== requestId) return false;
        if (failoverBusy.current === requestId) return false;
        failoverBusy.current = requestId;
        const detail = reason instanceof Error ? reason.message : String(reason);
        try {
          const next = await failoverPendingStream(requestId);
          if (next) {
            toast.info("Trying another source", { description: detail });
          } else if (useTorrents.getState().streamRequestId === requestId) {
            await cancelPendingStream(requestId).catch(() => {});
            toast.error("Couldn’t start playback", { description: detail });
          }
        } catch (error) {
          toast.error("Couldn’t start playback", {
            description: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (failoverBusy.current === requestId) failoverBusy.current = null;
        }
        return false;
      })
      .finally(() => {
        if (priorityBusy.current === requestId) priorityBusy.current = null;
      });
  }, [cancelPendingStream, failoverPendingStream, pendingStreamFileName, pendingStreamHash, prepareStreamFile, streamRequestId, torrent]);

  // A source that cannot deliver its file list, a peer or the opening bytes in
  // time is replaced by the next ranked one, checked every second for as long
  // as it is pending (not once). With nothing left, the attempt ends with the
  // reason instead of an endless spinner.
  useEffect(() => {
    if (!pendingStreamHash || !pendingStreamStartedAt) return;
    const requestId = streamRequestId;
    const hash = pendingStreamHash;
    const check = () => {
      const state = useTorrents.getState();
      if (state.streamRequestId !== requestId || state.pendingStreamHash !== hash) return;
      if (failoverBusy.current === requestId) return;
      const current = state.torrents.find((entry) => entry.hash === hash);
      const key = `${requestId}:${hash}`;
      const served = firstByte.current?.key === key && Date.now() - firstByte.current.at < 30_000;
      const decision = decideStart({
        now: Date.now(),
        startedAt: state.pendingStreamStartedAt,
        requestStartedAt: state.streamRequestStartedAt,
        fileSelected: !!state.pendingStreamFileName,
        peers: current?.num_seeds ?? 0,
        downloadBps: current?.dlspeed ?? 0,
        firstByte: served || (!state.qbt().instantStreaming && state.pendingStreamHeadBytes > 0),
        fallbacks: state.pendingStreamFallbacks.length,
      });
      if (decision.kind === "wait") {
        if (
          !served &&
          state.qbt().instantStreaming &&
          warmedFor.current !== key &&
          state.pendingStreamFallbacks.length > 0 &&
          Date.now() - state.pendingStreamStartedAt >= START_LIMITS.warmNextAfterMs
        ) {
          warmedFor.current = key;
          void warmNextThenSwitch(key);
        }
        return;
      }
      failoverBusy.current = requestId;
      const title = state.pendingStreamMedia?.title;
      const tried = state.streamStartAttempt;
      (decision.kind === "failover" ? failoverPendingStream(requestId) : Promise.resolve(null))
        .then(async (next) => {
          if (next) {
            toast.info("Switching to another source", { description: decision.reason });
            return;
          }
          if (useTorrents.getState().streamRequestId !== requestId) return;
          await cancelPendingStream(requestId).catch(() => {});
          toast.error(title ? `Couldn’t start ${title}` : "Couldn’t start playback", {
            description: `${decision.reason} Akflix tried ${Math.max(1, tried)} source${tried === 1 ? "" : "s"}. Try again in a while or choose a source yourself.`,
          });
        })
        .catch((reason) => {
          toast.error("Couldn’t start playback", {
            description: reason instanceof Error ? reason.message : String(reason),
          });
        })
        .finally(() => {
          if (failoverBusy.current === requestId) failoverBusy.current = null;
        });
    };
    // The next ranked source started beside a silent one: switch if its first
    // bytes arrive while this one still has none, otherwise remove it.
    const warmNextThenSwitch = async (key: string) => {
      const next = await useTorrents.getState().warmNextSource(requestId);
      if (!next) return;
      const state = useTorrents.getState();
      if (
        state.streamRequestId === requestId &&
        state.pendingStreamHash === hash &&
        firstByte.current?.key !== key &&
        failoverBusy.current !== requestId
      ) {
        failoverBusy.current = requestId;
        try {
          if (await failoverPendingStream(requestId)) {
            toast.info("Switched to a faster source", { description: "The first source had not started sending video." });
          }
        } finally {
          if (failoverBusy.current === requestId) failoverBusy.current = null;
        }
      }
      await useTorrents.getState().discardWarmSource();
    };
    const timer = setInterval(check, 1_000);
    return () => clearInterval(timer);
  }, [cancelPendingStream, failoverPendingStream, pendingStreamHash, pendingStreamStartedAt, streamRequestId]);

  useEffect(() => {
    if (!pendingStreamHash || !torrent || !pendingStreamFileName) return;
    const selectedSize = pendingStreamFileSize || torrent.size;
    const compatibility = needsCompatibility(pendingStreamFileName);
    const bufferReady =
      !!embeddedUrl ||
      torrent.progress >= 1 ||
      pendingStreamHeadBytes >= openingBuffer(selectedSize, compatibility);
    if (!bufferReady || handoffBusy.current === streamRequestId || Date.now() < retryAfter.current) return;
    const requestId = streamRequestId;
    const handoffHash = pendingStreamHash;
    const stillCurrent = () => {
      const state = useTorrents.getState();
      return state.streamRequestId === requestId && state.pendingStreamHash === handoffHash;
    };
    handoffBusy.current = requestId;

    const handoff = async () => {
      try {
        if (embeddedUrl && !(await waitForFirstBytes(embeddedUrl, stillCurrent, pendingStreamFileSize ?? 0))) {
          if (!stillCurrent()) return;
          // Keep the status card up and let the start supervisor move on
          // instead of presenting a black player.
          retryAfter.current = Date.now() + 1_500;
          return;
        }
        if (!stillCurrent()) return;
        if (embeddedUrl) firstByte.current = { key: `${requestId}:${handoffHash}`, at: Date.now() };
        const resumeSeconds = Math.max(0, pendingStreamMedia?.resumeSeconds ?? 0);
        const compatibilitySource = compatibility
          ? {
              streamId: torrent.hash,
              audioLanguage,
              startSeconds: resumeSeconds,
              ...(embeddedUrl
                ? { inputUrl: embeddedUrl }
                : { filename: pendingStreamFileName }),
            }
          : undefined;
        const url = embeddedUrl
          ? compatibility
            ? await startCompatibilityStreamUrl(
                embeddedUrl,
                torrent.hash,
                audioLanguage,
                resumeSeconds
              )
            : embeddedUrl
          : compatibility
            ? await startCompatibilityStream(
                pendingStreamFileName,
                torrent.hash,
                audioLanguage,
                resumeSeconds
              )
            : gatewayUrl(pendingStreamFileName);
        if (!stillCurrent()) return;
        const fallback = mediaDisplayFromRelease(pendingStreamFileName);
        if (!markStreamReady(handoffHash, requestId)) return;
        openDirect({
          ...pendingStreamMedia,
          id: `torrent:${torrent.hash}:${requestId}`,
          url,
          title: pendingStreamMedia?.title?.trim() || fallback.title,
          subtitle: pendingStreamMedia?.subtitle?.trim() || fallback.subtitle,
          posterUrl: pendingStreamMedia?.posterUrl,
          isEpisode: pendingStreamMedia?.isEpisode,
          compatibility: compatibilitySource,
        });
        toast.success("Stream ready", {
          description: compatibility
            ? "Hardware compatibility stream ready."
            : embeddedUrl
              ? "Playing straight from the source. No opening download required."
              : "Playing directly from the temporary cache. No Jellyfin scan.",
        });
        navigate("/stream");
      } catch (reason) {
        if (!stillCurrent()) return;
        const detail = reason instanceof Error ? reason.message : String(reason);
        const key = `${requestId}:${handoffHash}`;
        const failures = handoffFailures.current.key === key ? handoffFailures.current.count + 1 : 1;
        handoffFailures.current = { key, count: failures };
        if (failures < 2) {
          retryAfter.current = Date.now() + 5_000;
          toast.error("Still preparing the player", { description: detail });
          return;
        }
        // Served bytes hold the start supervisor off, so a conversion that
        // keeps failing has to move on here or it retries forever.
        firstByte.current = null;
        if (failoverBusy.current === requestId) return;
        failoverBusy.current = requestId;
        try {
          const next = await failoverPendingStream(requestId);
          if (next) {
            toast.info("Switching to another source", { description: detail });
          } else if (useTorrents.getState().streamRequestId === requestId) {
            await cancelPendingStream(requestId).catch(() => {});
            toast.error("Couldn’t start playback", { description: detail });
          }
        } finally {
          if (failoverBusy.current === requestId) failoverBusy.current = null;
        }
      } finally {
        if (handoffBusy.current === requestId) handoffBusy.current = null;
      }
    };
    void handoff();
  }, [audioLanguage, cancelPendingStream, embeddedUrl, failoverPendingStream, markStreamReady, navigate, openDirect, pendingStreamFileName, pendingStreamFileSize, pendingStreamHash, pendingStreamHeadBytes, pendingStreamMedia, streamRequestId, torrent]);

  if (!pendingStreamHash && !sourceRaceActive && !streamLaunchPhase) return null;

  const streamSize = pendingStreamFileSize || torrent?.size || 0;
  const compatibility = needsCompatibility(pendingStreamFileName);
  const bufferTarget = openingBuffer(streamSize || 3 * 1024 ** 3, compatibility);
  const received = torrent ? Math.min(streamSize || pendingStreamHeadBytes, pendingStreamHeadBytes) : 0;
  const instant = useTorrents.getState().qbt().instantStreaming;
  const waitingForPeers = !!torrent && torrent.dlspeed <= 0 && torrent.progress < 1;
  const stage = startStage({
    hasTorrent: !!torrent,
    fileSelected: !!pendingStreamFileName,
    peers: torrent?.num_seeds ?? 0,
    firstByte: false,
  });
  // The built-in engine serves the opening as soon as it arrives, so its bar
  // follows the stages; qBittorrent's follows the opening buffer.
  const stageProgress = { source: 8, files: 22, peers: 40, opening: 70, player: 95 }[stage];
  const sourceCount = streamStartAttempt + pendingStreamFallbacks.length;
  const attemptNote =
    streamStartAttempt > 1 ? ` · source ${streamStartAttempt} of ${Math.max(streamStartAttempt, sourceCount)}` : "";
  const statusTitle = streamLaunchPhase
    ? `${streamLaunchPhase}${attemptNote}`
    : sourceRaceActive
      ? "Checking the best sources"
      : !instant
        ? waitingForPeers
          ? "Finding a fast peer"
          : compatibility
            ? "Preparing compatibility stream"
            : "Fast-starting your stream"
        : compatibility && stage === "opening"
          ? `Preparing compatible video${attemptNote}`
          : `${STAGE_LABELS[stage]}${attemptNote}`;
  const bufferProgress = !torrent
    ? 3
    : instant
      ? stageProgress
      : Math.min(100, (received / Math.min(bufferTarget, streamSize || bufferTarget)) * 100);

  return (
    <motion.aside
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      aria-label="Stream status"
      className="glass-panel fixed bottom-6 right-6 z-[60] w-[410px] overflow-hidden rounded-3xl"
    >
      <div className="relative p-5">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
        <div className="flex items-start gap-3">
          <Artwork
            src={displayMedia?.posterUrl}
            title={displayTitle}
            variant="compact"
            className="h-14 w-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p role="status" aria-live="polite" className="text-sm font-semibold">
                {statusTitle}
              </p>
              <span className="ak-badge ak-badge--quiet !px-2 !py-0.5">temporary</span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-zinc-300" title={displayTitle}>
              {displayTitle || "Connecting to source…"}
            </p>
            {displaySubtitle && (
              <p className="mt-0.5 truncate text-[11px] text-zinc-400">{displaySubtitle}</p>
            )}
          </div>
          <button
            onClick={() =>
              (sourceRaceActive ? cancelSourceRace() : cancelPendingStream(streamRequestId)).catch(() => {})
            }
            aria-label="Cancel stream"
            title="Cancel and clear temporary cache"
            className="rounded-lg p-1.5 text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            <X size={17} />
          </button>
        </div>

        {sourceRaceActive || (!pendingStreamHash && !!streamLaunchPhase) ? (
          // Unknown duration: CSS indeterminate bar (static under reduced motion).
          <div className="ak-progress-indeterminate mt-5 !h-1.5" role="progressbar" aria-label="Finding a source" />
        ) : (
          <div
            className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label="Opening buffer"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(bufferProgress)}
          >
            <motion.div
              className="h-full rounded-full bg-white"
              animate={{ width: `${Math.max(3, bufferProgress)}%` }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        )}

        <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-400">
          <span>
            {streamLaunchPhase
              ? pendingStreamHash
                ? "Preparing the selected episode"
                : "You can keep browsing while Akflix works"
              : sourceRaceActive
              ? "Testing peer response and language"
              : instant
              ? torrent
                ? torrent.num_seeds
                  ? "Only the start of the video is needed to begin"
                  : `${torrent.num_leechs.toLocaleString()} peers found · connecting`
                : "Loading torrent metadata"
              : torrent
              ? `${formatBytes(Math.min(received, bufferTarget))} / ${formatBytes(
                  Math.min(bufferTarget, streamSize || bufferTarget)
                )} opening buffer`
              : "Loading torrent metadata"}
          </span>
          <span className="tabular-nums">
            {torrent?.dlspeed
              ? `${formatSpeed(torrent.dlspeed)} · ${torrent.num_seeds} peers`
              : torrent
                ? `${torrent.num_seeds} peers`
                : "Connecting…"}
          </span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
          Only the selected video is prioritized. The temporary cache clears when you close playback.
        </p>
      </div>
    </motion.aside>
  );
}
