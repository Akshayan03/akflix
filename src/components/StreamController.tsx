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

function friendlyName(name: string): string {
  return name
    .replace(/\.[a-z\d]{2,5}$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    failoverPendingStream,
    streamUrl,
  } = useTorrents();
  const priorityBusy = useRef(false);
  const handoffBusy = useRef(false);
  const retryAfter = useRef(0);
  const failoverBusy = useRef(false);

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  const torrent = pendingStreamHash
    ? torrents.find((entry) => entry.hash === pendingStreamHash)
    : undefined;
  const embeddedUrl =
    pendingStreamHash && pendingStreamFileIndex !== null
      ? streamUrl(pendingStreamHash, pendingStreamFileIndex)
      : null;

  useEffect(() => {
    if (!pendingStreamHash || pendingStreamFileName || priorityBusy.current) return;
    priorityBusy.current = true;
    prepareStreamFile()
      .catch(() => false)
      .finally(() => {
        priorityBusy.current = false;
      });
  }, [pendingStreamFileName, pendingStreamHash, prepareStreamFile, torrent]);

  // A source that cannot deliver metadata or a single opening byte should
  // never spin forever. Try the next ranked Torrentio release automatically.
  useEffect(() => {
    if (!pendingStreamHash || !pendingStreamFallbacks.length || !pendingStreamStartedAt) return;
    const wait = Math.max(0, pendingStreamStartedAt + 10_000 - Date.now());
    const timer = setTimeout(() => {
      const state = useTorrents.getState();
      const current = state.torrents.find((entry) => entry.hash === state.pendingStreamHash);
      const stalled = !current || (current.dlspeed <= 0 && state.pendingStreamHeadBytes === 0);
      if (!stalled || failoverBusy.current) return;
      failoverBusy.current = true;
      failoverPendingStream()
        .then((next) => {
          if (next) {
            toast.info("Switching to a healthier source", {
              description: `${next.seeders.toLocaleString()} reported peers · trying automatically`,
            });
          }
        })
        .finally(() => {
          failoverBusy.current = false;
        });
    }, wait);
    return () => clearTimeout(timer);
  }, [failoverPendingStream, pendingStreamFallbacks.length, pendingStreamHash, pendingStreamStartedAt]);

  useEffect(() => {
    if (!pendingStreamHash || !torrent || !pendingStreamFileName) return;
    const selectedSize = pendingStreamFileSize || torrent.size;
    const compatibility = needsCompatibility(pendingStreamFileName);
    const bufferReady =
      !!embeddedUrl ||
      torrent.progress >= 1 ||
      pendingStreamHeadBytes >= openingBuffer(selectedSize, compatibility);
    if (!bufferReady || handoffBusy.current || Date.now() < retryAfter.current) return;
    handoffBusy.current = true;

    const handoff = async () => {
      try {
        const url = embeddedUrl
          ? compatibility
            ? await startCompatibilityStreamUrl(embeddedUrl, torrent.hash, audioLanguage)
            : embeddedUrl
          : compatibility
            ? await startCompatibilityStream(pendingStreamFileName, torrent.hash, audioLanguage)
            : gatewayUrl(pendingStreamFileName);
        openDirect({
          ...pendingStreamMedia,
          id: `torrent:${torrent.hash}`,
          url,
          title: pendingStreamMedia?.title ?? friendlyName(pendingStreamFileName),
          subtitle: pendingStreamMedia?.subtitle,
          posterUrl: pendingStreamMedia?.posterUrl,
          isEpisode: pendingStreamMedia?.isEpisode,
        });
        // Publish the player request before marking the torrent active. This
        // prevents the cleanup effect from seeing a transient "active but no
        // session" state and deleting the cache during handoff.
        markStreamReady(torrent.hash);
        toast.success("Stream ready", {
          description: compatibility
            ? "Hardware compatibility stream ready."
            : embeddedUrl
              ? "Playing straight from the source. No opening download required."
              : "Playing directly from the temporary cache. No Jellyfin scan.",
        });
        navigate("/stream");
      } catch (reason) {
        retryAfter.current = Date.now() + 5_000;
        toast.error("Still preparing the player", {
          description: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        handoffBusy.current = false;
      }
    };
    void handoff();
  }, [audioLanguage, embeddedUrl, markStreamReady, navigate, openDirect, pendingStreamFileName, pendingStreamFileSize, pendingStreamHash, pendingStreamHeadBytes, pendingStreamMedia, torrent]);

  if (!pendingStreamHash) return null;

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
            src={pendingStreamMedia?.posterUrl}
            title={pendingStreamMedia?.title ?? torrent?.name ?? "Akflix stream"}
            variant="compact"
            className="h-14 w-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">
                {waitingForPeers
                  ? "Finding a fast peer"
                  : embeddedUrl
                    ? "Opening instantly"
                    : compatibility
                    ? "Preparing compatibility stream"
                    : "Fast-starting your stream"}
              </p>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                temporary
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-zinc-400" title={pendingStreamMedia?.title ?? torrent?.name}>
              {pendingStreamMedia?.title ?? (torrent ? friendlyName(pendingStreamFileName || torrent.name) : "Connecting to source…")}
            </p>
          </div>
          <button
            onClick={() => cancelPendingStream().catch(() => {})}
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
            animate={{ width: `${Math.max(3, bufferProgress)}%` }}
          />
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {embeddedUrl
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
