/** Akflix transfer center: temporary streams and retained offline downloads. */

import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  FolderSync,
  HardDrive,
  ListX,
  Magnet,
  Pause,
  Play,
  PlugZap,
  Radio,
  Scale,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useTorrents } from "@/stores/torrentStore";
import { useAuth } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import { useT } from "@/i18n";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import type { QbtTorrent, TorrentAddMode } from "@/types/torrent";

type TransferTone = "done" | "active" | "waiting" | "idle";

function stateLabel(torrent: QbtTorrent): { label: string; tone: TransferTone } {
  const state = torrent.state;
  if (torrent.progress >= 1) return { label: "Ready", tone: "done" };
  if (state.includes("paused") || state.includes("stopped"))
    return { label: "Paused", tone: "idle" };
  if (state.includes("stalled")) return { label: "Finding peers", tone: "waiting" };
  if (state.includes("DL") || state === "downloading")
    return { label: "Receiving", tone: "active" };
  if (state.includes("UP") || state === "uploading")
    return { label: "Available offline", tone: "done" };
  return { label: state, tone: "idle" };
}

/** Shape, not hue, tells the states apart in the monochrome theme. */
function ToneIcon({ tone }: { tone: TransferTone }) {
  if (tone === "done") return <CheckCircle2 size={12} aria-hidden="true" />;
  if (tone === "waiting") return <CircleDashed size={12} className="animate-spin [animation-duration:3s]" aria-hidden="true" />;
  if (tone === "idle") return <Pause size={12} aria-hidden="true" />;
  return (
    <span className="relative flex h-2 w-2" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
    </span>
  );
}

const isTemporary = (torrent: QbtTorrent) => torrent.category === "akflix-stream";

