/**
 * Global search — queries the Jellyfin library and torrent indexers
 * (Prowlarr) in parallel, rendering both result sets. Torrentio is IMDb-based
 * and is therefore queried from an individual Jellyfin title page instead.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, Download, LoaderCircle, PlayCircle, Scale, SearchIcon, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/stores/authStore";
import { useTorrents } from "@/stores/torrentStore";
import { useT } from "@/i18n";
import MediaCard from "@/components/MediaCard";
import DiscoverCard from "@/components/DiscoverCard";
import { cinemeta } from "@/api/cinemeta";
import { formatBytes } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import type { TorrentAddMode, TorrentResult } from "@/types/torrent";
import type { StremioMeta } from "@/types/stremio";
import { isAppleMobile } from "@/lib/platform";
import { withTimeout } from "@/lib/withTimeout";

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
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mediaFilter, setMediaFilter] = useState<"all" | "movie" | "series">("all");
  const [addedGuid, setAddedGuid] = useState<string | null>(null);

  const prowlarrConfigured = prowlarr().configured;
  const visibleDiscover = discoverResults.filter((item) => mediaFilter === "all" || item.type === mediaFilter);

  // Debounced search-as-you-type across both sources.
  useEffect(() => {
    const term = query.trim();
    setLibResults([]);
    setDiscoverResults([]);
    setTorResults([]);
    setTorrentError(null);
    setCatalogError(null);
    setLibraryError(null);
    if (term.length < 2) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);

    const timer = setTimeout(async () => {
      // Publish each provider immediately. A slow optional server must not
      // hold movie and series results hostage, or overwrite a newer query.
      const run = async <T,>(
        request: (signal: AbortSignal) => Promise<T>,
        receive: (value: T) => void,
        fail: (message: string) => void
      ) => {
        try {
          const value = await withTimeout(request, 15000, ctrl.signal);
          if (!ctrl.signal.aborted) receive(value);
        } catch {
          if (!ctrl.signal.aborted) fail("Unable to reach this service. Check your connection and try again.");
        }
      };
      await Promise.all([
        run((signal) => cinemeta.search(term, signal), setDiscoverResults, setCatalogError),
        client ? run((signal) => client.search(term, 30, signal),
          (value) => setLibResults(value.Items), setLibraryError) : Promise.resolve(),
        prowlarrConfigured ? run((signal) => torrentSearch(term, signal),
          setTorResults, setTorrentError) : Promise.resolve(),
      ]);
      if (!ctrl.signal.aborted) setLoading(false);
    }, 300);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, retry, prowlarrConfigured, mobileApple]);

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
      transition={{ duration: 0.2 }}
      className={`min-h-screen bg-[radial-gradient(circle_at_50%_-12%,rgba(255,255,255,.06),transparent_34rem)] ${
        mobileApple ? "px-4 pb-32 pt-28" : "ak-gutter pb-16 pt-[calc(var(--ak-nav-h)+44px)]"
      }`}
    >
      {/* Search input */}
      <div className="mx-auto mb-8 max-w-3xl text-center md:mb-10">
        <h1 className={mobileApple ? "mb-5 font-display text-4xl tracking-[-0.03em]" : "ak-page-title mb-6"}>What are we watching?</h1>
      <form role="search" onSubmit={(event) => {
        event.preventDefault();
        (event.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
      }} className="glass-panel flex items-center gap-3 rounded-full px-5 transition-colors duration-150 focus-within:border-white/60 hover:border-white/30 md:px-6">
        {loading ? <LoaderCircle size={20} className="animate-spin text-white" aria-label="Searching" /> : <SearchIcon size={20} className="text-white" aria-hidden="true" />}
        <input
          autoFocus={!mobileApple}
          type="search"
          aria-label={t("search.placeholder")}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          className="search-input min-w-0 flex-1 bg-transparent py-3.5 text-base outline-none placeholder:text-zinc-500 md:py-[15px] md:text-[17px]"
        />
        {query && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.86 }}
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="ak-icon-button -mr-2"
          >
            <X size={14} />
          </motion.button>
        )}
      </form>
        {!query && (
          <div className={`no-scrollbar mt-4 flex items-center gap-2 overflow-x-auto pb-1 text-left ${mobileApple ? "" : "justify-center"}`}>
            <span className="shrink-0 pr-1 text-xs text-zinc-500">Try</span>
            {QUICK_SEARCHES.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setQuery(suggestion)}
                className="ak-chip shrink-0"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Jellyfin library results */}
      {(catalogError || libraryError) && (
        <div role="alert" className={`ak-notice mx-auto mb-6 max-w-3xl ${catalogError ? "ak-notice--error" : "ak-notice--warning"}`}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div className="min-w-0">
            {catalogError && <p><strong>Movie and series search is unavailable.</strong> {catalogError}</p>}
            {libraryError && <p>Your personal library is unavailable. Catalog search still works independently.</p>}
            <button onClick={() => setRetry((value) => value + 1)} className="mt-1 min-h-11 font-bold underline underline-offset-4">Try again</button>
          </div>
        </div>
      )}
      {libResults.length > 0 && (
        <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="mb-10 md:mb-12">
          <h2 className="ak-section-title mb-4">{t("search.library")}</h2>
          <div className="flex flex-wrap gap-3">
            {libResults.map((item) => (
              <MediaCard key={item.Id} item={item} />
            ))}
          </div>
        </motion.section>
      )}

      {/* Stremio/Cinemeta discover results — Torrentio resolves sources on detail. */}
      {discoverResults.length > 0 && (
        <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="mb-10 md:mb-12">
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <h2 className="ak-section-title">Movies and series</h2>
          <div role="group" aria-label="Filter catalog results" className="flex gap-2">
            {(["all", "movie", "series"] as const).map((type) => (
              <button key={type} type="button" onClick={() => setMediaFilter(type)} aria-pressed={mediaFilter === type}
                className={mobileApple ? `min-h-11 rounded-full border px-4 text-xs font-semibold transition-colors ${mediaFilter === type ? "border-white bg-white text-black" : "border-white/15 text-zinc-300 hover:border-white/40 hover:text-white"}` : "ak-chip"}>
                {type === "all" ? "All" : type === "movie" ? "Movies" : "Shows"} ({discoverResults.filter((item) => type === "all" || item.type === type).length})
              </button>
            ))}
          </div>
          </div>
          {!visibleDiscover.length && <p className="py-6 text-sm text-zinc-500">No {mediaFilter === "series" ? "shows" : "movies"} match this search. Try All or another title.</p>}
          <div className={mobileApple ? "grid grid-cols-2 gap-3" : "ak-poster-grid"}>
            {visibleDiscover.map((item) => (
              <DiscoverCard key={`${item.type}:${item.id}`} item={item} fluid caption />
            ))}
          </div>
        </motion.section>
      )}

      {loading && query.trim().length >= 2 && !discoverResults.length && !libResults.length && (
        <div role="status" aria-label="Searching" className={mobileApple ? "grid grid-cols-2 gap-3" : "ak-poster-grid mt-[52px]"}>
          {Array.from({ length: mobileApple ? 4 : 12 }).map((_, index) => (
            <div key={index}>
              <div className="skeleton aspect-[2/3] w-full" />
              {!mobileApple && (
                <>
                  <div className="skeleton mt-2.5 h-3 w-3/4 !rounded-md" />
                  <div className="skeleton mt-1.5 h-3 w-1/3 !rounded-md" />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Torrent "Discover" results */}
      {(torResults.length > 0 || torrentError) && (
        <section>
          <h2 className="ak-section-title mb-4">{t("search.torrents")}</h2>

          {torrentError && (
            <p role="alert" className="ak-notice ak-notice--error mb-4 whitespace-pre-wrap text-xs">
              <AlertTriangle size={15} aria-hidden="true" /> <span className="min-w-0 break-words">{torrentError}</span>
            </p>
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
                    <span className={r.seeders > 0 ? "font-semibold text-white" : "font-semibold text-zinc-400"}>
                      {r.seeders} {t("torrent.seeders")}
                    </span>
                  </p>
                </div>
                {addedGuid === r.guid ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-white"><Check size={13} aria-hidden="true" /> {t("torrent.added")}</span>
                ) : (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => add(r, "stream")}
                      className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 text-xs font-semibold text-black hover:bg-zinc-200"
                    >
                      <PlayCircle size={13} /> {t("torrent.stream")}
                    </button>
                    <button
                      onClick={() => add(r, "download")}
                      className="flex items-center gap-1 rounded-full border border-white/25 px-2.5 py-1.5 text-xs font-semibold hover:bg-white/10"
                    >
                      <Download size={13} /> {t("torrent.download")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500"><Scale size={12} aria-hidden="true" /> {t("torrent.disclaimer")}</p>
        </section>
      )}

      {!loading &&
        query.trim().length >= 2 &&
        !catalogError && !libraryError && !torrentError &&
        !libResults.length &&
        !discoverResults.length &&
        !torResults.length && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mt-14 max-w-sm text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/15 text-zinc-300"><SearchIcon size={20} aria-hidden="true" /></span>
          <p className="mt-4 font-semibold text-zinc-200">{t("search.noResults")}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">Try a shorter title, another spelling, or the release year.</p>
        </motion.div>
      )}
    </motion.main>
  );
}
