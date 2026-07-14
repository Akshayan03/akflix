/**
 * Downloads — live torrent manager. Polls qBittorrent every 2s while mounted,
 * shows progress/speeds/ETA, supports pause/resume/delete, adding a raw
 * magnet, and a "Scan into Jellyfin" action that makes finished (or
 * sequential, in-flight) downloads playable through the normal player.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  FolderSync,
  Magnet,
  Pause,
  Play,
  PlugZap,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import type { QbtTorrent } from "@/types/torrent";

function stateLabel(t: QbtTorrent): { label: string; color: string } {
  const s = t.state;
  if (t.progress >= 1) return { label: "Completed", color: "text-green-400" };
  if (s.includes("paused") || s.includes("stopped"))
    return { label: "Paused", color: "text-zinc-400" };
  if (s.includes("stalled")) return { label: "Stalled", color: "text-yellow-400" };
  if (s.includes("DL") || s === "downloading")
    return { label: "Downloading", color: "text-brand-light" };
  if (s.includes("UP") || s === "uploading")
    return { label: "Seeding", color: "text-blue-400" };
  return { label: s, color: "text-zinc-400" };
}

export default function Downloads() {
  const t = useT();
  const {
    torrents,
    qbtOnline,
    startPolling,
    stopPolling,
    pause,
    resume,
    remove,
    addMagnet,
    importToJellyfin,
  } = useTorrents();

  const [magnet, setMagnet] = useState("");
  const [scanState, setScanState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    startPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitMagnet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!magnet.trim()) return;
    setError(null);
    try {
      await addMagnet(magnet.trim(), true);
      setMagnet("");
      toast.success(t("torrent.added"));
    } catch (err) {
      toast.error(t("common.error"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scan = async () => {
    setScanState("busy");
    try {
      await importToJellyfin();
      setScanState("done");
      toast.success(t("downloads.import"), { description: t("downloads.importHint") });
      setTimeout(() => setScanState("idle"), 2500);
    } catch (err) {
      toast.error(t("common.error"), {
        description: err instanceof Error ? err.message : String(err),
      });
      setScanState("idle");
    }
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen px-6 pb-16 pt-24 md:px-12"
    >
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-bold">{t("downloads.title")}</h1>

        <button
          onClick={scan}
          disabled={scanState === "busy"}
          title={t("downloads.importHint")}
          className="ml-auto flex items-center gap-2 rounded bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
        >
          {scanState === "done" ? (
            <CheckCircle2 size={16} className="text-green-400" />
          ) : (
            <FolderSync size={16} />
          )}
          {t("downloads.import")}
        </button>
      </div>

      {/* Add magnet manually */}
      <form onSubmit={submitMagnet} className="mb-8 flex gap-2">
        <div className="flex flex-1 items-center gap-2 rounded bg-surface-raised px-3 ring-1 ring-zinc-700 focus-within:ring-brand">
          <Magnet size={16} className="shrink-0 text-zinc-500" />
          <input
            value={magnet}
            onChange={(e) => setMagnet(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…"
            className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-600"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-brand px-5 text-sm font-semibold hover:bg-brand-light"
        >
          +
        </button>
      </form>

      {error && <p className="mb-4 whitespace-pre-wrap text-xs text-red-400">{error}</p>}

      {!qbtOnline && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-yellow-700/50 bg-yellow-900/20 p-4 text-sm text-yellow-300">
          <PlugZap size={18} />
          {t("downloads.offline")}
        </div>
      )}

      {qbtOnline && torrents.length === 0 && (
        <p className="py-16 text-center text-zinc-500">{t("downloads.empty")}</p>
      )}

      <div className="space-y-3">
        {torrents.map((tor) => {
          const st = stateLabel(tor);
          const paused = st.label === "Paused";
          return (
            <div
              key={tor.hash}
              className="rounded-lg border border-zinc-800 bg-surface-raised p-4"
            >
              <div className="mb-2 flex items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-sm font-medium" title={tor.name}>
                  {tor.name}
                </p>
                {tor.seq_dl && (
                  <span
                    title="Sequential download — stream-ready"
                    className="flex items-center gap-1 rounded bg-brand/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-light"
                  >
                    <Zap size={10} /> stream
                  </span>
                )}
                <span className={`shrink-0 text-xs font-medium ${st.color}`}>{st.label}</span>
              </div>

              {/* Progress bar */}
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full transition-all ${
                    tor.progress >= 1 ? "bg-green-500" : "bg-brand"
                  }`}
                  style={{ width: `${Math.round(tor.progress * 100)}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span>{(tor.progress * 100).toFixed(1)}%</span>
                <span>{formatBytes(tor.size)}</span>
                {tor.progress < 1 && (
                  <>
                    <span>↓ {formatSpeed(tor.dlspeed)}</span>
                    <span>ETA {formatEta(tor.eta)}</span>
                    <span>
                      {tor.num_seeds} {t("torrent.seeders")}
                    </span>
                  </>
                )}

                <span className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => (paused ? resume(tor.hash) : pause(tor.hash))}
                    title={paused ? t("downloads.resume") : t("downloads.pause")}
                    className="rounded p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
                  >
                    {paused ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button
                    onClick={() => remove(tor.hash, false)}
                    title={t("downloads.delete")}
                    className="rounded p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`${t("downloads.deleteFiles")}: ${tor.name}?`))
                        remove(tor.hash, true);
                    }}
                    title={t("downloads.deleteFiles")}
                    className="rounded p-1.5 text-red-500/70 hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-10 text-[11px] leading-relaxed text-zinc-600">
        ⚖️ {t("torrent.disclaimer")}
      </p>
    </motion.main>
  );
}
