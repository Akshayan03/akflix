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
  } = useTorrents();
  const priorityBusy = useRef<number | null>(null);
  const handoffBusy = useRef<number | null>(null);
  const retryAfter = useRef(0);
  const failoverBusy = useRef<number | null>(null);

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
      .catch(() => false)
      .finally(() => {
        if (priorityBusy.current === requestId) priorityBusy.current = null;
      });
  }, [pendingStreamFileName, pendingStreamHash, prepareStreamFile, streamRequestId, torrent]);

  // A source that cannot deliver metadata or a single opening byte should
  // never spin forever. Try the next ranked Torrentio release automatically.
  useEffect(() => {
    if (!pendingStreamHash || !pendingStreamFallbacks.length || !pendingStreamStartedAt) return;
    const requestId = streamRequestId;
    const wait = Math.max(0, pendingStreamStartedAt + 10_000 - Date.now());
    const timer = setTimeout(() => {
      const state = useTorrents.getState();
      if (state.streamRequestId !== requestId) return;
      const current = state.torrents.find((entry) => entry.hash === state.pendingStreamHash);
      const stalled = !current || (current.dlspeed <= 0 && state.pendingStreamHeadBytes === 0);
      if (!stalled || failoverBusy.current === requestId) return;
      failoverBusy.current = requestId;
      failoverPendingStream(requestId)
        .then((next) => {
          if (next) {
            toast.info("Switching to a healthier source", {
              description: `${next.seeders.toLocaleString()} reported peers · trying automatically`,
            });
          }
        })
        .finally(() => {
          if (failoverBusy.current === requestId) failoverBusy.current = null;
        });
    }, wait);
    return () => clearTimeout(timer);
  }, [failoverPendingStream, pendingStreamFallbacks.length, pendingStreamHash, pendingStreamStartedAt, streamRequestId]);

  // A single unhealthy source used to leave the progress card spinning
  // forever because there was no fallback to trigger the race logic. End the
  // attempt cleanly and return control to the user instead.
  useEffect(() => {
    if (!pendingStreamHash || pendingStreamFallbacks.length || !pendingStreamStartedAt) return;
    const requestId = streamRequestId;
    const wait = Math.max(0, pendingStreamStartedAt + 30_000 - Date.now());
    const timer = setTimeout(() => {
      const state = useTorrents.getState();
      if (state.streamRequestId !== requestId || state.pendingStreamHash !== pendingStreamHash) return;
      void cancelPendingStream(requestId).finally(() => {
        toast.error("This source could not start", {
          description: "Choose another stream or try again. Akflix cleared the unfinished temporary cache.",
        });
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [cancelPendingStream, pendingStreamFallbacks.length, pendingStreamHash, pendingStreamStartedAt, streamRequestId]);

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
        retryAfter.current = Date.now() + 5_000;
        toast.error("Still preparing the player", {
          description: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        if (handoffBusy.current === requestId) handoffBusy.current = null;
      }
    };
    void handoff();
  }, [audioLanguage, embeddedUrl, markStreamReady, navigate, openDirect, pendingStreamFileName, pendingStreamFileSize, pendingStreamHash, pendingStreamHeadBytes, pendingStreamMedia, streamRequestId, torrent]);

  if (!pendingStreamHash && !sourceRaceActive && !streamLaunchPhase) return null;

  const streamSize = pendingStreamFileSize || torrent?.size || 0;
  const compatibility = needsCompatibility(pendingStreamFileName);
  const bufferTarget = openingBuffer(streamSize || 3 * 1024 ** 3, compatibility);
  const received = torrent ? Math.min(streamSize || pendingStreamHeadBytes, pendingStreamHeadBytes) : 0;
  const bufferProgress = torrent
    ? Math.min(100, (received / Math.min(bufferTarget, streamSize || bufferTarget)) * 100)
    : 3;
  const waitingForPeers = !!torrent && torrent.dlspeed <= 0 && torrent.progress < 1;

  return (
    <motion.aside
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="glass-panel fixed bottom-6 right-6 z-[60] w-[410px] overflow-hidden rounded-3xl shadow-[0_24px_80px_rgba(0,0,0,.65)]"
    >
      <div className="relative p-5">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand to-transparent" />
        <div className="flex items-start gap-3">
          <Artwork
            src={displayMedia?.posterUrl}
            title={displayTitle}
            variant="compact"
            className="h-14 w-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">
                {streamLaunchPhase || (sourceRaceActive
                  ? "Checking the best sources"
                  : waitingForPeers
                  ? "Finding a fast peer"
                  : embeddedUrl
                    ? "Opening instantly"
                    : compatibility
                    ? "Preparing compatibility stream"
                    : "Fast-starting your stream")}
              </p>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                temporary
              </span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-zinc-300" title={displayTitle}>
              {displayTitle || "Connecting to source…"}
            </p>
            {displaySubtitle && (
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">{displaySubtitle}</p>
            )}
          </div>
          <button
            onClick={() =>
              (sourceRaceActive ? cancelSourceRace() : cancelPendingStream(streamRequestId)).catch(() => {})
            }
            aria-label="Cancel stream"
            title="Cancel and clear temporary cache"
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-white"
          >
            <X size={17} />
          </button>
        </div>

        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-brand-dark via-brand to-accent"
            animate={
              sourceRaceActive || (!pendingStreamHash && !!streamLaunchPhase)
                ? { width: ["8%", "55%", "22%"], x: ["0%", "70%", "0%"] }
                : { width: `${Math.max(3, bufferProgress)}%`, x: "0%" }
            }
            transition={
              sourceRaceActive || (!pendingStreamHash && !!streamLaunchPhase)
                ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
                : undefined
            }
          />
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {streamLaunchPhase
              ? pendingStreamHash
                ? "Preparing the selected episode"
                : "You can keep browsing while Akflix works"
              : sourceRaceActive
              ? "Testing peer response and language"
              : embeddedUrl
              ? "Direct source ready"
              : torrent
              ? `${formatBytes(Math.min(received, bufferTarget))} / ${formatBytes(
                  Math.min(bufferTarget, streamSize || bufferTarget)
                )} opening buffer`
              : "Loading torrent metadata"}
          </span>
          <span className="tabular-nums">
            {torrent?.dlspeed ? `${formatSpeed(torrent.dlspeed)} · ${torrent.num_seeds} peers` : "Wi-Fi ready"}
          </span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Only the selected video is prioritized. The temporary cache clears when you close playback.
        </p>
      </div>
    </motion.aside>
  );
}
