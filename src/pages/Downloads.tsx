/** Akflix transfer center: temporary streams and retained offline downloads. */

import { useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  Download,
  FolderSync,
  HardDrive,
  Magnet,
  Pause,
  Play,
  PlugZap,
  Radio,
  Trash2,
  Wifi,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useTorrents } from "@/stores/torrentStore";
import { useAuth } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import { useT } from "@/i18n";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import type { QbtTorrent, TorrentAddMode } from "@/types/torrent";

function stateLabel(torrent: QbtTorrent): { label: string; color: string } {
  const state = torrent.state;
  if (torrent.progress >= 1) return { label: "Ready", color: "text-emerald-400" };
  if (state.includes("paused") || state.includes("stopped"))
    return { label: "Paused", color: "text-zinc-400" };
  if (state.includes("stalled")) return { label: "Finding peers", color: "text-amber-400" };
  if (state.includes("DL") || state === "downloading")
    return { label: "Receiving", color: "text-brand-light" };
  if (state.includes("UP") || state === "uploading")
    return { label: "Available offline", color: "text-brand-light" };
  return { label: state, color: "text-zinc-400" };
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
        className={`group rounded-2xl border p-4 transition ${
          isPending || isPlaying
            ? "border-brand/35 bg-brand/[0.06]"
            : "border-white/[0.07] bg-white/[0.035] hover:border-white/15"
        }`}
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
              temp ? "bg-brand/15 text-brand-light" : "bg-white/[0.07] text-stone-300"
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
                className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                  temp
                    ? "bg-brand/10 text-brand-light"
                    : "bg-white/[0.07] text-stone-300"
                }`}
              >
                {temp ? "temporary" : "offline"}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span className={state.color}>{isPlaying ? "Playing now" : state.label}</span>
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

          <div className="flex shrink-0 items-center gap-1 opacity-70 transition group-hover:opacity-100">
            <button
              onClick={() => (paused ? resume(torrent.hash) : pause(torrent.hash))}
              title={paused ? t("downloads.resume") : t("downloads.pause")}
              className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button
              onClick={() => remove(torrent.hash, false)}
              title="Remove job but keep files"
              className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <Trash2 size={15} />
            </button>
            <button
              onClick={() => {
                if (confirm(`Remove ${torrent.name} and its files?`))
                  remove(torrent.hash, true);
              }}
              title="Remove job and files"
              className="rounded-lg p-2 text-red-500/60 transition hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.08]">
          <motion.div
            className={`h-full rounded-full ${
              torrent.progress >= 1
                ? "bg-emerald-500"
                : temp
                  ? "bg-gradient-to-r from-brand-dark to-brand"
                  : "bg-brand-light"
            }`}
            animate={{ width: `${Math.max(1, torrent.progress * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-right text-[10px] tabular-nums text-zinc-600">
          {(torrent.progress * 100).toFixed(1)}%
        </p>
      </motion.article>
    );
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-[radial-gradient(circle_at_48%_-10%,rgba(214,178,94,.11),transparent_34rem)] px-6 pb-20 pt-28 md:px-12 lg:px-16"
    >
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-end gap-4">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-accent">
              Transfer center
            </p>
            <h1 className="text-4xl font-black tracking-[-0.045em]">Streams & downloads</h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-400">
              Stream with a temporary cache or keep a complete copy for offline viewing.
            </p>
          </div>
          {hasJellyfin && (
            <button
              onClick={scan}
              disabled={scanState === "busy"}
              className="ml-auto flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-50"
            >
              {scanState === "done" ? (
                <CheckCircle2 size={15} className="text-emerald-400" />
              ) : (
                <FolderSync size={15} />
              )}
              Refresh Jellyfin
            </button>
          )}
        </header>

        <section className="mb-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Radio size={15} className="text-brand-light" /> Temporary streams
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{temporary.length}</p>
            <p className="mt-1 text-[11px] text-zinc-600">Cleared when playback stops</p>
          </div>
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <HardDrive size={15} className="text-brand-light" /> Offline titles
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{offline.length}</p>
            <p className="mt-1 text-[11px] text-zinc-600">{formatBytes(offlineBytes)} stored</p>
          </div>
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Wifi size={15} className={qbtOnline ? "text-emerald-400" : "text-amber-400"} /> Engine
            </div>
            <p className={`mt-2 text-lg font-semibold ${qbtOnline ? "text-emerald-400" : "text-amber-400"}`}>
              {qbtOnline ? "Connected" : "Offline"}
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              {torrentEngine === "embedded" ? "Built into Akflix" : "External qBittorrent"}
            </p>
          </div>
        </section>

        <section className="glass-panel mb-9 rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <Magnet size={15} className="text-brand-light" /> Add a magnet manually
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={magnet}
              onChange={(event) => setMagnet(event.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none transition placeholder:text-zinc-700 focus:border-brand/60"
            />
            <button
              onClick={() => addManual("stream")}
              disabled={!magnet.trim() || !!adding}
              className="flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-xs font-bold text-black transition hover:bg-zinc-200 disabled:opacity-40"
            >
              <Zap size={15} /> {adding === "stream" ? "Starting…" : "Stream now"}
            </button>
            <button
              onClick={() => addManual("download")}
              disabled={!magnet.trim() || !!adding}
              className="flex items-center justify-center gap-2 rounded-xl bg-zinc-800 px-4 py-3 text-xs font-bold transition hover:bg-zinc-700 disabled:opacity-40"
            >
              <Download size={15} /> {adding === "download" ? "Adding…" : "Keep offline"}
            </button>
          </div>
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </section>

        {!qbtOnline && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-sm text-amber-300">
            <PlugZap size={18} /> The playback engine is unavailable. Restart Akflix or check Settings.
          </div>
        )}

        {torrents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 py-20 text-center">
            <Radio size={28} className="mx-auto mb-3 text-zinc-700" />
            <p className="text-sm font-medium text-zinc-400">Nothing active</p>
            <p className="mt-1 text-xs text-zinc-600">Choose Stream now or Keep offline on any title.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {temporary.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Temporary streaming cache</h2>
                  <span className="text-xs text-zinc-600">auto-clears on stop</span>
                </div>
                <div className="space-y-3">{temporary.map(renderTransfer)}</div>
              </section>
            )}
            {offline.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Offline downloads</h2>
                  <span className="text-xs text-zinc-600">kept until you delete them</span>
                </div>
                <div className="space-y-3">{offline.map(renderTransfer)}</div>
              </section>
            )}
          </div>
        )}

        <p className="mt-10 text-[11px] leading-relaxed text-zinc-600">
          ⚖️ {t("torrent.disclaimer")}
        </p>
      </div>
    </motion.main>
  );
}
