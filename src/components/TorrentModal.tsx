/**
 * TorrentModal — search torrent indexers for a title and act on results:
 *   • Download  → adds to qBittorrent normally
 *   • Stream    → adds with sequential-download so playback can start early
 *   • Copy magnet
 *
 * ⚖️ A persistent legal disclaimer is shown in the footer. Only use torrent
 * features for content you are legally allowed to obtain.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Download, PlayCircle, Magnet, ArrowUpDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/utils";
import Spinner from "@/components/Spinner";
import type { TorrentResult } from "@/types/torrent";

interface Props {
  /** Pre-filled search query, usually "<Title> <Year>". */
  initialQuery: string;
  open: boolean;
  onClose: () => void;
}

export default function TorrentModal({ initialQuery, open, onClose }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const { search, addTorrent } = useTorrents();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedGuid, setAddedGuid] = useState<string | null>(null);
  const [sortBySize, setSortBySize] = useState(false);

  const runSearch = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResults(await search(q));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Search automatically when the modal opens.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setResults([]);
      setAddedGuid(null);
      runSearch(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery]);

  const act = async (r: TorrentResult, streamMode: boolean) => {
    try {
      await addTorrent(r, streamMode);
      setAddedGuid(r.guid);
      toast.success(t("torrent.added"), { description: r.title });
      if (streamMode) setTimeout(() => navigate("/downloads"), 600);
    } catch (e) {
      toast.error(t("common.error"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const copyMagnet = (r: TorrentResult) => {
    if (r.magnetUrl) {
      navigator.clipboard.writeText(r.magnetUrl);
      toast.success(t("torrent.copyMagnet") + " ✓");
    }
  };

  const sorted = sortBySize
    ? [...results].sort((a, b) => b.size - a.size)
    : results; // already seeder-sorted by the API client

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-zinc-800 bg-surface-raised shadow-2xl"
          >
            {/* Header + search box */}
            <div className="flex items-center gap-3 border-b border-zinc-800 p-4">
              <form
                className="flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  runSearch(query);
                }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("torrent.findSources")}
                  className="w-full rounded bg-black/40 px-4 py-2 text-sm outline-none ring-1 ring-zinc-700 focus:ring-brand"
                />
              </form>
              <button
                onClick={() => setSortBySize((s) => !s)}
                title="Toggle sort: seeders / size"
                className="flex items-center gap-1 rounded px-2 py-2 text-xs text-zinc-400 hover:text-white"
              >
                <ArrowUpDown size={14} />
                {sortBySize ? "size" : t("torrent.seeders")}
              </button>
              <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-white">
                <X size={22} />
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {loading && <Spinner label={t("common.loading")} />}

              {error && (
                <p className="whitespace-pre-wrap p-6 text-sm text-red-400">{error}</p>
              )}

              {!loading && !error && !sorted.length && (
                <p className="p-6 text-sm text-zinc-500">{t("search.noResults")}</p>
              )}

              {sorted.map((r) => (
                <div
                  key={r.guid}
                  className="flex items-center gap-4 border-b border-zinc-800/60 px-4 py-3 hover:bg-white/5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={r.title}>
                      {r.title}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {r.indexer} · {formatBytes(r.size)} ·{" "}
                      <span className={r.seeders > 0 ? "text-green-400" : "text-red-400"}>
                        {r.seeders} {t("torrent.seeders")}
                      </span>
                    </p>
                  </div>

                  {addedGuid === r.guid ? (
                    <span className="text-xs font-medium text-green-400">
                      {t("torrent.added")}
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => act(r, true)}
                        title={t("torrent.stream")}
                        className="flex items-center gap-1.5 rounded bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-zinc-200"
                      >
                        <PlayCircle size={14} />
                        {t("torrent.stream")}
                      </button>
                      <button
                        onClick={() => act(r, false)}
                        title={t("torrent.download")}
                        className="flex items-center gap-1.5 rounded bg-zinc-700 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-600"
                      >
                        <Download size={14} />
                        {t("torrent.download")}
                      </button>
                      {r.magnetUrl && (
                        <button
                          onClick={() => copyMagnet(r)}
                          title={t("torrent.copyMagnet")}
                          className="rounded p-1.5 text-zinc-400 hover:text-white"
                        >
                          <Magnet size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Legal footer */}
            <p className="border-t border-zinc-800 bg-black/30 px-4 py-2.5 text-[11px] leading-snug text-zinc-500">
              ⚖️ {t("torrent.disclaimer")}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
