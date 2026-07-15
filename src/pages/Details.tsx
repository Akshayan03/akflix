/**
 * Title details — backdrop hero, metadata, Play/Resume, My List toggle,
 * season/episode browser for series, and a "Find torrent sources" entry
 * point that opens the TorrentModal pre-filled with the title.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, ListFilter, Play, Plus } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import { formatRuntime, ticksToSeconds } from "@/lib/utils";
import Spinner from "@/components/Spinner";
import TorrentModal from "@/components/TorrentModal";
import type { BaseItem } from "@/types/jellyfin";

export default function Details() {
  const t = useT();
  const navigate = useNavigate();
  const { itemId } = useParams<{ itemId: string }>();
  const client = useAuth((s) => s.client)();

  const [item, setItem] = useState<BaseItem | null>(null);
  const [seasons, setSeasons] = useState<BaseItem[]>([]);
  const [activeSeason, setActiveSeason] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<BaseItem[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [torrentOpen, setTorrentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the item (+ seasons for series).
  useEffect(() => {
    if (!client || !itemId) return;
    let cancelled = false;
    (async () => {
      try {
        const it = await client.item(itemId);
        if (cancelled) return;
        setItem(it);
        setFavorite(it.UserData?.IsFavorite ?? false);
        if (it.Type === "Series") {
          const s = await client.seasons(it.Id);
          if (cancelled) return;
          setSeasons(s.Items);
          if (s.Items[0]) setActiveSeason(s.Items[0].Id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // Load episodes when the selected season changes.
  useEffect(() => {
    if (!client || !item || !activeSeason) return;
    let cancelled = false;
    client
      .episodes(item.Id, activeSeason)
      .then((r) => !cancelled && setEpisodes(r.Items))
      .catch(() => !cancelled && setEpisodes([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeason, item?.Id]);

  if (error)
    return <p className="p-24 text-center text-sm text-red-400">{error}</p>;
  if (!item || !client)
    return <div className="pt-40"><Spinner label={t("common.loading")} /></div>;

  const backdrop = client.imageUrl(item, "Backdrop", 1920);
  const resumePos = ticksToSeconds(item.UserData?.PlaybackPositionTicks);

  const toggleFavorite = async () => {
    setFavorite((f) => !f); // optimistic
    try {
      await client.setFavorite(item.Id, !favorite);
    } catch {
      setFavorite((f) => !f); // revert on failure
    }
  };

  // For series, "Play" targets the first unwatched episode when we have one.
  const playTarget =
    item.Type === "Series"
      ? episodes.find((e) => !e.UserData?.Played)?.Id ?? episodes[0]?.Id ?? item.Id
      : item.Id;

  const torrentQuery = [item.Name, item.ProductionYear].filter(Boolean).join(" ");
  const torrentTarget =
    item.Type === "Series"
      ? episodes.find((e) => !e.UserData?.Played) ?? episodes[0]
      : item;
  // Torrentio expects the parent series IMDb id plus S/E numbers, not an
  // episode-specific IMDb id.
  const imdbOwner = item.Type === "Series" ? item : torrentTarget;
  const imdbId = imdbOwner?.ProviderIds?.Imdb ?? imdbOwner?.ProviderIds?.IMDb;
  const torrentLookup = imdbId
    ? {
        imdbId,
        type: (torrentTarget?.Type === "Episode" ? "series" : "movie") as
          | "movie"
          | "series",
        season: torrentTarget?.ParentIndexNumber,
        episode: torrentTarget?.IndexNumber,
      }
    : undefined;

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen pb-16"
    >
      {/* Hero */}
      <div className="relative h-[60vh] min-h-[380px]">
        {backdrop && (
          <img src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/30 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 to-transparent" />

        <div className="absolute bottom-8 left-6 max-w-2xl md:left-12">
          <h1 className="hero-shadow mb-3 text-4xl font-extrabold md:text-5xl">{item.Name}</h1>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-zinc-300">
            {item.ProductionYear && <span>{item.ProductionYear}</span>}
            {item.OfficialRating && (
              <span className="border border-zinc-500 px-1.5 py-0.5 text-xs">
                {item.OfficialRating}
              </span>
            )}
            {item.RunTimeTicks && <span>{formatRuntime(item.RunTimeTicks)}</span>}
            {item.CommunityRating && (
              <span className="text-green-400">★ {item.CommunityRating.toFixed(1)}</span>
            )}
            {item.Genres?.slice(0, 3).map((g) => (
              <span key={g} className="text-zinc-400">
                {g}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => navigate(`/play/${playTarget}`)}
              className="flex items-center gap-2 rounded bg-white px-6 py-2.5 font-semibold text-black hover:bg-zinc-200"
            >
              <Play size={18} fill="currentColor" />
              {resumePos > 0 ? t("details.resume") : t("details.play")}
            </button>

            <button
              onClick={toggleFavorite}
              className="flex items-center gap-2 rounded bg-zinc-700/80 px-5 py-2.5 font-semibold hover:bg-zinc-600"
            >
              {favorite ? <Check size={18} /> : <Plus size={18} />}
              {favorite ? t("details.inList") : t("details.myList")}
            </button>

            <button
              onClick={() => setTorrentOpen(true)}
              title="Choose stream"
              className="flex items-center gap-2 rounded border border-zinc-600 px-5 py-2.5 text-sm text-zinc-300 hover:border-white hover:text-white"
            >
              <ListFilter size={16} />
              Choose stream
            </button>
          </div>
        </div>
      </div>

      {/* Overview */}
      {item.Overview && (
        <p className="max-w-3xl px-6 pt-8 leading-relaxed text-zinc-300 md:px-12">
          {item.Overview}
        </p>
      )}

      {/* Season / episode browser */}
      {item.Type === "Series" && seasons.length > 0 && (
        <section className="px-6 pt-10 md:px-12">
          <div className="mb-4 flex items-center gap-4">
            <h2 className="text-lg font-semibold">{t("details.seasons")}</h2>
            <select
              value={activeSeason ?? ""}
              onChange={(e) => setActiveSeason(e.target.value)}
              className="rounded bg-surface-raised px-3 py-1.5 text-sm ring-1 ring-zinc-700 outline-none"
            >
              {seasons.map((s) => (
                <option key={s.Id} value={s.Id}>
                  {s.Name}
                </option>
              ))}
            </select>
          </div>

          <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {episodes.map((ep) => {
              const thumb = client.imageUrl(ep, "Primary", 320);
              const pct = ep.UserData?.PlayedPercentage ?? (ep.UserData?.Played ? 100 : 0);
              return (
                <button
                  key={ep.Id}
                  onClick={() => navigate(`/play/${ep.Id}`)}
                  className="flex w-full items-center gap-4 p-3 text-left hover:bg-white/5"
                >
                  <span className="w-6 shrink-0 text-center text-zinc-500">
                    {ep.IndexNumber}
                  </span>
                  <div className="relative w-40 shrink-0 overflow-hidden rounded">
                    {thumb ? (
                      <img src={thumb} alt="" className="aspect-video w-full object-cover" />
                    ) : (
                      <div className="aspect-video w-full bg-surface-raised" />
                    )}
                    {pct > 0 && (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-zinc-700">
                        <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{ep.Name}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{ep.Overview}</p>
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-zinc-500">
                    {formatRuntime(ep.RunTimeTicks)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <TorrentModal
        initialQuery={torrentQuery}
        lookup={torrentLookup}
        media={{
          title: item.Name,
          subtitle:
            torrentTarget?.Type === "Episode"
              ? `S${torrentTarget.ParentIndexNumber ?? 1} E${torrentTarget.IndexNumber ?? 1} · ${torrentTarget.Name}`
              : item.ProductionYear?.toString(),
          posterUrl: client.imageUrl(item, "Primary", 300),
          isEpisode: torrentTarget?.Type === "Episode",
          season:
            torrentTarget?.Type === "Episode" ? torrentTarget.ParentIndexNumber ?? 1 : undefined,
          episode: torrentTarget?.Type === "Episode" ? torrentTarget.IndexNumber ?? 1 : undefined,
        }}
        open={torrentOpen}
        onClose={() => setTorrentOpen(false)}
      />
    </motion.main>
  );
}
