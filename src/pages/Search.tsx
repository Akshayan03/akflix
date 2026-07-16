/**
 * Global search — queries the Jellyfin library and torrent indexers
 * (Prowlarr) in parallel, rendering both result sets. Torrentio is IMDb-based
 * and is therefore queried from an individual Jellyfin title page instead.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, PlayCircle, SearchIcon, X } from "lucide-react";
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
import { isAppleMobile } from "@/lib/platform";

const QUICK_SEARCHES = ["Dune", "The Bear", "Batman", "Severance"];

export default function Search() {
  const t = useT();
  const client = useAuth((s) => s.client)();
  const { search: torrentSearch, addTorrent, prowlarr } = useTorrents();
  const mobileApple = isAppleMobile();

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
      className="min-h-screen bg-[radial-gradient(circle_at_50%_-12%,rgba(214,178,94,.11),transparent_34rem)] px-4 pb-32 pt-28 md:px-12 md:pb-16 lg:px-16"
    >
      {/* Search input */}
      <div className="mx-auto mb-8 max-w-3xl text-center md:mb-12">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">One search, every screen</p>
        <h1 className="mb-5 text-3xl font-black tracking-[-0.045em] md:mb-7 md:text-4xl">What are we watching?</h1>
      <div className="glass-panel flex items-center gap-3 rounded-2xl px-4 focus-within:border-brand/50 md:px-5">
        <SearchIcon size={20} className="text-brand-light" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-base outline-none placeholder:text-zinc-600 md:py-4 md:text-lg"
        />
        {query && (
          <motion.button
            whileTap={{ scale: 0.86 }}
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="rounded-full bg-white/[0.07] p-1.5 text-zinc-400"
          >
            <X size={14} />
          </motion.button>
        )}
      </div>
        {!query && mobileApple && (
          <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1 text-left">
            {QUICK_SEARCHES.map((suggestion) => (
              <motion.button
                key={suggestion}
                whileTap={{ scale: 0.94 }}
                onClick={() => setQuery(suggestion)}
                className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-zinc-300"
              >
                {suggestion}
              </motion.button>
            ))}
          </div>
        )}
      </div>

      {loading && <Spinner />}

      {/* Jellyfin library results */}
      {libResults.length > 0 && (
        <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mb-10 md:mb-12">
          <h2 className="mb-4 text-lg font-black">{t("search.library")}</h2>
          <div className="flex flex-wrap gap-3">
            {libResults.map((item) => (
              <MediaCard key={item.Id} item={item} />
            ))}
          </div>
        </motion.section>
      )}

      {/* Stremio/Cinemeta discover results — Torrentio resolves sources on detail. */}
      {discoverResults.length > 0 && (
        <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mb-10 md:mb-12">
          <h2 className="mb-4 text-lg font-black">Movies and series</h2>
          <div className={mobileApple ? "grid grid-cols-2 gap-3" : "flex flex-wrap gap-3"}>
            {discoverResults.map((item) => (
              <DiscoverCard key={`${item.type}:${item.id}`} item={item} fluid={mobileApple} />
            ))}
          </div>
        </motion.section>
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