export default function Downloads() {
  const t = useT();
  const hasJellyfin = !!useAuth((state) => state.client)();
  const torrentEngine = useSettings((state) => state.torrentEngine);
  const {
    torrents,
    qbtOnline,
    pause,
    resume,
    remove,
    addMagnet,
    importToJellyfin,
    pendingStreamHash,
    activeStreamHash,
  } = useTorrents();

  const [magnet, setMagnet] = useState("");
  const [adding, setAdding] = useState<TorrentAddMode | null>(null);
  const [scanState, setScanState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const temporary = torrents.filter(isTemporary);
  const offline = torrents.filter((torrent) => !isTemporary(torrent));
  const offlineBytes = offline.reduce((sum, torrent) => sum + torrent.size * torrent.progress, 0);

  const addManual = async (mode: TorrentAddMode) => {
    if (!magnet.trim() || adding) return;
    setAdding(mode);
    setError(null);
    try {
      await addMagnet(magnet.trim(), mode);
      setMagnet("");
      toast.success(mode === "stream" ? "Preparing stream" : "Offline download added", {
        description:
          mode === "stream"
            ? "Akflix is opening the selected file directly."
            : "The full file will be kept in your Downloads library.",
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(t("common.error"), { description: message });
    } finally {
      setAdding(null);
    }
  };

  const scan = async () => {
    setScanState("busy");
    try {
      await importToJellyfin();
      setScanState("done");
      toast.success("Library refreshed");
      setTimeout(() => setScanState("idle"), 2500);
    } catch (reason) {
      toast.error(t("common.error"), {
        description: reason instanceof Error ? reason.message : String(reason),
      });
      setScanState("idle");
    }
  };

  const renderTransfer = (torrent: QbtTorrent) => {
    const state = stateLabel(torrent);
    const paused = state.label === "Paused";
    const temp = isTemporary(torrent);
    const isPending = pendingStreamHash === torrent.hash;
    const isPlaying = activeStreamHash === torrent.hash;

    return (
      <motion.article
        layout
        key={torrent.hash}
        className={`group rounded-2xl border p-4 transition-colors ${
          isPending || isPlaying
            ? "border-white/45 bg-white/[0.06]"
            : "border-white/[0.08] bg-white/[0.03] hover:border-white/20"
        }`}
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
              temp ? "bg-white text-black" : "bg-white/[0.08] text-zinc-200"
            }`}
          >
            {temp ? <Radio size={20} /> : <HardDrive size={20} />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold" title={torrent.name}>
                {torrent.name}
              </p>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                  temp
                    ? "border-white/40 text-white"
                    : "border-white/15 text-zinc-300"
                }`}
              >
                {temp ? "temporary" : "offline"}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
              <span className={`flex items-center gap-1.5 font-semibold ${state.tone === "idle" ? "text-zinc-300" : "text-white"}`}>
                <ToneIcon tone={isPlaying ? "active" : state.tone} />
                {isPlaying ? "Playing now" : state.label}
              </span>
              <span>{formatBytes(torrent.size)}</span>
              {torrent.progress < 1 && (
                <>
                  <span>{formatSpeed(torrent.dlspeed)}</span>
                  <span>{torrent.num_seeds} peers</span>
                  <span>ETA {formatEta(torrent.eta)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 opacity-80 transition group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              onClick={() => (paused ? resume(torrent.hash) : pause(torrent.hash))}
              title={paused ? t("downloads.resume") : t("downloads.pause")}
              aria-label={`${paused ? t("downloads.resume") : t("downloads.pause")} ${torrent.name}`}
              className="ak-icon-button !h-9 !w-9"
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button
              onClick={() => remove(torrent.hash, false)}
              title="Remove from list, keep files"
              aria-label={`Remove ${torrent.name} from the list and keep its files`}
              className="ak-icon-button !h-9 !w-9"
            >
              <ListX size={15} />
            </button>
            <button
              onClick={() => {
                if (confirm(`Remove ${torrent.name} and its files?`))
                  remove(torrent.hash, true);
              }}
              title="Delete files"
              aria-label={`Delete ${torrent.name} and its files`}
              className="ak-icon-button !h-9 !w-9 hover:!bg-white hover:!text-black"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        <div
          className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.1]"
          role="progressbar"
          aria-label={`${torrent.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(torrent.progress * 100)}
        >
          <motion.div
            className={`h-full rounded-full ${torrent.progress >= 1 || !temp ? "bg-white" : "bg-white/80"}`}
            animate={{ width: `${Math.max(1, torrent.progress * 100)}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <p className="mt-2 text-right text-[10px] tabular-nums text-zinc-400">
          {(torrent.progress * 100).toFixed(1)}%
        </p>
      </motion.article>
    );
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="ak-gutter min-h-screen bg-[radial-gradient(circle_at_30%_-10%,rgba(255,255,255,.05),transparent_34rem)] pb-20 pt-[calc(var(--ak-nav-h)+44px)]"
    >
      <div className="max-w-[1120px]">
        <header className="mb-8 flex flex-wrap items-end gap-4">
          <div>
            <p className="ak-eyebrow mb-3">Transfer center</p>
            <h1 className="ak-page-title">Streams &amp; downloads</h1>
            <p className="mt-3 max-w-2xl text-sm text-zinc-400">
              Stream with a temporary cache or keep a complete copy for offline viewing.
            </p>
          </div>
          {hasJellyfin && (
            <button
              onClick={scan}
              disabled={scanState === "busy"}
              className="desktop-control desktop-secondary ml-auto"
            >
              {scanState === "done" ? (
                <CheckCircle2 size={15} />
              ) : (
                <FolderSync size={15} />
              )}
              Refresh Jellyfin
            </button>
          )}
        </header>

        <section className="mb-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <Radio size={15} aria-hidden="true" /> Temporary streams
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{temporary.length}</p>
            <p className="mt-1 text-[11px] text-zinc-500">Cleared when playback stops</p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <HardDrive size={15} aria-hidden="true" /> Offline titles
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{offline.length}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{formatBytes(offlineBytes)} stored</p>
          </div>
          <div className={`rounded-2xl border p-4 ${qbtOnline ? "border-white/[0.08] bg-white/[0.03]" : "border-dashed border-white/40"}`}>
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              {qbtOnline ? <Wifi size={15} aria-hidden="true" /> : <WifiOff size={15} aria-hidden="true" />} Engine
            </div>
            <p className="mt-2 text-lg font-semibold text-white">
              {qbtOnline ? "Connected" : "Offline"}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {torrentEngine === "embedded" ? "Built into Akflix" : "External qBittorrent"}
            </p>
          </div>
        </section>

        <section className="glass-panel mb-9 rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <Magnet size={15} aria-hidden="true" /> Add a magnet manually
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={magnet}
              onChange={(event) => setMagnet(event.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              aria-label="Magnet link"
              className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/40 px-4 py-2.5 text-sm outline-none transition-colors duration-150 placeholder:text-zinc-500 hover:border-white/30 focus:border-white/70"
            />
            <button
              onClick={() => addManual("stream")}
              disabled={!magnet.trim() || !!adding}
              className="desktop-control desktop-primary"
            >
              <Zap size={15} /> {adding === "stream" ? "Starting…" : "Stream now"}
            </button>
            <button
              onClick={() => addManual("download")}
              disabled={!magnet.trim() || !!adding}
              className="desktop-control desktop-secondary"
            >
              <Download size={15} /> {adding === "download" ? "Adding…" : "Keep offline"}
            </button>
          </div>
          {error && (
            <p role="alert" className="ak-notice ak-notice--error mt-3 text-xs">
              <AlertTriangle size={15} aria-hidden="true" /> <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
        </section>

        {!qbtOnline && (
          <div role="status" className="ak-notice ak-notice--warning mb-6 items-center">
            <PlugZap size={18} aria-hidden="true" /> The playback engine is unavailable. Restart Akflix or check Settings.
          </div>
        )}

        {torrents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 py-20 text-center">
            <Radio size={28} className="mx-auto mb-3 text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-medium text-zinc-300">Nothing active</p>
            <p className="mt-1 text-xs text-zinc-500">Choose Save in a title’s source list to keep a copy offline.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {temporary.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Temporary streaming cache</h2>
                  <span className="text-xs text-zinc-500">auto-clears on stop</span>
                </div>
                <div className="space-y-3">{temporary.map(renderTransfer)}</div>
              </section>
            )}
            {offline.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Offline downloads</h2>
                  <span className="text-xs text-zinc-500">kept until you delete them</span>
                </div>
                <div className="space-y-3">{offline.map(renderTransfer)}</div>
              </section>
            )}
          </div>
        )}

        <p className="mt-10 flex items-center gap-1.5 text-[11px] leading-relaxed text-zinc-500">
          <Scale size={12} aria-hidden="true" /> {t("torrent.disclaimer")}
        </p>
      </div>
    </motion.main>
  );
}
