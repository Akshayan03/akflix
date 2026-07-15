/**
 * Global search — queries the Jellyfin library and torrent indexers
 * (Prowlarr) in parallel, rendering both result sets. Torrentio is IMDb-based
 * and is therefore queried from an individual Jellyfin title page instead.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, PlayCircle, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/stores/authStore";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import MediaCard from "@/components/MediaCard";
import DiscoverCard from "@/components/DiscoverCard";
import Spinner from "@/components/Spinner";
import { cinemeta } from "@/api/cinemeta";
import { formatBytes } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import type { TorrentAddMode, TorrentResult } from "@/types/torrent";
import type { StremioMeta } from "@/types/stremio";

export default function Search() {
  const t = useT();
  const client = useAuth((s) => s.client)();
  const { search: torrentSearch, addTorrent, prowlarr } = useTorrents();

  const [query, setQuery] = useState("");
  const [libResults, setLibResults] = useState<BaseItem[]>([]);
  const [discoverResults, setDiscoverResults] = useState<StremioMeta[]>([]);
  const [torResults, setTorResults] = useState<TorrentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [torrentError, setTorrentError] = useState<string | null>(null);
  const [addedGuid, setAddedGuid] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const prowlarrConfigured = prowlarr().configured;

  // Debounced search-as-you-type across both sources.
  useEffect(() => {
    if (query.trim().length < 2) {
      setLibResults([]);
      setDiscoverResults([]);
      setTorResults([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const timer = setTimeout(async () => {
      setLoading(true);
      setTorrentError(null);
      const [lib, discover, tor] = await Promise.allSettled([
        client
          ? client.search(query, 30, ctrl.signal)
          : Promise.resolve({ Items: [], TotalRecordCount: 0 }),
        cinemeta.search(query, ctrl.signal),
        prowlarrConfigured
          ? torrentSearch(query, ctrl.signal)
          : Promise.resolve<TorrentResult[]>([]),
      ]);
      if (ctrl.signal.aborted) return;

      setLibResults(lib.status === "fulfilled" ? lib.value.Items : []);
      setDiscoverResults(discover.status === "fulfilled" ? discover.value : []);
      if (tor.status === "fulfilled") setTorResults(tor.value);
      else setTorrentError(String(tor.reason));
      setLoading(false);
    }, 400);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const add = async (r: TorrentResult, mode: TorrentAddMode) => {
    try {
      await addTorrent(r, mode);
      setAddedGuid(r.guid);
      toast.success(t("torrent.added"), { description: r.title });
    } catch (e) {
      toast.error(t("common.error"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen bg-[radial-gradient(circle_at_50%_-12%,rgba(214,178,94,.11),transparent_34rem)] px-6 pb-16 pt-28 md:px-12 lg:px-16"
    >
      {/* Search input */}
      <div className="mx-auto mb-12 max-w-3xl text-center">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">One search, every screen</p>
        <h1 className="mb-7 text-4xl font-black tracking-[-0.045em]">What are we watching?</h1>
      <div className="glass-panel flex items-center gap-3 rounded-2xl px-5 focus-within:border-brand/50">
        <SearchIcon size={20} className="text-brand-light" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          className="w-full bg-transparent py-4 text-lg outline-none placeholder:text-zinc-600"
        />
      </div>
      </div>

      {loading && <Spinner />}

      {/* Jellyfin library results */}
      {libResults.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 text-lg font-semibold">{t("search.library")}</h2>
          <div className="flex flex-wrap gap-3">
            {libResults.map((item) => (
              <MediaCard key={item.Id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Stremio/Cinemeta discover results — Torrentio resolves sources on detail. */}
      {discoverResults.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 text-lg font-semibold">Discover Movies &amp; Series</h2>
          <div className="flex flex-wrap gap-3">
            {discoverResults.map((item) => (
              <DiscoverCard key={`${item.type}:${item.id}`} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Torrent "Discover" results */}
      {(torResults.length > 0 || torrentError) && (
        <section>
          <h2 className="mb-4 text-lg font-semibold">{t("search.torrents")}</h2>

          {torrentError && (
            <p className="mb-4 whitespace-pre-wrap text-xs text-red-400">{torrentError}</p>
          )}

          <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-surface-raised">
            {torResults.slice(0, 30).map((r) => (
              <div key={r.guid} className="flex items-center gap-4 px-4 py-3 hover:bg-white/5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={r.title}>
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
                  <span className="shrink-0 text-xs text-green-400">{t("torrent.added")}</span>
                ) : (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => add(r, "stream")}
                      className="flex items-center gap-1 rounded bg-white px-2.5 py-1.5 text-xs font-semibold text-black hover:bg-zinc-200"
                    >
                      <PlayCircle size={13} /> {t("torrent.stream")}
                    </button>
                    <button
                      onClick={() => add(r, "download")}
                      className="flex items-center gap-1 rounded bg-zinc-700 px-2.5 py-1.5 text-xs font-semibold hover:bg-zinc-600"
                    >
                      <Download size={13} /> {t("torrent.download")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] text-zinc-600">⚖️ {t("torrent.disclaimer")}</p>
        </section>
      )}

      {!loading &&
        query.length >= 2 &&
        !libResults.length &&
        !discoverResults.length &&
        !torResults.length && (
        <p className="text-center text-zinc-500">{t("search.noResults")}</p>
      )}
    </motion.main>
  );
}
